import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { pool, withTransaction } from '../db/pool.js';
import { upsertMedia } from '../db/repositories/media.repository.js';
import { runDownloadAsset } from './download-asset.job.js';

const base = {
  media_type: 'VIDEO', timestamp: '2026-08-14T18:44:40+0000', permalink: 'https://x/v',
};

const fakeStorage = () => ({
  put: vi.fn(async () => ({ bytes: 42 })),
  getReadUrl: vi.fn(async (k: string) => `/assets/${k}`),
});

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'dl-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'dl-test-%'`);
  await pool.end();
});

describe('runDownloadAsset', () => {
  it('marks an item with no media_url as unavailable, not failed', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, { ...base, id: 'dl-test-nourl' } as any));
    const storage = fakeStorage();
    const result = await runDownloadAsset({ storage } as any, { mediaId: id });

    expect(result).toBe('unavailable');
    expect(storage.put).not.toHaveBeenCalled();
    const { rows } = await pool.query('SELECT asset_status FROM media WHERE id=$1', [id]);
    expect(rows[0].asset_status).toBe('unavailable');
  });

  it('stores the asset and records key, type and size', async () => {
    const { id } = await withTransaction((c) =>
      upsertMedia(c, { ...base, id: 'dl-test-ok', media_url: 'https://cdn/v.mp4' } as any));
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => new Response(Readable.toWeb(Readable.from([Buffer.from('vid')])) as any, {
      status: 200, headers: { 'content-type': 'video/mp4' },
    })) as unknown as typeof fetch;

    const result = await runDownloadAsset({ storage, fetchImpl } as any, { mediaId: id });

    expect(result).toBe('stored');
    const { rows } = await pool.query(
      'SELECT asset_status, storage_key, content_type, storage_bytes FROM media WHERE id=$1', [id]);
    expect(rows[0].asset_status).toBe('stored');
    expect(rows[0].content_type).toBe('video/mp4');
    expect(Number(rows[0].storage_bytes)).toBe(42);
    expect(rows[0].storage_key).toContain('dl-test-ok');
  });

  it('marks the row failed and rethrows so the queue can redeliver', async () => {
    const { id } = await withTransaction((c) =>
      upsertMedia(c, { ...base, id: 'dl-test-fail', media_url: 'https://cdn/v.mp4' } as any));
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch;

    await expect(runDownloadAsset({ storage: fakeStorage(), fetchImpl } as any, { mediaId: id })).rejects.toThrow();
    const { rows } = await pool.query('SELECT asset_status FROM media WHERE id=$1', [id]);
    expect(rows[0].asset_status).toBe('failed');
  });

  it('names the stored key from Content-Type, not a misleading URL extension', async () => {
    // Reproduces a real observation: Instagram's CDN served a URL path ending
    // in .heic while the actual bytes (and Content-Type) were JPEG. The URL
    // extension must lose to Content-Type or the object gets served with the
    // wrong MIME type.
    const { id } = await withTransaction((c) =>
      upsertMedia(c, { ...base, media_type: 'IMAGE', id: 'dl-test-ext', media_url: 'https://cdn/photo.heic' } as any));
    const storage = fakeStorage();
    const fetchImpl = vi.fn(async () => new Response(Readable.toWeb(Readable.from([Buffer.from('img')])) as any, {
      status: 200, headers: { 'content-type': 'image/jpeg' },
    })) as unknown as typeof fetch;

    await runDownloadAsset({ storage, fetchImpl } as any, { mediaId: id });

    const { rows } = await pool.query('SELECT storage_key FROM media WHERE id=$1', [id]);
    expect(rows[0].storage_key).toMatch(/\.jpg$/);
  });

  it('skips an already-stored asset without re-downloading', async () => {
    const { id } = await withTransaction((c) =>
      upsertMedia(c, { ...base, id: 'dl-test-dup', media_url: 'https://cdn/v.mp4' } as any));
    await pool.query(`UPDATE media SET asset_status='stored', storage_key='k' WHERE id=$1`, [id]);
    const storage = fakeStorage();
    expect(await runDownloadAsset({ storage } as any, { mediaId: id })).toBe('skipped');
    expect(storage.put).not.toHaveBeenCalled();
  });
});
