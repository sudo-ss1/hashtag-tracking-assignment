import type { QueueMessage, Queue } from '../adapters/queue/index.js';
import type { Storage } from '../adapters/storage/index.js';
import { InstagramClient } from '../adapters/instagram/client.js';
import { runSyncMedia } from './sync-media.job.js';
import { runDownloadAsset } from './download-asset.job.js';

export type JobDeps = { queue: Queue; storage: Storage; instagram: InstagramClient };

export async function dispatch(deps: JobDeps, message: QueueMessage): Promise<void> {
  switch (message.job) {
    case 'SYNC_TOP_MEDIA':
      await runSyncMedia(deps, { hashtagName: (message.payload as any).hashtagName, source: 'top' });
      return;
    case 'SYNC_RECENT_MEDIA':
      await runSyncMedia(deps, { hashtagName: (message.payload as any).hashtagName, source: 'recent' });
      return;
    case 'DOWNLOAD_ASSET':
      await runDownloadAsset(deps, { mediaId: (message.payload as any).mediaId });
      return;
    default:
      throw new Error(`unknown job: ${message.job}`);
  }
}

export { runSyncMedia, runDownloadAsset };
