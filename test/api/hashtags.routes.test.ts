import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { pool, withTransaction } from '../../src/db/pool.js';
import { upsertMedia, linkHashtagMedia } from '../../src/db/repositories/media.repository.js';
import { buildApp } from '../../src/server.js';

const app = buildApp();

// Dedicated hashtag for these tests. Live syncs write real, recent-timestamped
// data under 'matcha', which would otherwise bury these fixed-timestamp fixtures
// inside the route's limit-bounded queries. Using a separate hashtag makes that
// live data structurally irrelevant instead of relying on timestamps or limits.
const TEST_TAG = 'api-test-tag';
let testHashtagId: number;

async function seed(idx: number, iso: string) {
  return withTransaction(async (c) => {
    const { id } = await upsertMedia(c, {
      id: `api-test-${idx}`, media_type: 'IMAGE', timestamp: iso,
      permalink: `https://x/${idx}`, media_url: 'https://cdn/x.jpg',
    } as any);
    await linkHashtagMedia(c, testHashtagId, id, 'top');
    return id;
  });
}

beforeAll(async () => {
  const { rows } = await pool.query(
    `INSERT INTO hashtags (ig_hashtag_id, name) VALUES ('api-test-hashtag-id', $1)
     ON CONFLICT (ig_hashtag_id) DO UPDATE SET ig_hashtag_id = EXCLUDED.ig_hashtag_id
     RETURNING id`,
    [TEST_TAG],
  );
  testHashtagId = Number(rows[0].id);
});

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'api-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'api-test-%'`);
  await pool.query(`DELETE FROM hashtags WHERE ig_hashtag_id = 'api-test-hashtag-id'`);
  await pool.end();
});

describe('GET /hashtags', () => {
  it('returns media newest-first', async () => {
    await seed(1, '2026-08-10T10:00:00+0000');
    await seed(2, '2026-08-12T10:00:00+0000');
    const res = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=10`);
    expect(res.status).toBe(200);
    const ids = res.body.data.map((d: any) => d.id);
    expect(ids.indexOf('api-test-2')).toBeLessThan(ids.indexOf('api-test-1'));
  });

  it('does not repeat a row when new media arrives between pages', async () => {
    await seed(1, '2026-08-10T10:00:00+0000');
    await seed(2, '2026-08-11T10:00:00+0000');
    await seed(3, '2026-08-12T10:00:00+0000');

    const p1 = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=2`);
    const firstIds = p1.body.data.map((d: any) => d.id);

    await seed(4, '2026-08-13T10:00:00+0000');   // lands at the top mid-pagination

    const p2 = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=2&cursor=${p1.body.pagination.nextCursor}`);
    const secondIds = p2.body.data.map((d: any) => d.id);

    expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
  });

  it('rejects a malformed cursor with 400', async () => {
    const res = await request(app).get('/hashtags?cursor=%%%bad');
    expect(res.status).toBe(400);
  });

  it('rejects a cursor with an out-of-range id with 400, not 500', async () => {
    const cursor = Buffer.from('2026-01-01T00:00:00.000Z|99999999999999999999').toString('base64url');
    const res = await request(app).get(`/hashtags?cursor=${cursor}`);
    expect(res.status).toBe(400);
  });

  it('clamps limit to the maximum', async () => {
    const res = await request(app).get('/hashtags?limit=9999');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(100);
  });

  it('populates assetUrl for stored assets and null for pending ones', async () => {
    const storedId = await seed(5, '2026-08-14T10:00:00+0000');
    await seed(6, '2026-08-13T10:00:00+0000');
    await pool.query(
      `UPDATE media SET asset_status = 'stored', storage_key = $2 WHERE id = $1`,
      [storedId, 'hashtag-media/api-test-asset.jpg'],
    );

    const res = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=10`);
    expect(res.status).toBe(200);

    const stored = res.body.data.find((d: any) => d.id === 'api-test-5');
    expect(stored.assetStatus).toBe('stored');
    expect(stored.assetUrl).toBe('/assets/hashtag-media/api-test-asset.jpg');

    const pending = res.body.data.find((d: any) => d.id === 'api-test-6');
    expect(pending.assetUrl).toBeNull();
  });

  it('issues exactly one database query per request, regardless of row count', async () => {
    // Seed and set up BEFORE installing the spy, so setup queries aren't counted.
    for (let i = 1; i <= 5; i++) {
      await seed(i, `2026-08-1${i}T10:00:00+0000`);
    }

    const querySpy = vi.spyOn(pool, 'query');
    try {
      const res = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=10`);
      expect(res.status).toBe(200);
      // Meaningful only if the page actually has multiple rows: otherwise a
      // single query could trivially "pass" against an empty result set.
      expect(res.body.data.length).toBeGreaterThanOrEqual(5);
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
  });

  it('builds assetUrl for a full page without any additional database queries', async () => {
    // Seed rows and mark them 'stored' with a non-null storage_key BEFORE
    // installing the spy, so the asset-url path (storage.getReadUrl per row)
    // is exercised on every row without setup queries being counted.
    const ids: number[] = [];
    for (let i = 1; i <= 5; i++) {
      ids.push(await seed(i, `2026-08-1${i}T10:00:00+0000`));
    }
    for (const id of ids) {
      await pool.query(
        `UPDATE media SET asset_status = 'stored', storage_key = $2 WHERE id = $1`,
        [id, `hashtag-media/api-test-nplus1-${id}.jpg`],
      );
    }

    const querySpy = vi.spyOn(pool, 'query');
    try {
      const res = await request(app).get(`/hashtags?hashtag=${TEST_TAG}&limit=10`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(5);
      expect(res.body.data.every((d: any) => d.assetUrl !== null)).toBe(true);
      // Proves building N assetUrls (storage.getReadUrl per row) adds zero
      // round-trips: the query count is identical to a page with no storage
      // keys at all. This does not spy on storage.getReadUrl directly (the
      // router constructs the storage instance internally via createStorage()
      // and isn't injectable without a production refactor), so it's an
      // indirect but honest proxy for "asset URL construction is I/O-free".
      expect(querySpy).toHaveBeenCalledTimes(1);
    } finally {
      querySpy.mockRestore();
    }
  });
});
