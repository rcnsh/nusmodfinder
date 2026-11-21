# 0004: Stay inside the Workers Paid allowances; no overage

Status: accepted.

## Context
The Cloudflare account is on Workers Paid ($5 a month). Its allowances are per account, shared
with the owner's other projects. On Paid, going over an allowance is **billed**, not refused, and
nothing in Cloudflare stops Workers AI or D1 spending automatically. Monthly allowances reset on
the subscription renewal day, not at 00:00 UTC.

| | included | above it |
|---|---|---|
| D1 rows read | 25 billion / month | $0.001 / million |
| D1 rows written | 50 million / month | $1.00 / million |
| Vectorize queried dims | 50 million / month | $0.01 / million |
| Vectorize stored dims | 10 million | $0.05 / 100 million |
| Workers AI | 10,000 neurons / day | $0.011 / 1,000 neurons |
| Worker CPU | 30 million CPU-ms / month; 30 s per request by default | billed per million CPU-ms |
| D1 Time Travel | 30 days | — |

## Decision
- **No spending.** The project never runs up an overage. Every allowance above is a hard limit
  for design and operations, even though Cloudflare would bill rather than refuse.
- **Headroom before a remote D1 write.** Estimate it, check the month's account-wide usage, and
  proceed only if `estimate × 1.5` fits in the month's remaining included writes. Log every
  remote operation (run records, ADR 0011).
- **Measure on a small batch** before any forced or full re-ingest, and keep live checks light
  (at least 4 s between requests).
- **At most one forced re-ingest or corpus embed per UTC day.** A forced re-ingest spends about
  2,400 of the account's 10,000 daily neurons; searches need the rest.
- **No corpus embed or forced re-ingest in a week the site is announced**, so visitors' searches
  have the day's neurons.
- **A Cloudflare budget alert** at the lowest amount emails the day after a billed day. It caps
  nothing; the rules above are what keep the project inside the allowances.

## Consequences
- The binding limits are Workers CPU and the shared daily neurons (docs/cost.md has the
  arithmetic); D1 reads and Vectorize are far from theirs since dense search runs in the Worker
  (ADR 0006).
- Ingest's `--write-budget` (40,000 rows, ADR 0002) is a runaway guard well inside the monthly
  write allowance; a cold load passes a larger budget explicitly.
- The per-IP rate limits and the cross-site refusal (ADR 0012) protect the neurons from scripts
  and other sites; they don't protect against traffic spread over many addresses.

## In the code
**Neurons**
- The eval's embedding budget (`eval/lib/embeddings.mjs`) prices `bge-small-en-v1.5` at
  `NEURONS_PER_M_TOKENS` (1,841 per million input tokens) and counts tokens with `estimateTokens`,
  which over-estimates on purpose: WordPiece without its vocabulary, one token per punctuation mark
  and short word and more for long words and digit runs, never below characters / 4, capped at
  bge's 512. An estimate that undercounts lets a run pass the cap and spend past the day's
  allowance.
- `scripts/embed.mjs` estimates each run's neurons before its first call and refuses above the cap
  (`CORPUS_CAP`, 2,500, for a corpus pass). `gate()` starts the run record, so every exit after it
  leaves one, and every branch that calls `embedAll`/`embedBatch` calls `gate()` first
  (`test/run-record.node.test.js`). It checkpoints after each batch, so a failure never re-spends
  neurons on texts already embedded. It runs only locally, reads the token from
  `wrangler auth token` each run and never stores or prints it; its record holds counts, never
  query text.
- `runIngest`'s `send` (`scripts/ingest-core.mjs`) retries a 429 or 5xx with exponential backoff
  (`maxAttempts`, 5): Workers AI throttles under load, and a failed batch would be left for a rerun
  that spends the same neurons again.
- The catalogue (`catalogue_only`, GET/POST `/admin/catalogue`) touches neither Workers AI nor
  Vectorize, so ingest loads it in D1-only mode too, and a catalogue refresh spends no neurons or
  Vectorize writes.
- `test/ui/worker.js` wraps `src/index.js` with fakes for every binding `test/wrangler.ui.jsonc`
  leaves out: `FakeAI` reproduces the fixture bundle's embedder, so hybrid search runs both halves
  and no-signal can occur, and the rate limits allow everything. No metered service is bound, so
  the UI stack's `wrangler dev` makes no remote call.

**D1 writes**
- Ingest charges a cold insert `writesPerInsert` + `ftsWritesPerInsert` (8 + 14 = 22 rows) and a
  rewrite with unchanged FTS text `writesPerUpdate` (5.5), rounded up per batch, whenever that is
  more than D1 reports (`scripts/ingest-core.mjs` `DEFAULTS`): local D1 doesn't report the FTS
  writes, so charging only the report would let a run overrun the budget.
- `estimateWrites` (`scripts/remote-migration.mjs`) adds every new index's entries (a partial
  index's rows under its `WHERE`) to `total_changes()`: `CREATE INDEX` is not DML and SQLite doesn't
  count it, but D1 bills those entries as rows written.

**Live requests and other spending**
- The live checks keep the 4 s spacing (`GAP_MS`) as a hard rule: `createPacer`
  (`scripts/live-check.mjs`) and `paced` (`scripts/live-shortlist.mjs`) re-check the clock when a
  timer fires and wait again, because a timer can fire a millisecond early. Each JSONL log line's
  `at` is the send time, not the answer's, so the log itself shows the spacing. The live check
  queues the API requests the page waits on before its files, so none waits past the page's 10 s
  fetch timeout.
- `scripts/reviews.mjs` `score` caps spend at `--max-usd` by estimating each request high before
  sending it (input written to cache at 3.6 ASCII characters a token and 1.5 tokens per other
  character, 400 output tokens per comment), and counts as spent the answered requests' usage, the
  estimates of those in flight and those of requests that failed with no answer, since a failed
  request may still have billed. The run record counts the failures for the same reason.
- `scripts/ops-report.mjs` `USAGE_QUERY` asks the per-Worker dataset with no dimension but the
  script, so the one group it returns carries the month's CPU quantiles; `parseUsage` refuses
  several groups, since quantiles from separate groups can't be merged into a month's p50 or p99.
  Workers datasets filter on `datetime`, D1 and Workers AI on `date`.
