import { config, redact } from '../../config/index.js';
import type { GraphPage, IgMedia, MediaSource } from './types.js';

export * from './types.js';

const FIELDS = 'id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count';
const MIN_PAGE_SIZE = 1;
const MAX_ATTEMPTS_PER_PAGE = 5;

export class GraphApiError extends Error {
  constructor(message: string, readonly code?: number, readonly status?: number) {
    super(redact(message));
    this.name = 'GraphApiError';
  }
}

type Deps = { fetchImpl?: typeof fetch; initialPageSize?: number; backoffMs?: number };

export class InstagramClient {
  private fetchImpl: typeof fetch;
  private initialPageSize: number;
  private backoffMs: number;

  constructor(deps: Deps = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.initialPageSize = deps.initialPageSize ?? config.ig.pageSize;
    this.backoffMs = deps.backoffMs ?? 500;
  }

  private url(hashtagId: string, source: MediaSource, limit: number, after?: string): string {
    const u = new URL(`${config.ig.graphBaseUrl}/${config.ig.apiVersion}/${hashtagId}/${source}_media`);
    u.searchParams.set('user_id', config.ig.userId);
    u.searchParams.set('fields', FIELDS);
    u.searchParams.set('limit', String(limit));
    u.searchParams.set('access_token', config.ig.accessToken);
    if (after) u.searchParams.set('after', after);
    return u.toString();
  }

  async fetchHashtagMedia(opts: {
    hashtagId: string;
    source: MediaSource;
    maxItems: number;
    maxPages: number;
    onPage?: (items: IgMedia[]) => Promise<void>;
  }): Promise<{ items: IgMedia[]; pages: number }> {
    const items: IgMedia[] = [];
    let pageSize = this.initialPageSize;
    let after: string | undefined;
    let pages = 0;

    while (pages < opts.maxPages && items.length < opts.maxItems) {
      let page: GraphPage | undefined;

      for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_PAGE; attempt++) {
        const res = await this.fetchImpl(this.url(opts.hashtagId, opts.source, pageSize, after));
        const body = (await res.json()) as GraphPage & { error?: { code?: number; message?: string } };

        if (res.ok && !body.error) { page = body; break; }

        const code = body.error?.code;
        // code:1 is Meta shedding load at this page size — shrink and retry.
        if (code === 1 && pageSize > MIN_PAGE_SIZE) {
          pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
          continue;
        }
        if (res.status >= 500 || res.status === 429) {
          await this.sleep(this.backoffMs * 2 ** attempt * (1 + Math.random()));
          continue;
        }
        throw new GraphApiError(body.error?.message ?? `Graph request failed (${res.status})`, code, res.status);
      }

      if (!page) throw new GraphApiError(`Exhausted retries for ${opts.source}_media page ${pages + 1}`);

      pages++;
      const batch = page.data ?? [];
      const room = opts.maxItems - items.length;
      const accepted = batch.slice(0, room);
      items.push(...accepted);
      if (opts.onPage && accepted.length) await opts.onPage(accepted);

      // Deliberately the cursor, never paging.next — that URL carries the access token.
      after = page.paging?.cursors?.after;
      if (!after || batch.length === 0) break;
    }

    return { items, pages };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
