import { config, redact } from '../../config/index.js';
import type { GraphPage, IgMedia, MediaSource } from './types.js';

export * from './types.js';

const FIELDS = 'id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count';
const MIN_PAGE_SIZE = 1;
const MAX_ATTEMPTS_PER_PAGE = 5;
// Belt-and-braces cap on total iterations (halvings + attempts) per page, so a
// pathological server response can never spin the loop forever even if the
// attempt/halving accounting above has a bug.
const MAX_ITERATIONS_PER_PAGE = 64;

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
    /**
     * Called with each page's accepted items, awaited before the next page is fetched.
     * If it throws, fetchHashtagMedia rejects and returns NO partial result — callers
     * must treat onPage as the durable side effect (rows are committed per page), not
     * rely on the returned items[] on failure.
     */
    onPage?: (items: IgMedia[]) => Promise<void>;
  }): Promise<{ items: IgMedia[]; pages: number }> {
    const items: IgMedia[] = [];
    const startPageSize = this.initialPageSize;
    let pageSize = this.initialPageSize;
    let after: string | undefined;
    let pages = 0;

    while (pages < opts.maxPages && items.length < opts.maxItems) {
      let page: GraphPage | undefined;
      let lastError: GraphApiError | undefined;
      let attempt = 0;
      let iterations = 0;

      // A `for` loop's `continue` auto-increments the counter, which would make a
      // code:1 halving consume retry budget it shouldn't. Use `while` so halving
      // (a bare `continue`) and attempt-consuming backoff are decoupled: only the
      // 5xx/429/network/non-JSON branches below advance `attempt`.
      while (attempt < MAX_ATTEMPTS_PER_PAGE) {
        iterations++;
        if (iterations > MAX_ITERATIONS_PER_PAGE) {
          throw (
            lastError ??
            new GraphApiError(
              `Exceeded iteration cap for ${opts.source}_media page ${pages + 1} at page size ${pageSize}`,
            )
          );
        }

        let res: Response;
        try {
          res = await this.fetchImpl(this.url(opts.hashtagId, opts.source, pageSize, after));
        } catch (err) {
          // Network-level failure. The message may embed the request URL (and the token).
          lastError = new GraphApiError(`network error: ${(err as Error).message}`);
          await this.sleep(this.backoffMs * 2 ** attempt * (1 + Math.random()));
          attempt++;
          continue;
        }

        let body: GraphPage & { error?: { code?: number; message?: string } };
        try {
          body = (await res.json()) as GraphPage & { error?: { code?: number; message?: string } };
        } catch {
          // Non-JSON body (e.g. an HTML gateway error page). Retryable, not fatal.
          lastError = new GraphApiError(`non-JSON response (HTTP ${res.status})`, undefined, res.status);
          await this.sleep(this.backoffMs * 2 ** attempt * (1 + Math.random()));
          attempt++;
          continue;
        }

        if (res.ok && !body.error) { page = body; break; }

        const code = body.error?.code;
        const message = body.error?.message ?? `Graph request failed (${res.status})`;

        // code:1 is Meta shedding load at this page size — shrink and retry. This
        // is progress, not a failed attempt, so it must not consume the budget.
        // A brief, fixed sleep (not the exponential/jittered backoff below, and not
        // counted against the attempt budget) keeps a halving cascade from firing
        // 9->4->2->1 back-to-back at the exact moment Meta is already shedding load.
        if (code === 1 && pageSize > MIN_PAGE_SIZE) {
          const reduced = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
          console.warn(`[ig] ${opts.source}_media: Meta returned code:1 at limit=${pageSize}; reducing to ${reduced}`);
          pageSize = reduced;
          lastError = new GraphApiError(message, code, res.status);
          await this.sleep(this.backoffMs);
          continue;
        }
        if (res.status >= 500 || res.status === 429) {
          lastError = new GraphApiError(message, code, res.status);
          await this.sleep(this.backoffMs * 2 ** attempt * (1 + Math.random()));
          attempt++;
          continue;
        }
        throw new GraphApiError(message, code, res.status);
      }

      if (!page) {
        const cause = lastError?.message ?? 'unknown error';
        throw new GraphApiError(
          `Exhausted retries for ${opts.source}_media page ${pages + 1} at page size ${pageSize}: ${cause}`,
          lastError?.code,
          lastError?.status,
        );
      }

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

    console.log(
      `[ig] ${opts.source}_media: fetched ${pages} page(s), ${items.length} item(s); ` +
      `page size ${startPageSize} -> ${pageSize}`,
    );
    return { items, pages };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
