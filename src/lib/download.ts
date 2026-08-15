import { Readable } from 'node:stream';

const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function streamRemote(
  url: string, fetchImpl: typeof fetch = fetch,
): Promise<{ body: Readable; contentType: string }> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`asset fetch failed: HTTP ${res.status}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (!/^(image|video)\//.test(contentType)) {
    throw new Error(`unexpected content-type: ${contentType || 'none'}`);
  }
  if (!res.body) throw new Error('asset fetch returned no body');

  return { body: Readable.fromWeb(res.body as any), contentType };
}
