# Phase 1 plan — backend correctness and pipeline (draft r1)

Goal (exit): SC6 and SC7 met and measured; README cost section corrected; B1–B9, O3 fixed.
SC6: no known recall bug from filters; re-ingest catches every field change and deletes dropped
modules; a forced full re-ingest stays < 10% of the daily D1 read limit (500k rows), measured.
SC7: search p50 server time < 250 ms on a cache miss (Server-Timing, deployed Worker); graceful
keyword-only fallback if Workers AI or Vectorize fails.

Constraint: Phase 1 is **ranking-neutral**. Ranking changes belong to Phase 3 behind the eval gate.
Any change that alters which documents a query returns (other than fixing B1/B8 recall bugs and
the fallback path) is out of scope. The Phase 2 eval harness (parallel) is used as a regression
check that Phase 1 left rankings unchanged except where a recall fix explains the difference.

## Facts gathered
- D1 primary is in **WEUR**; read replication **disabled**; users are in/around Singapore. Every
  D1 round trip from a SIN colo is a Europe round trip. Measured live: hybrid cache-miss 0.9–1.4 s
  wall (incl. ~50 ms network), `/module` 0.24–0.72 s.
- Read replication (Sessions API) is free, puts a replica in APAC, billed identically by rows; can
  be disabled (takes ≤24 h). Without `withSession()` all queries go to the primary.
- Vectorize: 6,771 vectors, 8/10 metadata indexes used.
- Remote `rows_read_24h` currently ~52k.

## Workstreams
### 1A Schema + FTS (migration 0006, 0007)
- **0006_fts_external.sql**: drop the 3 triggers and `modules_fts`; recreate as external-content
  `fts5(code, title, description, content='modules', content_rowid='rowid', tokenize='porter unicode61', prefix='2 3 4')`,
  `INSERT INTO modules_fts(modules_fts) VALUES('rebuild')`, restore rank config
  `bm25(0.0, 3.0, 1.0)` (code weight 0 so ranking is unchanged), triggers keyed on rowid using the
  FTS `'delete'` command with old values. `code` becomes indexed and prefix indexes exist so
  Phase 3 needs no second remote rebuild, but **Phase 1 queries use a column filter
  `{title description} : (…)`**, so match sets and bm25 are unchanged.
  Rowid stability: `modules` is a rowid table (TEXT PK, not WITHOUT ROWID); `ON CONFLICT DO UPDATE`
  keeps the rowid; DELETE + reinsert gets a new rowid and the triggers handle both.
- **0007_semesters.sql**: denormalised filter columns on `modules`: `sem1..sem4 INTEGER`,
  `ng_sem1, ng_sem2 INTEGER` (NG list only covers Sem 1/2), `row_hash TEXT`,
  backfilled from the JSON columns via `json_each` in the migration (one UPDATE, est. 6,771 rows
  written + index writes). Indexes: none at first (filters are applied to FTS-joined rows, not
  scanned); revisit if EXPLAIN shows scans.
- Remote bootstrap of `d1_migrations` (ADR 0001) immediately before: time-travel bookmark noted,
  then one execute with wrangler's DDL + `INSERT OR IGNORE` 0001–0005.
- **Cost plan (must be measured before the remote run):** run 0006+0007 locally on the full
  corpus with `--json` and record `rows_read/rows_written` per statement; remote estimate =
  local × 1.0 (same SQLite). Abort criterion: estimate > 150k rows written (daily cap 100k →
  split across two UTC days: 0006 day 1, 0007 day 2). Then run remotely and log actuals.
- Then the **small-batch measurement** required before any forced/full re-ingest: re-ingest 10
  modules with `--force --only <codes>` against the remote (via `wrangler dev --remote` with the
  ingest secret, local only), record rows read/written per row, extrapolate ×677 to a full forced
  run. Proceed to a full forced re-ingest only if the extrapolation is < 250k rows read and
  < 60k rows written.

### 1B Search request path (`src/`)
- **B1** filters in SQL: `JOIN modules m ON m.rowid = modules_fts.rowid WHERE … AND m.sem{n} = 1`
  (and `ng_sem{n}` when exchange+sem; P1 per-semester eligibility itself is Phase 4, but the
  columns land here). Limit applied after filtering. Cost: with any filter the FTS top-N path
  can't be used, so rows read ≈ match count; measured locally for the worst common queries
  ("management", "introduction") and accepted if < 2k rows/search.
- **B4** parallel: `Promise.all([D1 batch(pin lookup, FTS), embed→Vectorize])`, then one hydrate
  query selecting only rendered columns. D1 via `env.DB.withSession('first-unconstrained')` for
  all reads. **Enable D1 read replication** (`mode: auto`) — ADR 0002, with before/after
  `served_by_region` + Server-Timing evidence. Vectorize `returnMetadata` dropped (unused) →
  topK ceiling 100.
- **B5** top-level try/catch in `fetch` → JSON 500 with request id; `decodeURIComponent` guarded →
  400; upstream timeouts (AI 1.5 s, Vectorize 1.5 s, D1 3 s) via `Promise.race` + AbortSignal
  where supported.
- **B6** fallback: if AI or Vectorize throws/times out in hybrid mode, return lexical-only with
  `degraded: {reason, source}` in the body and `Server-Timing`; degraded responses cached ≤ 60 s.
  `mode=vector` still fails loudly (eval needs that).
- **B7** cache key: canonical URL built from parsed, validated params only (q trimmed, internal
  whitespace collapsed, lower-cased; params sorted; defaults omitted; unknown params dropped) +
  `data_version`. Junk params no longer create entries.
- **B8** `topK=` empty → default; hydrate selects only rendered columns; Unicode-aware
  tokeniser (`\p{L}\p{N}`, NFKD + strip combining marks) so "naïve" → `naive`.
- **acad_year**: `ACAD_YEAR` var in wrangler.jsonc; hydrate and FTS join filter on it.
- **Server-Timing**: `pin, embed, vector, fts, hydrate, total` + `cache;desc=hit|miss`. Structured
  JSON logs per search: timings, counts, D1 `rows_read`, `served_by_region`, degraded flag.
- **Versioning**: `COMMIT_SHA` var set at deploy (`wrangler deploy --var COMMIT_SHA:<sha>
  --message <sha>`), returned as `x-app-version` header and in `/health`.

### 1C Ingest pipeline (`scripts/`, admin routes)
- **row_hash** over the full normalised row (every column D1 stores + NG semesters +
  vector metadata); `text_hash` kept for embed text. Rules: text changed → re-embed + upsert
  vector + D1; only row changed → D1 update + Vectorize metadata re-upsert (needs values: re-embed,
  cheap) ; unchanged → skip. `/admin/hashes` returns both.
- **Deletes**: codes in D1 but not in the current corpus → `/admin/delete` removes from D1 and
  `VECTORIZE.deleteByIds`. Guard: refuse if > 5% of rows would go unless `--allow-mass-delete`.
- **Download cache**: `.data/` entries carry the response `ETag`/`Last-Modified` in a sidecar;
  ingest revalidates with `If-None-Match` unless `--offline`; `--max-age` (default 24 h).
- **Verify**: `npm run verify -- --url …` diffs D1 codes+row_hash against Vectorize ids
  (via `getByIds` in batches) and reports missing/extra/stale-metadata; exit non-zero on drift.
- **Cache purge**: ingest bumps `meta.data_version`; Worker keys cache on it (read once per
  isolate, refreshed every 60 s).
- **O3**: ingest writes `meta.ng_list` (`updatedAsAt`, source, counts) from the JSON; facets read it;
  `NG_LIST_UPDATED` constant deleted.

### 1D Docs
- README cost section rewritten (B9): binding limit is Vectorize queried dims (~71k searches/month
  ≈ 2.4k/day uncached), then D1 reads; numbers from Phase 1 measurements.

## Test strategy
Characterisation tests for B1–B8/O3 flip to correctness tests in the PR that fixes each. New:
full-corpus property test for B1 (for 30 queries × each sem × ng, lexical-with-filter equals
brute-force filtered set prefix); ingest unit tests for hash/delete/guard; Worker tests for
fallback, timeouts (fake hangs), cache-key canonicalisation, Server-Timing presence, bad URI.
Migration rebuild check updated (snapshot regenerated from local build, then compared to remote
after the remote apply).

## Live measurement (after deploy)
≤ 40 `/search` calls: 30 distinct realistic queries (unique, so cache misses) spaced ≥ 2 s,
record Server-Timing; p50/p90 of `total`; 5 repeats to confirm cache HIT; `/module` × 5.
Logged to `docs/evidence/requests.tsv`.

## Risks
- Rebuild/backfill writes exceed 100k/day → split days (measured first).
- Read replication beta behaviour (replica lag after ingest): sessions are read-only; ingest
  writes go to primary; brief staleness acceptable; cache version bump follows ingest.
- Column-filter syntax changes BM25 statistics? (bm25 uses per-column stats; weight-0 code column
  contributes 0) → verify identical ordering on the eval set locally old vs new.
- Workers CPU 10 ms: JSON parsing of hydrated rows is small; measured from observability.

## Quota estimate (total, Phase 1)
Reads: bootstrap ~10; 0006 rebuild ~7k + 0007 backfill ~7k; small batch ~?; full forced re-ingest
≤ 250k (gated); verify ~7k. Writes: 0006 FTS rebuild (measured locally first), 0007 ~7k–20k,
re-ingest gated ≤ 60k. Vectorize: re-upsert 6,771 (stored dims unchanged). AI: ~6,771 embeddings.
Live searches ≤ 40.

## Exit criteria
1. All B1–B9 + O3 rows in FINDINGS.md `fixed` with PR refs; characterisation tests flipped.
2. SC6: B1 property test green over full corpus; ingest test proves field-only changes land and
   dropped modules are deleted in both stores; forced full re-ingest measured < 500k rows read.
3. SC7: deployed p50 `total` < 250 ms over ≥ 30 cache-miss searches; fallback test green.
4. README cost section corrected. Deployed version ↔ commit recorded.

---
# r2 amendments (supersede r1 where they conflict)

## Ordering (one-way, each step gated)
0. **Instrumentation deploy first** (behaviour-neutral): Server-Timing spans + structured JSON
   logs (timings, D1 `rows_read`, `served_by_region`, colo) + `version_metadata` binding. Deploy
   via `npm run deploy` = refuse dirty tree, `wrangler deploy --tag <sha> --message <sha>`.
   Collect a **SIN baseline** (≤ 15 searches, colo recorded) before designing B4 further.
1. Enable D1 read replication (`mode: auto`, via REST/`cf d1 edit … --dry-run` first) — the
   instrumentation deploy already shows `served_by_region`, so before/after is measurable.
2. Bootstrap `d1_migrations` (ADR 0001) + apply **0006** with `wrangler d1 execute --remote
   --file` (atomic import; the file itself inserts its `d1_migrations` row; prints meta).
   Then `migrations list --remote` must show nothing pending.
3. Deploy the Phase 1 Worker immediately after 0006. Window analysis: old Worker on new schema
   is correct (code UNINDEXED → same matches; old join on `code` still valid; no writes occur),
   only slightly more rows read. Rollback runbook: roll back Worker first, then Time Travel
   (7 days on Free), then `'rebuild'` + `'integrity-check'`.
4. Small-batch remote ingest measurement, then the forced full re-ingest (SC6), late in the UTC
   day, only within measured headroom (below).

## 0006 (single migration; replaces r1's 0006+0007)
- External-content FTS: `fts5(code UNINDEXED, title, description, content='modules',
  content_rowid='rowid', tokenize='porter unicode61', prefix='2 3 4')`, `'rebuild'`, rank config
  restored. **`code` stays UNINDEXED** — critic A measured that indexing it (even weight 0 +
  column filter) changes bm25 doc lengths: 71/427 queries' top-10 differ; UNINDEXED + prefix:
  0/427. No column filter needed. Code/prefix search for Phase 3 goes through the `modules` PK
  (`code >= ? AND code < ?` range scan), not FTS.
- Triggers on rowid; update trigger `AFTER UPDATE OF code, title, description … WHEN old.title IS
  NOT new.title OR old.description IS NOT new.description OR old.code IS NOT new.code`. Measured
  forced full re-ingest: 6,771 reads / 20,313 writes (old triggers: 45.9M reads).
  A test asserts `INSERT OR REPLACE` is never used (it corrupts external-content FTS).
- Filter columns as **VIRTUAL generated columns** (no backfill, can't drift, measured 80 reads /
  4 writes): `sem1..sem4` from `semesters`, `ng_sem1, ng_sem2` from `ng_semesters`, via `instr`
  on comma-delimited JSON text (0 mismatches vs `json_each` over all distinct values).
- `row_hash TEXT` column (nullable).
- `meta('schema', '6')` row; ingest refuses to run unless `/admin/hashes` reports schema ≥ 6
  (stops a NULL-row_hash full rewrite against old triggers: 45.9M reads).
- Cost: local counts virtual-table writes as ~0, so the remote estimate is bounded from
  structure: docsize 6,771 rows + FTS data/idx segments (≤ ~3k) + config/ALTERs ≈ ≤ 12k written,
  ≤ 14k read. Actual measured via `d1 info rows_written_24h` before/after and the import's meta.

## Write-cap safety (account-wide outage risk)
- Before every remote write step: query account-wide D1 rows read/written so far today (GraphQL
  `d1AnalyticsAdaptiveGroups`, all databases) and proceed only if
  `estimate × 1.5 < remaining headroom` (100k writes / 5M reads minus today's usage). Run risky
  steps late in the UTC day (20:00–23:00 UTC).
- Ingest enforces a per-run write budget (`--write-budget`, default 30k) by summing
  `meta.rows_written` returned from `/admin/ingest`; stops cleanly when exceeded (resumable).
- Workers AI neurons: forced re-ingest ≈ 2k neurons (1.1M tokens × 1,841/M); not on the same UTC
  day as a Phase 2 embedding pass.

## Search path (changes vs r1)
- **Depth stays 50** (`MAX_TOPK`, `depth = min(3·topK, 50)` unchanged). `returnMetadata` dropped
  (unused); no ranking change.
- **B1 cost bound**: filtered lexical = `WITH hits AS (SELECT rowid, rank FROM modules_fts WHERE
  modules_fts MATCH ? ORDER BY rank LIMIT 2000) SELECT … FROM hits JOIN modules m ON m.rowid =
  hits.rowid WHERE <filters> ORDER BY hits.rank LIMIT ?` → worst case ≈ 4k rows/search;
  stopword-only queries skip FTS (lexical list empty). Property test proves equality with
  brute force for every query whose match count ≤ 2000 (i.e. all but stopword-like queries);
  worst-case rows-read test over a list of broad queries × all filters. Residual abuse risk
  documented (rate limit is burst-only; Vectorize monthly cap is the softer target anyway).
- **Cache key**: canonical params only; **no D1 read before the cache lookup**. Versioned by
  `DATA_VERSION` from `src/data-version.json` (written by ingest = hash of corpus+NG+normaliser
  version), so a post-ingest deploy invalidates the cache. q is lower-cased in the key only if a
  test shows bge-small embeddings are case-insensitive for our inputs (it is an uncased model);
  the cached body echoes the canonical q.
- **acad_year**: no join (PK is `code`, one year per DB by construction). Ingest asserts a single
  acad year and `/health` reports it. FINDINGS B2's acad_year sub-claim → rejected with reason.
- Timeouts + **per-isolate circuit breaker** (after N consecutive AI/Vectorize failures, skip the
  dense half for 30 s); `mode=vector` still fails loudly.
- D1 reads via `withSession('first-unconstrained')`; admin reads via `first-primary`.
- `/module/:code` selects explicit columns (no `SELECT *` shape drift).

## Ingest (changes vs r1)
- `text_hash` = hash(model id + embedding-text version + text). `row_hash` = hash(normaliser
  version + exact bound tuple + vector metadata).
- Deletes: abort the whole run before any write if offered count < 95% of D1 count; deletes run
  last and only if `failed == 0`; Vectorize `deleteByIds` first, then D1.
- After upserts/deletes, wait for Vectorize `describe().processedUpToMutation` ≥ last mutation
  before verify / reporting done.
- Verify: `wrangler vectorize list-vectors` (ids only) for missing/extra; `getByIds` on a sample
  of ≤ 100 for metadata drift; row_hash vs recomputed.

## SC7 measurement (changes vs r1)
Judged on samples served by **SIN** colo (cf-ray suffix), VPN off: 30 distinct queries spaced
≥ 2 s **plus** 10 sparse samples ≥ 10 min apart; report p50 with a bootstrap CI and `total`
defined from fetch entry (includes cache.match + rate limiter). Cross-checked with ≥ 3 days of
structured logs from real traffic when available.

## Objection log (round 1)
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 1 | A | indexing `code` changes bm25 (71/427 top-10 differ) | code UNINDEXED; code search via PK range in Phase 3 |
| 2 | A,B | update trigger fires on every upsert/backfill | `UPDATE OF … WHEN` guard; no backfill (generated cols) |
| 3 | A,B | topK ceiling 100 changes depth → ranking | depth cap stays 50 |
| 4 | A | new ingest before 0006 → 45.9M reads | schema marker; ingest refuses |
| 5 | B | write-cap overrun = account-wide outage; gates vs cap not headroom | account-wide headroom check ×1.5; ingest write budget; late-UTC timing |
| 6 | B | deploy/migration order; mixed-schema window; apply runs all pending | single 0006; atomic `--file` import; migrate→deploy; rollback runbook |
| 7 | B | data_version D1 read before cache lookup kills latency | DATA_VERSION from committed file |
| 8 | B | unbounded filtered rows read (abuse) | inner LIMIT 2000 by rank; stopword-only skip; worst-case test |
| 9 | A | B1 cost exceeds own 2k gate | gate restated: ≤ 4k worst case, measured |
| 10 | A | acad_year join doubles reads | dropped; single-year by construction |
| 11 | A | delete guard ratchets; ordering orphans vectors | 95% abort; deletes last; Vectorize first |
| 12 | A | replica race / Vectorize eventual consistency | version not from D1; mutation wait |
| 13 | A | text_hash ignores model | model + text version in hash |
| 14 | A | sem columns not written on ingest | generated columns |
| 15 | A,B | verify can't find extra vectors; getByIds cost | list-vectors + sampled getByIds |
| 16 | B | no latency baseline; colo mixing; warm-only samples | instrumentation deploy first; SIN-only; sparse samples; logs |
| 17 | B | neurons not budgeted; race timeouts still billed | neuron budget; circuit breaker |
| 18 | B | --var COMMIT_SHA lost on plain deploy | version_metadata + --tag; dirty-tree refusal |
| 19 | B | /module SELECT * shape drift | explicit columns |
| 20 | A | remote 10-module batch unnecessary | kept anyway: it is the brief's hard rule and validates local≈remote |

---
# r3 amendments (round-2 objections; supersede r2 where they conflict)
- **0006 file stays clean** (no `d1_migrations` insert): local apply, `applyD1Migrations` and the
  rebuild check insert the row themselves (UNIQUE would fail). The remote run uses a wrapper
  generated at apply time = bootstrap rows (first time only) + 0006 body + one
  `INSERT INTO d1_migrations(name) VALUES('0006_fts_external.sql')`; a test asserts the wrapper is
  exactly that.
- **Filtered lexical recall is exact** (SC6): bounded CTE (`LIMIT 2000` by rank) first; if the inner
  query returned exactly 2000 rows and fewer than `depth` rows survived the filters, re-run
  unbounded (rows_read worst ≈ 17k; rare). Property test covers **all** queries incl. > 2000
  matches (critic C's 440 × 11 set), asserting equality with brute force.
- **No stopword-only skip** (it changed rankings for "IT", "IS", "OR"). Stopword behaviour unchanged.
- 0006 write estimate revised to **16k** (node:sqlite `total_changes`), headroom gate uses ×1.5 = 24k.
- **Pre-declared explained diff**: the remote rebuild re-aligns FTS rowids with `modules.rowid`, so
  exact-bm25 ties may reorder (24/27 old eval queries have ties in lexical top-50). Phase 2's
  regression check treats changes confined to tie groups as explained.
- Time Travel retention on Free confirmed from docs before relying on it in the runbook.

## Objection log (round 2)
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 21 | C | 0006 inserting its own d1_migrations row breaks local/CI | clean file; generated remote wrapper + test |
| 22 | C | LIMIT 2000 loses filtered recall (239/4,840 pairs) | exact fallback when cap hit and too few survivors; property test over all queries |
| 23 | C | stopword-only skip changes rankings | dropped |
| 24 | C | 0006 write estimate low | 16k / 24k headroom |
| 25 | C | tie reorder after rebuild | pre-declared explained diff |

---
# Final (round-3 cap reached; lead decisions)
Supersession: r1 text on 0007, the 150k abort rule, "local × 1.0", `meta.data_version`, the
`acad_year` join and the r1 quota line is void; r3 numbers win over r2 (0006 ≈ 16k writes).

1. **Filtered lexical cost vs exactness** (round-3 blocker). SC6 exactness is kept. The fallback
   must not be an unbounded match-driven scan: when the bounded CTE hits its cap with too few
   survivors, use the **filter-driven plan** instead — candidate rowids from the (indexed)
   generated filter columns, then FTS MATCH restricted to those rowids — so cost ≈ size of the
   filtered set, not of the match set. Indexes on the generated filter columns are added in 0006
   if EXPLAIN shows they're needed. **Gate: worst-case rows_read per search ≤ 8k**, measured over
   critic C's 440 queries × 11 filters. If the implementer can't reach 8k, they stop and escalate;
   the lead then decides between exactness and the bound and records it in ADR 0002 (dissent).
2. **SC7 pass rule (pre-registered):** pool all SIN-colo cache-miss samples (≥ 30 spaced 2 s + ≥ 10
   sparse ≥ 10 min apart); pass iff the point-estimate p50 of `total` < 250 ms; report bootstrap
   CI and the warm/sparse p50s separately. If SIN samples can't be obtained, use the nearest APAC
   colo and say so.
3. **Cache staleness:** TTL stays 1 h; runbook is ingest → commit `src/data-version.json` →
   `npm run deploy`. Staleness after ingest is bounded by that sequence (and by 1 h worst case).
4. Exit criterion 1 accepts `fixed` **or `rejected` with reason** as terminal.
