# AI usage

This folder contains the working session for this assignment.

`claude-code-session.md` is the full, unedited transcript (274 messages), with the
Instagram access token, contact details, and unrelated file paths redacted. Tool-call
payloads are elided — the git history is the authoritative record of what was written.

## How the assignment was built

**Measure first, design second.** Before writing any code, I ran the Graph API calls
from the brief to find out how the endpoints actually behave. That immediately
contradicted the brief: the suggested `limit=25` returns `HTTP 500 code:1`, and the
working page size differs per endpoint and *moves between calls minutes apart*. Every
significant design decision downstream — the adaptive page-size client, the nullable
columns, the separate `unavailable` asset state — traces back to something measured
rather than assumed.

**Spec, then plan, then implement.** The design spec
(`docs/superpowers/specs/`) argues from those measurements. The implementation plan
(`docs/superpowers/plans/`) breaks it into tasks, each ending in a test and a commit.

**Adversarial review after every task.** Each task was reviewed against the live
database rather than by inspection alone, with the reviewer explicitly asked to try to
break the code — not to confirm it worked.

## What the review process caught

The most useful part of the transcript is the defects found *in the design I had
written*, before they reached the final code. Three worth reading:

| Defect | Why it mattered |
|---|---|
| A per-item `try`/`catch` inside one shared transaction, described in the spec as "per-item error isolation" | It isolated nothing. Postgres aborts the whole transaction on the first error, so one bad item silently discarded the entire page while reporting success. Reproduced live — 3 items in, `created: 1` reported, **zero rows persisted**. Fixed with per-item savepoints. |
| Unwrapped `fetch` and `res.json()` error paths | A network error or an HTML error page could carry the access token out of the client unredacted, and a non-JSON body crashed the run instead of retrying. |
| An upsert that never refreshed `source_media_url` | Meta's CDN links expire within days. A failed download would retry forever against a dead URL, so the documented retry path would have silently never worked. |

Each was verified before being accepted, and each has a regression test that fails
against the pre-fix code. Where a proposed fix was wrong, that is in the transcript
too — an unconditional URL refresh would have *nulled out* good URLs whenever Meta
omitted the field, which is why the final fix uses `COALESCE`.

## What was decided rather than generated

Judgement calls are recorded with reasoning, including where I overrode my own spec.
The clearest example: the spec deferred a retry sweeper as out of scope, but once it
emerged that rows could be stranded at `pending` (enqueue failing after commit) or
`downloading` (worker crash) — invisible to the recovery index in both cases — that
stopped being a missing feature and became a correctness hole. A bounded reclaim was
added inside the existing sync rather than as new infrastructure.

`instructions.md` under `tradeoffs` lists what was consciously left out, and why.
