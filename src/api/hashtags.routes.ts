import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { createStorage } from '../adapters/storage/index.js';
import { encodeCursor, decodeCursor } from './cursor.js';
import { BadRequestError } from './errors.js';

const MAX_LIMIT = 100;

const Query = z.object({
  hashtag: z.string().optional(),
  // Clamp, don't reject: an oversized limit is still a valid request, just
  // capped at MAX_LIMIT rather than rejected with a 400.
  limit: z.coerce.number().int().positive().default(25).transform((n) => Math.min(n, MAX_LIMIT)),
  cursor: z.string().optional(),
});

export function hashtagsRouter(): Router {
  const router = Router();
  const storage = createStorage();

  router.get('/hashtags', async (req, res, next) => {
    try {
      const parsed = Query.safeParse(req.query);
      if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]!.message);
      const { hashtag, limit, cursor } = parsed.data;

      let after: { ts: Date; id: number } | null = null;
      if (cursor) {
        try { after = decodeCursor(cursor); }
        catch { throw new BadRequestError('invalid cursor'); }
      }

      // Keyset, not OFFSET: anchors to a position in the data, so rows
      // arriving at the top mid-pagination cannot shift the window.
      const params: unknown[] = [limit + 1];
      const clauses: string[] = [];

      if (hashtag) {
        params.push(hashtag);
        clauses.push(`EXISTS (SELECT 1 FROM hashtag_media hm
                              JOIN hashtags h ON h.id = hm.hashtag_id
                              WHERE hm.media_id = m.id AND h.name = $${params.length})`);
      }
      if (after) {
        params.push(after.ts, after.id);
        clauses.push(`(m.ig_timestamp, m.id) < ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
      }

      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      // One query per request — no per-row lookups. `getReadUrl` is I/O-free in
      // both storage drivers (S3 presigning is local crypto), so building
      // assetUrl below adds no round-trips. EXPLAIN ANALYZE on the ?hashtag=
      // path shows a nested-loop semi join driven by idx_media_feed: Postgres
      // probes the join index once per candidate row and stops at LIMIT,
      // keeping this O(limit). The unfiltered path uses the same index for its
      // ORDER BY + LIMIT scan. A hash join would materialise every matching row
      // before sorting, making it O(table).
      const { rows } = await pool.query(
        `SELECT m.id, m.ig_media_id, m.media_type, m.caption, m.permalink, m.ig_timestamp,
                m.like_count, m.comments_count, m.storage_key, m.asset_status
         FROM media m
         ${where}
         ORDER BY m.ig_timestamp DESC, m.id DESC
         LIMIT $1`,
        params,
      );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;

      const data = await Promise.all(page.map(async (r) => ({
        id: r.ig_media_id,
        mediaType: r.media_type,
        caption: r.caption,
        permalink: r.permalink,
        timestamp: r.ig_timestamp.toISOString(),
        likeCount: r.like_count,
        commentsCount: r.comments_count,
        assetStatus: r.asset_status,
        assetUrl: r.storage_key ? await storage.getReadUrl(r.storage_key) : null,
      })));

      const last = page[page.length - 1];
      res.json({
        data,
        pagination: {
          nextCursor: hasMore && last ? encodeCursor(last.ig_timestamp, Number(last.id)) : null,
          hasMore,
        },
      });
    } catch (err) { next(err); }
  });

  return router;
}
