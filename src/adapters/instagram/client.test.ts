import { describe, it, expect, vi } from 'vitest';
import { InstagramClient } from './client.js';

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
});
