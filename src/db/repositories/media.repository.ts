import type { PoolClient } from 'pg';
import { pool } from '../pool.js';
import type { IgMedia, MediaSource } from '../../adapters/instagram/types.js';

export async function upsertMedia(client: PoolClient, item: IgMedia): Promise<{ id: number; inserted: boolean }> {
  const { rows } = await client.query(
    `INSERT INTO media (ig_media_id, media_type, caption, permalink, ig_timestamp,
                        like_count, comments_count, source_media_url, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (ig_media_id) DO UPDATE SET
       caption          = EXCLUDED.caption,
       like_count       = EXCLUDED.like_count,
       comments_count   = EXCLUDED.comments_count,
       source_media_url = COALESCE(EXCLUDED.source_media_url, media.source_media_url),
       raw              = EXCLUDED.raw,
       last_seen_at     = now(),
       updated_at       = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      item.id, item.media_type, item.caption ?? null, item.permalink, item.timestamp,
      item.like_count ?? null, item.comments_count ?? null, item.media_url ?? null,
      JSON.stringify(item),
    ],
  );
  return { id: Number(rows[0].id), inserted: rows[0].inserted };
}

export async function linkHashtagMedia(
  client: PoolClient, hashtagId: number, mediaId: number, source: MediaSource,
): Promise<void> {
  await client.query(
    `INSERT INTO hashtag_media (hashtag_id, media_id, source)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [hashtagId, mediaId, source],
  );
}

export type DownloadClaim = {
  id: number; ig_media_id: string; source_media_url: string | null; media_type: string;
};

// Atomically moves pending/failed -> downloading so two workers cannot both take it.
export async function claimForDownload(mediaId: number): Promise<DownloadClaim | null> {
  const { rows } = await pool.query(
    `UPDATE media SET asset_status = 'downloading', asset_attempts = asset_attempts + 1, updated_at = now()
     WHERE id = $1 AND asset_status IN ('pending','failed')
     RETURNING id, ig_media_id, source_media_url, media_type`,
    [mediaId],
  );
  return rows[0] ?? null;
}

export async function markAssetStored(
  mediaId: number, key: string, contentType: string, bytes: number,
): Promise<void> {
  await pool.query(
    `UPDATE media SET asset_status='stored', storage_key=$2, content_type=$3,
            storage_bytes=$4, asset_error=NULL, updated_at=now() WHERE id=$1`,
    [mediaId, key, contentType, bytes],
  );
}

export async function markAssetFailed(mediaId: number, error: string): Promise<void> {
  await pool.query(
    `UPDATE media SET asset_status='failed', asset_error=$2, updated_at=now() WHERE id=$1`,
    [mediaId, error.slice(0, 500)],
  );
}

// Terminal: the item never had a media_url, so retrying can never help.
export async function markAssetUnavailable(mediaId: number): Promise<void> {
  await pool.query(
    `UPDATE media SET asset_status='unavailable', updated_at=now() WHERE id=$1`,
    [mediaId],
  );
}
