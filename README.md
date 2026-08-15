# Hashtag Media Ingestion

Tracks Instagram media for a hashtag (`matcha`): pulls it from Meta's Graph
API, stores metadata in Postgres, copies assets into durable storage, and
serves the result through one paginated `GET /hashtags` endpoint.

Full setup instructions, every environment variable, and the tradeoffs behind
each design decision are in [`instructions.md`](./instructions.md). The
complete design rationale is in
[`docs/superpowers/specs/2026-08-14-hashtag-tracking-design.md`](./docs/superpowers/specs/2026-08-14-hashtag-tracking-design.md).

## Architecture

```
                    ┌──────────────────────────────┐
   node-cron        │  worker.ts                   │
   0 */3 * * *  ───▶│                              │
                    │   scheduler ──┐              │
                    └───────────────┼──────────────┘
                                    │ enqueue
                                    ▼
                        ┌───────────────────────┐
                        │  Queue  (SQS | memory)│
                        └───────┬───────────────┘
                                │
              ┌─────────────────┴──────────────────┐
              │                                    │
     SYNC_{TOP,RECENT}_MEDIA              DOWNLOAD_ASSET
              │                                    │
     page via cursor                       stream CDN ──▶ Storage
     (adaptive limit)                              │      (S3 | local)
              │                                    ▼
     upsert media rows                     asset_status = stored
              │                                    │
              └──────────▶ Postgres ◀──────────────┘
                              │
                              ▼
                   server.ts — GET /hashtags
```

## Two entrypoints

| Entrypoint | Responsibility |
|---|---|
| `src/server.ts` | Express API. Serves `GET /hashtags`. Does no ingestion. |
| `src/worker.ts` | Cron scheduler + queue consumer. Runs syncs and downloads. No HTTP surface. |

They're separate processes because they scale on different axes and fail
independently: a wedged download must not be able to take the read API down
with it.

## Two-stage job design

`SYNC_TOP_MEDIA` / `SYNC_RECENT_MEDIA` page the Graph API, upsert media
metadata into Postgres, and enqueue one `DOWNLOAD_ASSET` job per item — they
do not download anything themselves. `DOWNLOAD_ASSET` streams the asset from
Instagram's CDN into storage independently.

This split exists because collapsing the two into one loop means a single
dead CDN link or slow video stalls or aborts the entire metadata sync, and a
retry would have to re-fetch every page from Meta just to get back to where
it left off. Splitting them means metadata is durable the moment it lands,
and each asset download retries on its own — which matters because
`recent_media` only exposes roughly a 24-hour window, so metadata that isn't
saved immediately may simply be gone by the time a sync is retried.

## Three things the Meta API actually does (not what the docs suggest)

1. **The obvious page size fails.** `limit=25` — as suggested by the
   assignment brief itself — returns `HTTP 500 {"error":{"code":1}}`. The
   real ceiling is well below that, is different per endpoint, and moves
   between measurements taken minutes apart. The client treats page size as
   an adaptive starting hint: it halves on `code:1` and holds the reduced
   size for the rest of the run rather than trusting a constant. See
   `instructions.md` → `tradeoffs`, items 1–2, for the measured numbers.

2. **Fields are not guaranteed to be present.** A real `VIDEO` item came
   back with neither `media_url` nor `like_count`, while sibling items in
   the same page had both. Every column except `id`, `media_type`, and
   `timestamp` is nullable for this reason, and "this item never had a
   downloadable asset" is a distinct, expected state (`unavailable`) — not
   an error.

3. **Asset URLs expire.** `media_url` is a signed CDN link, valid for only
   days. That's why every asset is copied into our own storage rather than
   served by reference — the stored object is canonical, and the original
   URL is kept only for provenance, never returned to API clients.

## Running it

```bash
docker compose up -d
npm install
cp .env.example .env   # paste your IG_ACCESS_TOKEN
npm run migrate up
SYNC_ON_BOOT=top npm run start:worker   # shell 1
npm run start:api                       # shell 2
curl -s 'http://localhost:3000/hashtags?hashtag=matcha&limit=3'
```

```bash
npm test   # 49 tests
```
