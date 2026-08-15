import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { pool } from '../../src/db/pool.js';
import { config } from '../../src/config/index.js';
import { InstagramClient } from '../../src/adapters/instagram/client.js';
import { InMemoryQueue } from '../../src/adapters/queue/memory.js';
import { LocalStorage } from '../../src/adapters/storage/local.js';
import { runSyncMedia } from '../../src/jobs/sync-media.job.js';
import { dispatch, type JobDeps } from '../../src/jobs/index.js';
import { buildApp } from '../../src/server.js';

// Dedicated hashtag, exactly like the other suites: runSyncMedia unconditionally
// reclaims stale pending media for the hashtag it's given, and live syncs leave
// real pending/stored rows under 'matcha'. A separate hashtag keeps that live
// data out of the reclaim sweep and out of every assertion below.
const TEST_TAG = 'e2e-test-tag';
const TEST_HASHTAG_ID = 'e2e-test-hashtag-id';
const STORAGE_DIR = './.tmp-e2e-storage';

const app = buildApp();

// Fake Graph API page: one item has a media_url (goes through download ->
// 'stored'), one does not (goes through the terminal 'unavailable' path).
// Timestamps are strictly increasing so "newest first" has an unambiguous
// expected order.
const igItems = [
  {
    id: 'e2e-test-media-1', media_type: 'IMAGE', timestamp: '2026-08-14T10:00:00+0000',
    permalink: 'https://x/e2e-test-media-1', media_url: 'https://fake-cdn.e2e-test.local/e2e-test-media-1.jpg',
  },
  {
    id: 'e2e-test-media-2', media_type: 'IMAGE', timestamp: '2026-08-14T11:00:00+0000',
    permalink: 'https://x/e2e-test-media-2',
    // No media_url — Meta doesn't guarantee this field is present.
  },
  {
    id: 'e2e-test-media-3', media_type: 'IMAGE', timestamp: '2026-08-14T12:00:00+0000',
    permalink: 'https://x/e2e-test-media-3', media_url: 'https://fake-cdn.e2e-test.local/e2e-test-media-3.jpg',
  },
];

const fakeAssetBytes: Record<string, Buffer> = {
  'e2e-test-media-1.jpg': Buffer.from('fake-jpeg-bytes-1'),
  'e2e-test-media-3.jpg': Buffer.from('fake-jpeg-bytes-3'),
};

// One fake fetchImpl backs both the Graph API page fetch (InstagramClient) and
// the asset download (streamRemote inside runDownloadAsset) — no real network
// call is made anywhere in this test.
const fetchImpl = (async (input: unknown) => {
  const href = String(input);
  if (href.startsWith(config.ig.graphBaseUrl)) {
    return new Response(JSON.stringify({ data: igItems }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  const filename = href.split('/').pop() ?? '';
  const bytes = fakeAssetBytes[filename];
  if (!bytes) return new Response('not found', { status: 404 });
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
}) as unknown as typeof fetch;

let testHashtagId: number;

beforeAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'e2e-test-%'`);
  const { rows } = await pool.query(
    `INSERT INTO hashtags (ig_hashtag_id, name) VALUES ($1, $2)
     ON CONFLICT (ig_hashtag_id) DO UPDATE SET ig_hashtag_id = EXCLUDED.ig_hashtag_id
     RETURNING id`,
    [TEST_HASHTAG_ID, TEST_TAG],
  );
  testHashtagId = Number(rows[0].id);
});

afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'e2e-test-%'`);
  await pool.query(`DELETE FROM hashtags WHERE ig_hashtag_id = $1`, [TEST_HASHTAG_ID]);
  await pool.end();
  await rm(STORAGE_DIR, { recursive: true, force: true });
});

describe('end-to-end pipeline: sync -> download -> API', () => {
  it('syncs media, downloads assets, and serves them through the read API', async () => {
    const instagram = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });
    const queue = new InMemoryQueue();
    const storage = new LocalStorage(STORAGE_DIR);

    // JobDeps only declares { queue, storage, instagram }, but dispatch() forwards
    // this same object straight through to runDownloadAsset, whose DownloadDeps
    // also accepts an optional fetchImpl — attaching it here (rather than through
    // createStorage()/global fetch) is what keeps the download step off the network.
    const deps = { queue, storage, instagram, fetchImpl } satisfies JobDeps & { fetchImpl: typeof fetch };
    const putSpy = vi.spyOn(storage, 'put');

    const syncResult = await runSyncMedia(deps, { hashtagName: TEST_TAG, source: 'top' });
    expect(syncResult.seen).toBe(3);
    expect(syncResult.created).toBe(3);

    // Drain the queue exactly as the worker does: receive, dispatch, ack.
    let messages = await queue.receive(10);
    let dispatched = 0;
    while (messages.length) {
      for (const message of messages) {
        await dispatch(deps, message);
        await queue.ack(message);
        dispatched++;
      }
      messages = await queue.receive(10);
    }
    expect(dispatched).toBe(3); // one DOWNLOAD_ASSET job per media row

    const { rows } = await pool.query(
      `SELECT ig_media_id, asset_status, storage_key
       FROM media WHERE ig_media_id LIKE 'e2e-test-%' ORDER BY ig_media_id`,
    );
    expect(rows.map((r) => r.ig_media_id)).toEqual([
      'e2e-test-media-1', 'e2e-test-media-2', 'e2e-test-media-3',
    ]);

    const byId = Object.fromEntries(rows.map((r) => [r.ig_media_id, r]));

    expect(byId['e2e-test-media-1'].asset_status).toBe('stored');
    expect(byId['e2e-test-media-1'].storage_key).not.toBeNull();
    expect(existsSync(path.resolve(STORAGE_DIR, byId['e2e-test-media-1'].storage_key))).toBe(true);

    expect(byId['e2e-test-media-3'].asset_status).toBe('stored');
    expect(byId['e2e-test-media-3'].storage_key).not.toBeNull();
    expect(existsSync(path.resolve(STORAGE_DIR, byId['e2e-test-media-3'].storage_key))).toBe(true);

    expect(byId['e2e-test-media-2'].asset_status).toBe('unavailable');
    expect(byId['e2e-test-media-2'].storage_key).toBeNull();

    // storage.put must never have been called for the media_url-less item.
    const putKeys = putSpy.mock.calls.map(([key]) => key);
    expect(putKeys.some((k) => k.includes('e2e-test-media-2'))).toBe(false);
    expect(putSpy).toHaveBeenCalledTimes(2);

    const res = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=10`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((d: any) => d.id);
    expect(ids).toEqual(['e2e-test-media-3', 'e2e-test-media-2', 'e2e-test-media-1']);

    const stored3 = res.body.data.find((d: any) => d.id === 'e2e-test-media-3');
    const unavailable2 = res.body.data.find((d: any) => d.id === 'e2e-test-media-2');
    const stored1 = res.body.data.find((d: any) => d.id === 'e2e-test-media-1');

    expect(stored3.assetUrl).not.toBeNull();
    expect(stored1.assetUrl).not.toBeNull();
    expect(unavailable2.assetUrl).toBeNull();
  });
});
