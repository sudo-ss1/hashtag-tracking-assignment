import path from 'node:path';
import { claimForDownload, markAssetStored, markAssetFailed, markAssetUnavailable } from '../db/repositories/media.repository.js';
import { streamRemote } from '../lib/download.js';
import { config, redact } from '../config/index.js';
import type { Storage } from '../adapters/storage/index.js';

export type DownloadDeps = { storage: Storage; fetchImpl?: typeof fetch };

function extensionFor(contentType: string, url: string): string {
  const fromUrl = path.extname(new URL(url).pathname);
  if (fromUrl) return fromUrl;
  if (contentType.startsWith('video/')) return '.mp4';
  return '.jpg';
}

export async function runDownloadAsset(
  deps: DownloadDeps, payload: { mediaId: number },
): Promise<'stored' | 'unavailable' | 'skipped'> {
  const claim = await claimForDownload(payload.mediaId);
  // Already stored, already unavailable, or taken by another worker.
  if (!claim) return 'skipped';

  try {
    if (!claim.source_media_url) {
      await markAssetUnavailable(claim.id);
      return 'unavailable';
    }

    const { body, contentType } = await streamRemote(claim.source_media_url, deps.fetchImpl);
    const key = `${config.s3.prefix}/${claim.ig_media_id}${extensionFor(contentType, claim.source_media_url)}`;
    const { bytes } = await deps.storage.put(key, body, contentType);
    await markAssetStored(claim.id, key, contentType, bytes);
    return 'stored';
  } catch (err) {
    await markAssetFailed(claim.id, redact((err as Error).message));
    throw err;   // rethrow so the queue redelivers
  }
}
