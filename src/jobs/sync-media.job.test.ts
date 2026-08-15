import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool, withTransaction } from '../db/pool.js';
import { upsertMedia, linkHashtagMedia } from '../db/repositories/media.repository.js';
import * as mediaRepo from '../db/repositories/media.repository.js';
import { runSyncMedia } from './sync-media.job.js';

// Dedicated hashtag for these tests. `runSyncMedia` unconditionally reclaims
// stale pending media for the hashtag it's given, and live syncs leave real
// pending/stored rows under 'matcha' — using a separate hashtag keeps that
// live data out of the reclaim sweep and out of these assertions entirely.
const hashtagName = 'sync-test-tag';
let testHashtagId: number;

const media = (id: string, permalink: string | null) => ({
  id, media_type: 'IMAGE', timestamp: '2026-08-14T18:44:40+0000', permalink,
});

function fakeQueue() {
  const calls: any[] = [];
  return {
    enqueue: vi.fn(),
    enqueueBatch: vi.fn(async (entries: any[]) => { calls.push(...entries); }),
    receive: vi.fn(),
    ack: vi.fn(),
    calls,
  };
}

beforeAll(async () => {
  const { rows } = await pool.query(
    `INSERT INTO hashtags (ig_hashtag_id, name) VALUES ('sync-test-hashtag-id', $1)
     ON CONFLICT (ig_hashtag_id) DO UPDATE SET ig_hashtag_id = EXCLUDED.ig_hashtag_id
     RETURNING id`,
    [hashtagName],
  );
  testHashtagId = Number(rows[0].id);
});

beforeEach(async () => { await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'sync-test-%'`); });
afterAll(async () => {
  await pool.query(`DELETE FROM media WHERE ig_media_id LIKE 'sync-test-%'`);
  await pool.query(`DELETE FROM hashtags WHERE ig_hashtag_id = 'sync-test-hashtag-id'`);
  await pool.end();
});

describe('runSyncMedia', () => {
  it('isolates a bad item in a page so the good items around it are still persisted', async () => {
    // Middle item violates the NOT NULL constraint on permalink. Without a per-item
    // SAVEPOINT, Postgres aborts the whole shared transaction and every item in the
    // page is silently rolled back, even though upsertMedia/linkHashtagMedia never
    // threw for items 1 and 3.
    const items = [
      media('sync-test-good-1', 'https://x/1'),
      media('sync-test-bad', null),
      media('sync-test-good-2', 'https://x/2'),
    ];

    const instagram = {
      fetchHashtagMedia: vi.fn(async (opts: any) => {
        await opts.onPage(items);
        return { items, pages: 1 };
      }),
    };
    const queue = fakeQueue();

    const result = await runSyncMedia({ queue, instagram } as any, { hashtagName, source: 'top' });

    expect(result.seen).toBe(3);
    expect(result.created).toBe(2);

    const { rows } = await pool.query(
      `SELECT id, ig_media_id FROM media WHERE ig_media_id LIKE 'sync-test-good-%' ORDER BY ig_media_id`,
    );
    expect(rows.map((r) => r.ig_media_id)).toEqual(['sync-test-good-1', 'sync-test-good-2']);

    const { rows: badRows } = await pool.query(
      `SELECT id FROM media WHERE ig_media_id = 'sync-test-bad'`,
    );
    expect(badRows).toHaveLength(0);

    expect(queue.calls).toHaveLength(2);
    const enqueuedIds = queue.calls.map((e) => e.payload.mediaId).sort((a: number, b: number) => a - b);
    const goodIds = rows.map((r) => Number(r.id)).sort((a, b) => a - b);
    expect(enqueuedIds).toEqual(goodIds);
  });

  it('re-enqueues a media row left pending with no job on the next sync run', async () => {
    const { id: mediaId } = await withTransaction((c) =>
      upsertMedia(c, {
        id: 'sync-test-orphan', media_type: 'IMAGE', timestamp: '2026-08-14T18:44:40+0000',
        permalink: 'https://x/orphan', media_url: 'https://cdn/orphan.jpg',
      } as any));
    await withTransaction((c) => linkHashtagMedia(c, testHashtagId, mediaId, 'top'));
    // asset_status defaults to 'pending' — simulates a row whose enqueueBatch call
    // failed after the page committed, so no DOWNLOAD_ASSET job was ever sent.

    const instagram = { fetchHashtagMedia: vi.fn(async () => ({ items: [], pages: 0 })) };
    const queue = fakeQueue();

    await runSyncMedia({ queue, instagram } as any, { hashtagName, source: 'top' });

    const reclaimedIds = queue.calls.map((e) => e.payload.mediaId);
    expect(reclaimedIds).toContain(mediaId);
  });

  it('does not accumulate subtransaction locks when a later statement in an item fails', async () => {
    // upsertMedia (the item's FIRST statement) always succeeds here; linkHashtagMedia
    // (a LATER statement) is forced to throw for the middle two items. This is the
    // exact shape that burns a Postgres subtransaction id: without RELEASE SAVEPOINT
    // immediately after ROLLBACK TO SAVEPOINT, the aborted subxact keeps its own
    // transactionid lock alive for the life of the outer transaction.
    const items = [
      media('sync-test-lock-1', 'https://x/1'),
      media('sync-test-lock-2', 'https://x/2'), // linkHashtagMedia forced to throw
      media('sync-test-lock-3', 'https://x/3'), // linkHashtagMedia forced to throw
      media('sync-test-lock-4', 'https://x/4'), // succeeds; probes pg_locks on its own connection
    ];

    const realLink = mediaRepo.linkHashtagMedia;
    let callCount = 0;
    let probedLockCount: number | null = null;

    const linkSpy = vi.spyOn(mediaRepo, 'linkHashtagMedia').mockImplementation(
      async (client: any, hashtagId: any, mediaId: any, source: any) => {
        callCount++;
        if (callCount === 2 || callCount === 3) {
          throw new Error(`forced link failure #${callCount}`);
        }
        const result = await realLink(client, hashtagId, mediaId, source);
        if (callCount === 4) {
          // Same backend/connection as the still-open outer transaction — this
          // reflects real subtransaction lock state, not a snapshot taken after
          // the transaction has already committed and released its client.
          const { rows } = await client.query(
            `SELECT count(*) FROM pg_locks WHERE locktype = 'transactionid' AND pid = pg_backend_pid()`,
          );
          probedLockCount = Number(rows[0].count);
        }
        return result;
      },
    );

    const instagram = {
      fetchHashtagMedia: vi.fn(async (opts: any) => {
        await opts.onPage(items);
        return { items, pages: 1 };
      }),
    };
    const queue = fakeQueue();

    try {
      const result = await runSyncMedia({ queue, instagram } as any, { hashtagName, source: 'top' });

      // Behavioural property: items after (and before) the failures still persisted;
      // the two forced-failure items did not.
      expect(result.created).toBe(2);
      const { rows } = await pool.query(
        `SELECT ig_media_id FROM media WHERE ig_media_id LIKE 'sync-test-lock-%' ORDER BY ig_media_id`,
      );
      expect(rows.map((r) => r.ig_media_id)).toEqual(['sync-test-lock-1', 'sync-test-lock-4']);

      // Direct lock-count property, measured on the transaction's own backend while
      // it is still open: bounded regardless of how many prior items failed. Two
      // forced failures should not leave two extra zombie subtransaction locks
      // behind — without RELEASE SAVEPOINT this was observed to climb with every
      // failure instead of staying flat.
      expect(probedLockCount).not.toBeNull();
      expect(probedLockCount!).toBeLessThanOrEqual(2);
    } finally {
      linkSpy.mockRestore();
    }
  });

  it('records pages_fetched from pages actually completed before a failed run, not zero', async () => {
    // Two pages commit successfully, then the client throws on a third. Previously
    // `pages` was only assigned from the client's return value on the success path,
    // so a failed run always recorded pages_fetched=0 no matter how far it got.
    const page1 = [media('sync-test-pg-1', 'https://x/1')];
    const page2 = [media('sync-test-pg-2', 'https://x/2')];

    const instagram = {
      fetchHashtagMedia: vi.fn(async (opts: any) => {
        await opts.onPage(page1);
        await opts.onPage(page2);
        throw new Error('simulated exhaustion on page 3');
      }),
    };
    const queue = fakeQueue();

    await expect(runSyncMedia({ queue, instagram } as any, { hashtagName, source: 'top' }))
      .rejects.toThrow('simulated exhaustion on page 3');

    const { rows } = await pool.query(
      `SELECT status, pages_fetched FROM sync_runs WHERE hashtag_id=$1 ORDER BY started_at DESC LIMIT 1`,
      [testHashtagId],
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].pages_fetched).toBe(2);
  });
});
