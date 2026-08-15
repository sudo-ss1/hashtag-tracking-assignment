import path from 'node:path';
import { claimForDownload, markAssetStored, markAssetFailed, markAssetUnavailable } from '../db/repositories/media.repository.js';
import { streamRemote } from '../lib/download.js';
import { config, redact } from '../config/index.js';
import type { Storage } from '../adapters/storage/index.js';

export type DownloadDeps = { storage: Storage; fetchImpl?: typeof fetch };

// Content-Type is what the bytes actually are; the CDN URL's path extension is
// not trustworthy — Instagram routinely serves JPEG bytes at a URL path ending
// in .heic/.webp, and express.static (or S3) would then serve the wrong MIME
// type for that object. Content-Type wins whenever it's one we recognise; the
// URL path is only a fallback for a type this map doesn't know about.
const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
};

function extensionFor(contentType: string, url: string): string {
  const known = EXTENSION_BY_CONTENT_TYPE[contentType.toLowerCase()];
  if (known) return known;
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
