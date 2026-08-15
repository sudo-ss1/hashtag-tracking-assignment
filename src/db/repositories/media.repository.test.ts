import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { pool, withTransaction } from '../pool.js';
import { upsertMedia, linkHashtagMedia, markAssetStored, claimForDownload } from './media.repository.js';
import { getHashtagByName } from './hashtag.repository.js';

const item = {
  id: 'repo-test-1', media_type: 'IMAGE', timestamp: '2026-08-13T15:13:39+0000',
  permalink: 'https://x/1', media_url: 'https://cdn/1.jpg', caption: 'first',
  like_count: 10, comments_count: 2,
};

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'repo-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'repo-test-%'`);
  await pool.end();
});

describe('upsertMedia', () => {
  it('reports inserted on first write and not on the second', async () => {
    const a = await withTransaction((c) => upsertMedia(c, item));
    const b = await withTransaction((c) => upsertMedia(c, item));
    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(false);
    expect(b.id).toBe(a.id);
  });

  it('refreshes volatile fields but preserves first_seen_at', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    const before = await pool.query('SELECT first_seen_at FROM media WHERE id=$1', [id]);
    await withTransaction((c) => upsertMedia(c, { ...item, like_count: 999, caption: 'updated' }));
    const after = await pool.query('SELECT first_seen_at, last_seen_at, like_count, caption FROM media WHERE id=$1', [id]);
    expect(after.rows[0].like_count).toBe(999);
    expect(after.rows[0].caption).toBe('updated');
    expect(after.rows[0].first_seen_at).toEqual(before.rows[0].first_seen_at);
    expect(after.rows[0].last_seen_at.getTime()).toBeGreaterThanOrEqual(before.rows[0].first_seen_at.getTime());
  });

  it('never resets a stored asset back to pending on re-sync', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await markAssetStored(id, 'media/x.jpg', 'image/jpeg', 123);
    await withTransaction((c) => upsertMedia(c, { ...item, like_count: 50 }));
    const { rows } = await pool.query('SELECT asset_status, storage_key FROM media WHERE id=$1', [id]);
    expect(rows[0].asset_status).toBe('stored');
    expect(rows[0].storage_key).toBe('media/x.jpg');
  });

  it('records both sources when the same media appears in top and recent', async () => {
    const h = await getHashtagByName('matcha');
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await withTransaction(async (c) => {
      await linkHashtagMedia(c, h!.id, id, 'top');
      await linkHashtagMedia(c, h!.id, id, 'recent');
      await linkHashtagMedia(c, h!.id, id, 'top');   // repeat must not throw
    });
    const { rows } = await pool.query('SELECT source FROM hashtag_media WHERE media_id=$1 ORDER BY source::text', [id]);
    expect(rows.map((r) => r.source)).toEqual(['recent', 'top']);
  });

  it('claimForDownload returns null for an already-stored asset', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await markAssetStored(id, 'media/y.jpg', 'image/jpeg', 1);
    expect(await claimForDownload(id)).toBeNull();
  });
});
