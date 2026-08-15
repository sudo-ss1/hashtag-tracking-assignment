import { pool } from '../pool.js';
import type { MediaSource } from '../../adapters/instagram/types.js';

export async function startRun(hashtagId: number, source: MediaSource): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO sync_runs (hashtag_id, source) VALUES ($1,$2) RETURNING id`,
    [hashtagId, source],
  );
  return Number(rows[0].id);
}

export async function finishRun(
  runId: number,
  patch: { status: 'succeeded' | 'failed'; pages: number; seen: number; created: number; error?: string },
): Promise<void> {
  await pool.query(
    `UPDATE sync_runs SET status=$2, pages_fetched=$3, items_seen=$4, items_new=$5,
            error=$6, finished_at=now() WHERE id=$1`,
    [runId, patch.status, patch.pages, patch.seen, patch.created, patch.error?.slice(0, 1000) ?? null],
  );
}
