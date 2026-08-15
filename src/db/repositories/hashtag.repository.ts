import { pool } from '../pool.js';

export async function getHashtagByName(name: string): Promise<{ id: number; ig_hashtag_id: string } | null> {
  const { rows } = await pool.query('SELECT id, ig_hashtag_id FROM hashtags WHERE name = $1', [name]);
  return rows[0] ? { id: Number(rows[0].id), ig_hashtag_id: rows[0].ig_hashtag_id } : null;
}
