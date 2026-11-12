# Phase 7: 7-0 measurements

Read on 2026-11-12 (UTC), before any Phase 7 code. Every remote read is in `remote-ops.md`.

## GitHub
- `rcnsh/nusmodfinder` is **public**. Actions minutes on standard runners are free.
- `main` has **no ruleset and no branch protection**, so no check is required to merge. 7A's
  "every job always starts" is what makes a red `main` visible.
- `GITHUB_TOKEN` with `actions: read` can list a repo's workflow runs (GitHub's permissions
  reference). 7A's `changes` job uses it to find the last green `main` sha. Its first run proves
  it.
- **Job times**, from successful jobs in the last 20 `CI` runs on `main`, in minutes:

  | Job | n | Mean | Max |
  |---|---|---|---|
  | `check` | 16 | 2.6 | 3.1 |
  | `full-corpus` | 16 | 4.0 | 11.5 |
  | `sc1` | 16 | 4.3 | 5.7 |
  | `ui` (before the matrix split) | 7 | 11.3 | 17.9 |
  | `ui (chromium)` | 9 | 6.5 | 7.7 |
  | `ui (webkit)` | 8 | 8.7 | 10.0 |

  A full run's wall time is set by `ui (webkit)`, about 9 minutes.

## The ranking lock's cost
The eval runner on the Mac, at `610e0f9` on a clean tree: the dev set in three modes (filtered,
`--strip ng`, `--unfiltered`) on the pinned corpus, plus the fixture set on its own corpus, took
**21 s** in all. That is far below the plan's estimate of the lexical grid. At about 3× on a
runner, `eval:lock -- --check` costs about a minute and can run in `check` without a job of its own.

## Production schema
- Captured into `schema/*.json` (213 rows read). 7A's `schema-snapshot.mjs --compare-remote`
  compares it with the full-chain snapshot offline.
- `d1_migrations` holds ids 1–10 in the order `0001…0006, 0008_catalogue, 0007_intents,
  0009_exchange, 0010_exam_dates`. As a set this equals `migrations/0001–0010`.

## Cloudflare
- **The deploy token can read D1 over REST.** `POST …/d1/database/<id>/query` answered
  `SELECT count(*) FROM modules` = 6778. The deploy guard's read can therefore run from GitHub
  Actions through the REST query, with no `wrangler dev --remote` (G1, 7B).
- **D1 Time Travel.** Cloudflare's docs say "Database history and restoring a database incur no
  additional costs". A restore overwrites the database in place and returns a bookmark that
  undoes it. Bookmarks are valid for 30 days on Paid. `wrangler d1 time-travel info <db>` prints
  the current bookmark, which 7B records before a data deploy. A restore still rewrites the
  database, so it stays a confirmed step, but it isn't billed as rows written.
- **Workers Logs on Paid:** 20 million log events a month included, then $0.60 a million, with
  7-day retention. From 2026-12-01 they move to Observability pricing: 50 GB of ingestion and
  10 GB-month of storage included per billing cycle. At this Worker's traffic (182 requests this
  month) both stay far inside.
- **GraphQL Analytics fields** (introspected):
  - `workersInvocationsAdaptive` sums `requests`, `errors`, `subrequests`, `cpuTimeUs`,
    `wallTime`, `duration` and `responseBodySize`;
  - it has quantiles for CPU, wall time and duration (P25–P999);
  - it has dimensions including `scriptName`, `scriptVersion`, `httpResponseStatus`, `status` and
    `datetimeHour`;
  - `d1AnalyticsAdaptiveGroups` sums `readQueries`, `writeQueries`, `rowsRead` and `rowsWritten`
    by `databaseId`.

  7F's usage report needs nothing else.
- **Account-wide, 2026-11-01 to 2026-11-12 01:28** (calendar month; the subscription's renewal
  date, which starts the billing month, isn't readable with these scopes):

  | Measure | Account | Included on Paid | Share |
  |---|---|---|---|
  | Worker requests | 374,470 | 10 M | 3.7% |
  | Worker CPU | 4,364,811 ms | 30 M ms | 14.6% |
  | D1 rows read | 18,136,157 | 25 B | 0.07% |
  | D1 rows written | 579,297 | 50 M | 1.2% |

  `nusmodfinder` served 182 requests (159 × 200, 23 × 404) with 2.9 s of CPU. `nusmods-apac`
  read 926,418 rows and wrote 214,109, almost all of it from Phase 6's and the rename's
  re-ingest and guard reads.
