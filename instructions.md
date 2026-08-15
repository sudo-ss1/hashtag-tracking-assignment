# Instructions

Instagram hashtag media ingestion: pulls media for a hashtag from Meta's Graph
API, stores metadata in Postgres, copies assets into durable storage, and
serves the result through one paginated read endpoint. This file covers setup,
configuration, and the tradeoffs made along the way; `README.md` covers the
architecture and the Meta API behaviour that shaped it.

## setup

Requirements: Docker, Node.js, an Instagram Graph API access token with
Hashtag Search permissions, and an IG Business/Creator user ID with an
associated hashtag already searched (or search-eligible) for `matcha`.

```bash
# 1. Start Postgres (maps host port 5434 -> container 5432; see docker-compose.yml)
docker compose up -d

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env and paste your Instagram Graph API token into IG_ACCESS_TOKEN.
# DATABASE_URL is already set correctly for the compose file:
#   postgres://hashtag:hashtag@localhost:5434/hashtag_tracking

# 4. Run migrations
npm run migrate up

# 5. Start the worker (cron scheduler + queue consumer).
# SYNC_ON_BOOT=top enqueues one SYNC_TOP_MEDIA job immediately instead of
# waiting for the next cron tick, so the first run doesn't require a wait.
SYNC_ON_BOOT=top npm run start:worker

# 6. In a second shell, start the API
npm run start:api

# 7. Query it
curl -s 'http://localhost:3000/hashtags?hashtag=matcha&limit=3'
```

Give the worker a little time to fetch pages and enqueue downloads before
step 7 — `assetStatus` will read `pending` until the corresponding
`DOWNLOAD_ASSET` job has run, and `stored` once the asset has been copied
into storage.

Run the test suite with:

```bash
npm test
```

55 tests, all passing. Tests seed their own rows under dedicated hashtag
names, so they stay green even with live `matcha` data already in the table
(see `tradeoffs`). Tests live in a top-level `test/` directory mirroring
`src/`; `tsconfig.json` typechecks both `src` and `test`, while
`tsconfig.build.json` builds only `src`. Notably, `test/e2e/pipeline.test.ts`
drives the full pipeline end to end — fake Graph response → sync → upsert →
enqueue → download → storage → `GET /hashtags` — with no network calls.

Other scripts of note: `npm run dev:api` / `npm run dev:worker` (watch mode),
`npm run build` (runs `tsc -p tsconfig.build.json`, emitting compiled output
to `dist/` — it builds, it does not just typecheck). To typecheck everything
including tests without emitting, use `npx tsc --noEmit`.

### Running against AWS instead of the local drivers

The defaults above use the in-memory queue and local disk storage so the
project runs with no AWS account. To run the same code against real AWS,
set four variables in `.env` and restart — no code changes:

```env
QUEUE_DRIVER=sqs
STORAGE_DRIVER=s3
SQS_QUEUE_URL=https://sqs.<region>.amazonaws.com/<account-id>/<queue-name>
S3_BUCKET=<bucket-name>
```

Credentials are resolved by the AWS SDK's default provider chain
(`~/.aws/credentials`, environment variables, or an instance role) — the
application never reads or stores them itself. `AWS_REGION` applies to both
clients. Config validation fails at boot if `SQS_QUEUE_URL` or `S3_BUCKET` is
missing while its driver is selected, so a misconfiguration surfaces on
startup rather than mid-download.

To verify your own bucket and queue before running the pipeline:

```bash
npx tsx scripts/aws-smoke.ts
```

It writes a small object, fetches it back through a presigned URL, then
enqueues, receives and acks one SQS message — exercising every method both
adapters expose. Both driver pairs were verified this way against a real
bucket and queue in `eu-west-1`.

Note that `storage_key` values are driver-independent, so rows written under
one driver keep the same key under the other. If you switch `local` → `s3`
after assets have already been downloaded locally, those files need copying
into the bucket (`aws s3 sync ./storage s3://<bucket>`) or their rows reset
to `pending` for re-download; otherwise the API returns presigned URLs for
objects that are not there yet.

Tests always run against the local drivers regardless of `.env` (pinned in
`vitest.config.ts`), so the suite never requires or touches cloud resources.

## vars

All variables live in `.env.example`. None have secrets checked in; `.env` is
gitignored.

| Variable | Purpose | Required | Default |
|---|---|---|---|
| `DATABASE_URL` | Postgres connection string. | Yes | none — must be set |
| `PORT` | Port the API (`server.ts`) listens on. | No | `3000` |
| `IG_ACCESS_TOKEN` | Meta Graph API access token. Never logged — redacted from all error output before it reaches stdout or `sync_runs.error`. | Yes | none — must be set |
| `IG_USER_ID` | IG Business/Creator user ID used for Hashtag Search (Meta requires searching hashtags as a specific IG user). | Yes | none — must be set |
| `IG_API_VERSION` | Graph API version pinned in every request URL. | No | `v25.0` |
| `IG_GRAPH_BASE_URL` | Graph API host. Overridable for testing against a mock. | No | `https://graph.facebook.com` |
| `IG_PAGE_SIZE` | Starting page size for both `top_media` and `recent_media` requests. Treated as a starting hint, not a guarantee — see `tradeoffs`. | No | `9` |
| `SYNC_MAX_ITEMS` | Hard cap on items ingested per sync run, so a run terminates even if the cursor keeps producing pages. | No | `500` |
| `SYNC_MAX_PAGES` | Hard cap on pages fetched per sync run, independent of `SYNC_MAX_ITEMS` (guards against a pathological cursor loop). | No | `120` |
| `QUEUE_DRIVER` | Selects the `Queue` implementation: `sqs` (AWS) or `memory` (in-process, for local runs with no AWS account). | No | `memory` |
| `STORAGE_DRIVER` | Selects the `Storage` implementation: `s3` (AWS) or `local` (disk, served via `/assets/:key`). | No | `local` |
| `AWS_REGION` | AWS region for both SQS and S3 clients. | No (required in practice if `QUEUE_DRIVER=sqs` or `STORAGE_DRIVER=s3`) | `ap-south-1` |
| `SQS_QUEUE_URL` | SQS queue URL. **Required when `QUEUE_DRIVER=sqs`** — config validation (zod, at boot) fails startup if it is missing in that case. | Conditional | none |
| `S3_BUCKET` | S3 bucket name. **Required when `STORAGE_DRIVER=s3`** — config validation fails startup if it is missing in that case. | Conditional | none |
| `S3_PREFIX` | Key prefix under which assets are written in S3 (driver-independent — see `tradeoffs`). | No | `hashtag-media` |
| `LOCAL_STORAGE_DIR` | Directory the `local` storage driver writes into and the API serves `/assets/:key` from. | No | `./storage` |

## tradeoffs

Each item states the observed behaviour, why it is that way, and what fixing
it would take. Organised by category.

### Meta API reality

1. **The documented-looking `limit=25` request fails.** The obvious call —
   `limit=25`, as in the assignment's own example — returns
   `HTTP 500 {"error":{"code":1,"message":"Please reduce the amount of data you're asking for, then retry your request"}}`.
   Measured ceilings: `top_media` reproducibly failed at `limit=10` and
   succeeded at `9` (3/3 attempts each way); `recent_media` succeeded at
   `limit=10` on 3/3 attempts. These ceilings moved between measurements
   taken minutes apart, so they read as **load-shedding thresholds**, not a
   documented cap. Fix: the client treats the configured page size as a
   starting hint, not a contract — on `code:1` it halves the page size and
   retries, then holds the reduced size for the rest of the run rather than
   oscillating back up.

2. **Throttling is endpoint-specific, not a single number.** In one measured
   run, a `top_media` sync fetched **120 pages for 194 items** (~1.6
   items/page against a configured page size of 9 — constant backoff and
   halving), while a `recent_media` sync in the same window pulled **369
   items with zero backoff events**. Documenting a single "safe page size"
   would be wrong for one endpoint or the other. Fix: nothing further is
   planned here beyond the adaptive client already in place — a fixed
   number would just be wrong again the next time Meta's load changes.

3. **Fields are not guaranteed present.** A real `VIDEO` item came back with
   neither `media_url` nor `like_count`, while sibling items in the same
   page had both. This is why every column except `id`, `media_type` and
   `timestamp` is nullable, and why there is a distinct `unavailable` asset
   state (never had a URL to download) separate from `failed` (transient,
   retryable).

4. **`media_url` is a short-lived signed CDN link.** It expires within days.
   This is the entire reason assets are copied into our own storage rather
   than served by reference: the stored object is canonical, and the
   original `source_media_url` is kept only for provenance/debugging — it
   is never returned to API clients.

5. **Pagination follows `paging.cursors.after`, never `paging.next`.**
   `paging.next` is a fully-formed URL with the access token embedded in the
   query string. Following it would leak the token into logs, error
   messages, and the `sync_runs.error` column. Using the cursor value keeps
   the token confined to the one place that injects it (the request
   builder).

6. **Hashtag Search is capped at 30 unique hashtags per 7 days, per IG
   user.** Only `matcha` is used here, so this cap is not hit, but it would
   directly shape any multi-hashtag version — you cannot simply add
   hashtags on demand at scale.

7. **The Hashtag Search API does not return an owner or username.** Media
   returned from `top_media`/`recent_media` cannot be attributed to an
   Instagram account through this API. This is a platform limitation, not
   an oversight — attributing a post to an account would require a
   separate lookup Meta does not expose here.

### Schema decisions

8. **`media_type` is `TEXT`, not a Postgres enum.** Today's known values are
   `IMAGE`, `VIDEO`, `CAROUSEL_ALBUM`. If Meta introduces a new type
   tomorrow, an enum would make the `INSERT` throw and the item would be
   silently dropped from the sync. `asset_status`, by contrast, *is* an
   enum — that vocabulary is ours, not Meta's, so we control every value
   that can appear.

9. **The untouched Graph response is kept in a `raw jsonb` column.** A later
   "we also want field X" becomes a backfill over data already held,
   instead of a re-fetch against a rate-limited API. For `recent_media`
   this isn't just convenient — it's the only option, since its ~24-hour
   window will have moved on by the time a re-fetch is needed.

10. **`hashtag_media` has PK `(hashtag_id, media_id, source)`.** This is a
    design property, not something the current dataset demonstrates: a post
    genuinely can surface via both `top_media` and `recent_media`, and the
    composite key means both sightings get their own row rather than one
    overwriting the other — preserving which endpoint(s) actually surfaced
    it, whenever that overlap happens to occur.

11. **Engagement counts are overwritten on re-sync, not versioned.** `like_count`
    and `comments_count` reflect only the most recent sync. A
    `media_metric_snapshots` table (one row per sync per media) is the
    obvious extension for tracking engagement over time — it was not asked
    for, so it isn't built.

### Known limitations

12. **`GET /hashtags` sorts by the media's Instagram `timestamp`, not our
    row's `created_at`.** The brief's "descending order of creation time"
    reads both ways — when the post was created on Instagram, or when we
    ingested it. We chose Instagram's timestamp: it's what makes a hashtag
    feed meaningful, since a backfill would otherwise interleave old posts
    at the top purely because they were ingested late. Flagging this
    explicitly as an interpretation, not a certainty.

13. **Carousel (`CAROUSEL_ALBUM`) children are not expanded.** Only the
    top-level asset is captured; the `children` sub-media are not fetched
    or stored. Cut for scope.

14. **No dead-letter queue.** Failed and orphaned rows are recovered by a
    bounded reclaim step at the start of each sync (`releaseStaleClaims` +
    `findReclaimableMediaIds`), backed by a partial index on
    `asset_status IN ('pending', 'failed')`. There is no separate sweeper
    process with its own backoff schedule — recovery only happens when the
    next sync runs. A dedicated sweeper is the natural next step.

15. **`asset_attempts` is capped at 5 (`MAX_ASSET_ATTEMPTS`).** Earlier
    revisions of this document claimed nothing retried a `failed` row on a
    loop — that was wrong. The reclaim step (item 14) runs at the start of
    every sync and re-enqueues every `pending`/`failed` row for the
    hashtag, and the in-memory/SQS queue redelivers an unacked message on
    its own visibility timeout independently of that — so a permanently-dead
    CDN URL was retrying forever, with `asset_attempts` climbing without
    bound (reproduced: 6 visibility-timeout ticks produced
    `asset_attempts=6`). `claimForDownload` and `findReclaimableMediaIds`
    now both exclude rows at or past the cap; such a row stays `failed`
    permanently rather than being reclaimed again. A future retry sweeper
    that wants to give a row another chance would need to explicitly reset
    `asset_attempts`, and should have a reason to believe the underlying
    condition (e.g. a dead CDN URL) has actually changed before doing so.

16. **Rate-limit headers are not parsed.** `x-business-use-case-usage` is
    present on Graph responses but unused; backoff is reactive (respond to
    `code:1`/5xx/429 after the fact) rather than budgeted ahead of time
    from the header's usage percentages.

17. **No authentication on `GET /hashtags`.** The endpoint is open. Out of
    scope for this assignment; would need an API key or session auth
    before any real deployment.

18. **An interrupted worker leaves its `sync_runs` row at `status='running'`
    with no reaper to close it out.** There's no process that notices a
    `running` row whose worker died and marks it failed/timed-out. The
    reclaim path (item 14) re-enqueues affected media rows on the next
    sync regardless, so ingestion recovers even if the audit row itself
    stays stale. The shipped database's current state — some `media` rows
    at `asset_status='pending'` alongside `sync_runs` rows that completed —
    is the honest record of running this system as a time-boxed demo
    rather than a long-lived service; nothing is hidden or reset before
    submission.

19. **Tests run against the same database as the app, not a separate test
    database.** They stay isolated by seeding their fixtures under their
    own dedicated hashtag names rather than `matcha`, so they pass cleanly
    even with several hundred live `matcha` rows already present — verified
    by running the suite against the populated database, not a clean one.

20. **Postgres is mapped to host port 5434, not 5432.** `docker-compose.yml`
    maps `5434:5432` because the default port (and 5433) were already
    occupied by unrelated services on the development machine. Nothing
    inside the container changes; only the host-side port differs.

21. **The worker is a single, strictly serial consumer.** One process pulls
    a batch and processes each message one at a time in a plain `for` loop,
    with no concurrency and no separate pool for `SYNC_*` vs.
    `DOWNLOAD_ASSET` jobs — so a slow or throttled sync blocks every
    download behind it. Observed directly: a throttled `top_media` sync
    took roughly 13 minutes, during which zero `DOWNLOAD_ASSET` jobs ran,
    even though downloads were already queued. Splitting sync and download
    onto separate consumers (or adding concurrency within one) is the
    natural fix and was not done here for scope reasons.

### Design choices worth noting

22. **Queue and Storage are interfaces with two working implementations
    each** (SQS/S3 for AWS, in-memory/local-disk for local runs), selected
    by `QUEUE_DRIVER`/`STORAGE_DRIVER`. Both pairs are fully implemented,
    not one real implementation plus a stub — that's the only way the
    interface boundary is actually proven to hold. The in-memory queue
    implements a visibility timeout so it redelivers unacked messages the
    same way SQS does; without that, retry behaviour could never be
    exercised locally at all.

23. **Storage keys use a driver-independent prefix.** Switching
    `STORAGE_DRIVER` from `local` to `s3` (or back) does not orphan
    existing `storage_key` values, because the key format doesn't encode
    which driver wrote it. `Storage.exists()` was removed from the
    interface (and both implementations) after review found it had no
    production caller — `claimForDownload`'s status guard already prevents
    re-downloading a stored asset, so the method was dead code.

24. **The read API uses keyset pagination, not `LIMIT`/`OFFSET`.** Rows land
    at the top of the sort order continuously as syncs run, and offset
    paging would re-show page-1 rows on page 2 once new rows arrive
    mid-pagination. The cursor is `(ig_timestamp, id)`, with `id` as the
    tiebreaker because Instagram timestamps are not unique in real Meta
    data — several items in a sampled page shared a timestamp to the
    second.

## ai-usage

I used Claude Code (Claude Opus) throughout this assignment: to probe the
live Graph API and establish its real behaviour before designing anything;
to write a design spec and a task-by-task implementation plan from those
findings; to implement each task in the plan; and to run an adversarial code
review after every task, where each finding was checked against the live
database (not taken on faith) before being accepted or rejected.

That review process caught and fixed several material defects, including:

- A per-item `try`/`catch` inside a single database transaction that did not
  actually isolate failures — Postgres aborts the entire transaction on the
  first error inside it regardless of the surrounding `catch`, so one bad
  item would have silently discarded the whole batch. Fixed with
  per-item savepoints.
- Unwrapped error paths (network errors, non-JSON responses) that could
  leak the raw access token into logs or the `sync_runs.error` column
  before token redaction was applied consistently to every error path.
- An upsert that refreshed volatile fields (like counts, caption) but never
  refreshed the expiring `source_media_url` on re-sync — which would have
  made a retry of a `failed` download permanently useless, since it would
  keep retrying against a CDN URL that had already expired by the time of
  the retry.

### What I did myself

- **Established the API's real behaviour before any code existed.** I ran the
  assignment's own `curl` commands against the live Graph API and found that
  the suggested `limit=25` returns `HTTP 500 code:1`. I binary-searched the
  boundary per endpoint — `top_media` serves `limit=9` and fails at `10`,
  `recent_media` tolerates more — and found the ceilings had moved when I
  re-measured minutes later. I also noticed responses come back tagged
  `facebook-api-version: v25.0` even when `v24.0` is requested, which is why
  the client pins `v25.0` explicitly. Those measurements, not the
  documentation, drove the adaptive page-size client, the nullable columns,
  and the separate `unavailable` asset state.

- **Chose and provisioned the infrastructure.** AWS SQS and S3, with the
  local in-memory and disk drivers kept fully working so the project runs
  without credentials — which is what makes the swappable-adapter
  requirement demonstrable rather than asserted.

- **Directed the review and verified the results against the live system.**
  Every finding was checked against the real database or the real API before
  being accepted — a claim that an index was unused, for example, was
  disproved by running `EXPLAIN ANALYZE`. Two statements I had written into
  this file turned out to be false when queried and were corrected rather
  than left standing; both are still recorded below under `tradeoffs`
  (items 10 and 15).

- **Ran the pipeline against the live API and verified the output myself** —
  media rows in Postgres, asset files on disk matching the database count,
  and `GET /hashtags` returning resolvable `assetUrl`s.

- **Set the engineering standards the work had to meet**: one query per
  request on the read path (now enforced by a regression test), tests that
  stay green with live data present, and a commit history where every commit
  ends in a passing suite.

`ai-usage/README.md` describes the method in more detail, including the
defects the review process caught and how each was verified before being
accepted.
