import { describe, it, expect, vi } from 'vitest';
import { InstagramClient } from '../../../src/adapters/instagram/client.js';
import { config } from '../../../src/config/index.js';

const media = (id: string) => ({
  id, media_type: 'IMAGE', timestamp: '2026-08-13T15:13:39+0000', permalink: `https://x/${id}`,
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('InstagramClient', () => {
  it('halves the page size when Meta returns code:1 and retries', async () => {
    const limits: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      limits.push(Number(new URL(url).searchParams.get('limit')));
      if (limits.length === 1) {
        return jsonResponse({ error: { code: 1, message: 'Please reduce the amount of data' } }, 500);
      }
      return jsonResponse({ data: [media('a')] });
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });
    const res = await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 50, maxPages: 5 });

    expect(limits[0]).toBe(9);
    expect(limits[1]).toBe(4);          // halved
    expect(res.items).toHaveLength(1);
  });

  it('follows paging.cursors.after and never requests paging.next', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      urls.push(url);
      if (urls.length === 1) {
        return jsonResponse({
          data: [media('a')],
          paging: { cursors: { after: 'CUR2' }, next: 'https://evil/next?access_token=LEAKED' },
        });
      }
      return jsonResponse({ data: [media('b')] });   // no paging -> terminates
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });
    const res = await client.fetchHashtagMedia({ hashtagId: 'h', source: 'recent', maxItems: 50, maxPages: 5 });

    expect(res.items.map((m) => m.id)).toEqual(['a', 'b']);
    expect(urls[1]).toContain('after=CUR2');
    expect(urls.some((u) => u.includes('LEAKED'))).toBe(false);
  });

  it('stops at maxItems even when more pages exist', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [media('a'), media('b'), media('c')],
      paging: { cursors: { after: 'MORE' } },
    })) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 3, backoffMs: 0 });
    const res = await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 5, maxPages: 99 });
    expect(res.items).toHaveLength(5);
  });

  it('stops at maxPages so a repeating cursor cannot loop forever', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      data: [media('a')],
      paging: { cursors: { after: 'SAME' } },
    })) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });
    const res = await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 10_000, maxPages: 3 });
    expect(res.pages).toBe(3);
  });

  it('keeps the reduced page size for the rest of the run', async () => {
    const limits: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      limits.push(Number(new URL(url).searchParams.get('limit')));
      call++;
      if (call === 1) return jsonResponse({ error: { code: 1, message: 'reduce' } }, 500);
      if (call === 2) return jsonResponse({ data: [media('a')], paging: { cursors: { after: 'C2' } } });
      return jsonResponse({ data: [media('b')] });
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 8, backoffMs: 0 });
    await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 50, maxPages: 5 });
    expect(limits).toEqual([8, 4, 4]);   // does not climb back to 8
  });

  it('halves all the way down to the floor page size before giving up', async () => {
    const limits: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      limits.push(Number(new URL(url).searchParams.get('limit')));
      return jsonResponse({ error: { code: 1, message: 'Please reduce the amount of data' } }, 500);
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 50, backoffMs: 0 });

    await expect(
      client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 50, maxPages: 5 }),
    ).rejects.toThrow();

    // Halving must strictly reduce toward the floor and actually be attempted at
    // size 1 before the call gives up — the retry budget must not be exhausted
    // purely by halving (50 -> 25 -> 12 -> 6 -> 3 -> 1).
    expect(limits.at(-1)).toBe(1);
  });

  it('redacts the access token when the network request itself rejects', async () => {
    const token = config.ig.accessToken;
    const fetchImpl = vi.fn(async () => {
      throw new Error(
        `connect ECONNREFUSED https://graph.facebook.com/v25.0/h/top_media?access_token=${token}`,
      );
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });

    let caught: Error | undefined;
    try {
      await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 50, maxPages: 5 });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(token);
    expect(caught!.message).toContain('***REDACTED***');
  });

  it('retries on a non-JSON response body instead of crashing', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return new Response('<html>502 Bad Gateway</html>', { status: 502 });
      return jsonResponse({ data: [media('a')] });
    }) as unknown as typeof fetch;

    const client = new InstagramClient({ fetchImpl, initialPageSize: 9, backoffMs: 0 });
    const res = await client.fetchHashtagMedia({ hashtagId: 'h', source: 'top', maxItems: 50, maxPages: 5 });

    expect(res.items).toHaveLength(1);
  });
});
