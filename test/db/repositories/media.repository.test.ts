import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool, withTransaction } from '../../../src/db/pool.js';
import {
  upsertMedia, linkHashtagMedia, markAssetStored, claimForDownload,
  findReclaimableMediaIds, MAX_ASSET_ATTEMPTS,
} from '../../../src/db/repositories/media.repository.js';

const item = {
  id: 'repo-test-1', media_type: 'IMAGE', timestamp: '2026-08-13T15:13:39+0000',
  permalink: 'https://x/1', media_url: 'https://cdn/1.jpg', caption: 'first',
  like_count: 10, comments_count: 2,
};

// Dedicated hashtag for these tests, not 'matcha' — live syncs leave real
// pending/failed rows under 'matcha', and findReclaimableMediaIds would pick
// those up too, contradicting the isolation these tests otherwise rely on.
const hashtagName = 'repo-test-tag';
let testHashtagId: number;

beforeAll(async () => {
  const { rows } = await pool.query(
    `INSERT INTO hashtags (ig_hashtag_id, name) VALUES ('repo-test-hashtag-id', $1)
     ON CONFLICT (ig_hashtag_id) DO UPDATE SET ig_hashtag_id = EXCLUDED.ig_hashtag_id
     RETURNING id`,
    [hashtagName],
  );
  testHashtagId = Number(rows[0].id);
});

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'repo-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'repo-test-%'`);
  await pool.query(`DELETE FROM hashtags WHERE ig_hashtag_id = 'repo-test-hashtag-id'`);
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
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await withTransaction(async (c) => {
      await linkHashtagMedia(c, testHashtagId, id, 'top');
      await linkHashtagMedia(c, testHashtagId, id, 'recent');
      await linkHashtagMedia(c, testHashtagId, id, 'top');   // repeat must not throw
    });
    const { rows } = await pool.query('SELECT source FROM hashtag_media WHERE media_id=$1 ORDER BY source::text', [id]);
    expect(rows.map((r) => r.source)).toEqual(['recent', 'top']);
  });

  it('claimForDownload returns null for an already-stored asset', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await markAssetStored(id, 'media/y.jpg', 'image/jpeg', 1);
    expect(await claimForDownload(id)).toBeNull();
  });

  it('a fresh media_url replaces a stale one', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, { ...item, media_url: 'https://cdn/old.jpg' }));
    await withTransaction((c) => upsertMedia(c, { ...item, media_url: 'https://cdn/new.jpg' }));
    const { rows } = await pool.query('SELECT source_media_url FROM media WHERE id=$1', [id]);
    expect(rows[0].source_media_url).toBe('https://cdn/new.jpg');
  });

  it('a missing media_url does not clobber a previously stored one', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, { ...item, media_url: 'https://cdn/keep.jpg' }));
    const { media_url: _omit, ...withoutUrl } = { ...item, media_url: 'https://cdn/keep.jpg' };
    await withTransaction((c) => upsertMedia(c, withoutUrl));
    const { rows } = await pool.query('SELECT source_media_url FROM media WHERE id=$1', [id]);
    expect(rows[0].source_media_url).toBe('https://cdn/keep.jpg');
  });

  it('a row at the attempt cap is not claimable and is not reclaimed', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await withTransaction((c) => linkHashtagMedia(c, testHashtagId, id, 'top'));
    await pool.query(
      `UPDATE media SET asset_status='failed', asset_attempts=$2 WHERE id=$1`,
      [id, MAX_ASSET_ATTEMPTS],
    );

    expect(await claimForDownload(id)).toBeNull();

    const reclaimable = await findReclaimableMediaIds(testHashtagId, 100);
    expect(reclaimable).not.toContain(id);
  });

  it('a row just under the attempt cap is still claimable and reclaimable', async () => {
    const { id } = await withTransaction((c) => upsertMedia(c, item));
    await withTransaction((c) => linkHashtagMedia(c, testHashtagId, id, 'top'));
    await pool.query(
      `UPDATE media SET asset_status='failed', asset_attempts=$2 WHERE id=$1`,
      [id, MAX_ASSET_ATTEMPTS - 1],
    );

    const reclaimable = await findReclaimableMediaIds(testHashtagId, 100);
    expect(reclaimable).toContain(id);

    const claim = await claimForDownload(id);
    expect(claim).not.toBeNull();
  });
});
