import { describe, it, expect, afterAll } from 'vitest';
import { pool } from './pool.js';

afterAll(async () => { await pool.end(); });

describe('schema', () => {
  it('seeds the matcha hashtag', async () => {
    const { rows } = await pool.query(`SELECT ig_hashtag_id FROM hashtags WHERE name = 'matcha'`);
    expect(rows[0].ig_hashtag_id).toBe('17843758702042126');
  });

  it('enforces one row per ig_media_id', async () => {
    const insert = `INSERT INTO media (ig_media_id, media_type, permalink, ig_timestamp, raw)
                    VALUES ('dup-test','IMAGE','https://x', now(), '{}'::jsonb)`;
    await pool.query(`DELETE FROM media WHERE ig_media_id = 'dup-test'`);
    await pool.query(insert);
    await expect(pool.query(insert)).rejects.toThrow(/duplicate key/);
    await pool.query(`DELETE FROM media WHERE ig_media_id = 'dup-test'`);
  });

  it('accepts an unknown media_type without failing', async () => {
    await pool.query(`DELETE FROM media WHERE ig_media_id = 'future-type'`);
    await expect(pool.query(
      `INSERT INTO media (ig_media_id, media_type, permalink, ig_timestamp, raw)
       VALUES ('future-type','SOME_NEW_META_TYPE','https://x', now(), '{}'::jsonb)`
    )).resolves.toBeTruthy();
    await pool.query(`DELETE FROM media WHERE ig_media_id = 'future-type'`);
  });
});
