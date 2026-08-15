import { withTransaction } from '../db/pool.js';
import {
  upsertMedia, linkHashtagMedia, releaseStaleClaims, findReclaimableMediaIds,
} from '../db/repositories/media.repository.js';
import { getHashtagByName } from '../db/repositories/hashtag.repository.js';
import { startRun, finishRun } from '../db/repositories/sync-run.repository.js';
import { config, redact } from '../config/index.js';
import type { Queue, QueueEntry } from '../adapters/queue/index.js';
import type { InstagramClient, MediaSource } from '../adapters/instagram/client.js';

export type SyncDeps = { queue: Queue; instagram: InstagramClient };

export async function runSyncMedia(
  deps: SyncDeps, payload: { hashtagName: string; source: MediaSource },
): Promise<{ seen: number; created: number; pages: number }> {
  const hashtag = await getHashtagByName(payload.hashtagName);
  if (!hashtag) throw new Error(`unknown hashtag: ${payload.hashtagName}`);

  // Recover work orphaned by a crashed worker or a failed enqueue. The partial index
  // idx_media_asset_pending exists for exactly this.
  await releaseStaleClaims();
  const reclaimable = await findReclaimableMediaIds(hashtag.id, config.syncMaxItems);
  if (reclaimable.length) {
    await deps.queue.enqueueBatch(
      reclaimable.map((mediaId) => ({ job: 'DOWNLOAD_ASSET' as const, payload: { mediaId } })),
    );
    console.log(`[sync] reclaimed ${reclaimable.length} media needing assets`);
  }

  const runId = await startRun(hashtag.id, payload.source);
  let seen = 0, created = 0, pages = 0;

  try {
    const result = await deps.instagram.fetchHashtagMedia({
      hashtagId: hashtag.ig_hashtag_id,
      source: payload.source,
      maxItems: config.syncMaxItems,
      maxPages: config.syncMaxPages,
      onPage: async (items) => {
        const toDownload = await withTransaction(async (client) => {
          const ids: number[] = [];
          for (const item of items) {
            seen++;
            await client.query('SAVEPOINT item');
            try {
              const { id, inserted } = await upsertMedia(client, item);
              await linkHashtagMedia(client, hashtag.id, id, payload.source);
              await client.query('RELEASE SAVEPOINT item');
              if (inserted) { created++; ids.push(id); }
            } catch (err) {
              await client.query('ROLLBACK TO SAVEPOINT item');
              await client.query('RELEASE SAVEPOINT item');
              // One malformed item must not lose the rest of the page.
              console.error(`[sync] skipped item ${item.id}: ${redact((err as Error).message)}`);
            }
          }
          return ids;
        });

        // Enqueue only after commit.
        if (toDownload.length) {
          const entries: QueueEntry[] = toDownload.map((mediaId) => ({
            job: 'DOWNLOAD_ASSET', payload: { mediaId },
          }));
          await deps.queue.enqueueBatch(entries);
        }
      },
    });

    pages = result.pages;
    await finishRun(runId, { status: 'succeeded', pages, seen, created });
    return { seen, created, pages };
  } catch (err) {
    await finishRun(runId, { status: 'failed', pages, seen, created, error: redact((err as Error).message) });
    throw err;
  }
}
