import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { pool, withTransaction } from '../db/pool.js';
import { upsertMedia, linkHashtagMedia } from '../db/repositories/media.repository.js';
import { getHashtagByName } from '../db/repositories/hashtag.repository.js';
import { buildApp } from '../server.js';

const app = buildApp();

async function seed(idx: number, iso: string) {
  const h = await getHashtagByName('matcha');
  return withTransaction(async (c) => {
    const { id } = await upsertMedia(c, {
      id: `api-test-${idx}`, media_type: 'IMAGE', timestamp: iso,
      permalink: `https://x/${idx}`, media_url: 'https://cdn/x.jpg',
    } as any);
    await linkHashtagMedia(c, h!.id, id, 'top');
    return id;
  });
}

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'api-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'api-test-%'`);
  await pool.end();
});

describe('GET /hashtags', () => {
  it('returns media newest-first', async () => {
    await seed(1, '2026-08-10T10:00:00+0000');
    await seed(2, '2026-08-12T10:00:00+0000');
    const res = await request(app).get('/hashtags?hashtag=matcha&limit=10');
    expect(res.status).toBe(200);
    const ids = res.body.data.map((d: any) => d.id);
    expect(ids.indexOf('api-test-2')).toBeLessThan(ids.indexOf('api-test-1'));
  });

  it('does not repeat a row when new media arrives between pages', async () => {
    await seed(1, '2026-08-10T10:00:00+0000');
    await seed(2, '2026-08-11T10:00:00+0000');
    await seed(3, '2026-08-12T10:00:00+0000');

    const p1 = await request(app).get('/hashtags?hashtag=matcha&limit=2');
    const firstIds = p1.body.data.map((d: any) => d.id);

    await seed(4, '2026-08-13T10:00:00+0000');   // lands at the top mid-pagination

    const p2 = await request(app).get(`/hashtags?hashtag=matcha&limit=2&cursor=${p1.body.pagination.nextCursor}`);
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

    const res = await request(app).get('/hashtags?hashtag=matcha&limit=10');
    expect(res.status).toBe(200);

    const stored = res.body.data.find((d: any) => d.id === 'api-test-5');
    expect(stored.assetStatus).toBe('stored');
    expect(stored.assetUrl).toBe('/assets/hashtag-media/api-test-asset.jpg');

    const pending = res.body.data.find((d: any) => d.id === 'api-test-6');
    expect(pending.assetUrl).toBeNull();
  });
});
