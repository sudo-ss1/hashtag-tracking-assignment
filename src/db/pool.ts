import pg from 'pg';
import { config } from '../config/index.js';

// Postgres returns BIGINT as a string by default. The BIGINT columns this app
// actually has are the GENERATED ALWAYS AS IDENTITY primary/foreign keys (id,
// hashtag_id, media_id, etc.) and media.storage_bytes — not like_count/
// comments_count, which are INTEGER and unaffected. All of those are safely
// within Number's safe-integer range for this dataset's scale.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
