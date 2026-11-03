# Progress log

Append-only. Re-read this file and `docs/PLAN.md` after every compaction or new session.

## 2026-11-03 — Phase 0 start

- Initial commit `3b18041` of the working tree the live Worker runs (incl. untracked
  `0005_rank.sql` and unstaged edits). Private repo `rcnsh/vector-nusmods` created; squash-only,
  auto-delete branches.
- Deployed version `c6744373-1aff-4d8d-8b7f-6dd4e6c3d513` (deployment `9e0c69cd…`,
  2026-09-04 12:06Z) ↔ commit `3b18041`. Evidence: live `/` byte-identical to `src/page.html`.
- Pinned upstream data: release `data-2026-2027-20260904` holds the gzipped `.data/` files
  production was built from. Raw sha256 moduleInfo
  `2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1`, moduleList
  `c56b6fbec195da856eff924a167c31b446686aebfa8ba7346a43dd12b893e36e`.
- Remote D1 schema snapshot (read-only pragma query): **estimate ~60 rows read / 0 written;
  actual 77 read / 0 written**. Saved for the rebuild diff.
- Earlier remote read for `sqlite_master` listing: 16 rows read (and one malformed query, 0).
- Workstream 0b (live + frontend reproductions) done: 36 `/search` + 7 other live calls,
  evidence in `/tmp/vnm-repro/` (to be copied into `docs/evidence/phase0/`).
- Critic incident: critic A's first experiment ran the test plugin with default
  `remoteBindings`, which made 2 Cloudflare API GETs (`/accounts`, `/memberships`). No AI,
  Vectorize or D1 call. Led to objection #2.
- Phase 0 planning loop round 1: 2 critics, 14 objections, all accepted (see PLAN.md).

## 2026-11-04 — Phase 0 workstream 0c (findings)

- `docs/FINDINGS.md` triages all 35 IDs: 30 reproduced, 3 partially-reproduced (B4, P2,
  V1), 2 fixed (O1, O2 by PR #1), 0 rejected. Each section gives the claim, the evidence
  (tests and/or `docs/evidence/phase0/` files) and the cause by file:line.
- Characterisation tests `[<ID> known-bug] …` (plain `it`, asserting the current wrong
  output) in `test/findings/`, plus `test/full/findings.test.js`. Over the full pinned
  corpus, B1 is exact: 31 sem-3 matches for `management`, lexical returns the same 6 codes
  production did. Mutation check: un-capping the FTS limit or fixing `topK=` fails the
  matching tests.
- `vitest.config.mjs` now has two projects: `workers` (as before) and `node` for
  `*.node.test.js` (Node-side `scripts/` code and repository-file checks; workerd can't load
  `node:*` without `nodejs_compat`, which production doesn't set). The workers project uses an
  extglob include rather than `exclude`, because a project-level exclude overrides the CLI's
  `--exclude 'test/full/**'`.
- `scripts/check-findings.mjs` + `npm run check:findings`, unit-tested in
  `test/check-findings.node.test.js`. CI: `.github/workflows/findings.yml` (no path filter,
  plain node, no `npm ci`).
- Live calls: none. Pinned corpus fetched from the GitHub release (not api.nusmods.com) into
  `/tmp/vnm-0c/` and `.data/` (gitignored) to run `test/full` locally.
- No change to `src/` or `scripts/lib.mjs`.

## 2026-11-04 — Phase 0 passed; Phases 1 and 2 planned

- PR #1 (harness, migrations, lint, typecheck, CI) and PR #2 (35 findings triaged: 30 reproduced,
  3 partially reproduced, 2 fixed; characterisation tests; findings CI) merged. Main CI green on
  `546a91d` (CI + Findings). Each PR went through 4 fresh-context review rounds; findings fixed
  (fake Vectorize semantics, CI path filter, B5 tests made behavioural, check-findings reads
  exact test titles from the AST).
- Phase 0 exit: CI green on main; `check-findings` OK; `db:rebuild-check` 0 differences. No
  deploy (no runtime change); production still `c6744373` ↔ `3b18041` (behaviourally = `546a91d`).
- Phase 1 and Phase 2 plans converged after 3 critic rounds each (`docs/plans/`). Key facts found:
  D1 primary is WEUR with read replication disabled (likely cause of latency for SIN users);
  indexing `code` in FTS or raising depth to 100 would change rankings; a D1 write overrun is an
  account-wide outage; a reused holdout inflates SC5's false-positive rate (simulated 14% vs 2.5%).
- Tagged `eval-v0` = `7ac9841` (ranker identical to production).

## 2026-11-04 — Phase 1 step 0: module split and instrumentation (`phase1/instrument`)

- `src/index.js` is now only the router. Search (cache, rate limiter, filters, FTS, fusion,
  hydration) is in `src/search.js`, `/module` and `/facets` in `src/modules.js`, the admin
  ingest routes in `src/ingest.js`, response helpers in `src/http.js`, spans and D1 counters in
  `src/timing.js`, and the default model id in `src/embedding.js`. 1A, 1B and 1C can now edit
  different files.
- Behaviour-neutral: every Phase 0 test passes unchanged except three. `[B4 known-bug] responses
  carry no Server-Timing header` is flipped to `[B4 instrumented] …`. Two source-text tests (O3,
  S1) now read all of `src/*.js` instead of `src/index.js`, and the README's `NG_LIST_UPDATED`
  pointer moved to `src/modules.js`. A throwaway differential test ran the old `index.js` and the
  new router side by side on 31 paths (errors, every filter, every mode, admin 404) and got
  identical status, headers (minus the two new ones) and bodies.
- `/search` responses carry `Server-Timing` (`cache;desc=hit|miss`, `limit`, `pin`, `embed`,
  `vector`, `fts`, `hydrate`, `total` from fetch entry, only stages that ran). Cache hits get fresh
  spans, and the stored entry never holds any. `/module` and `/facets` have `d1` and `total`.
  Each `/search` writes one JSON log line: status, cache, q (first 100 chars), q length, mode,
  filters, topK, counts, spans, D1 queries/rows read/served_by_region/served_by_primary, colo,
  version. Headers and IPs are not logged.
- `version_metadata` binding (`CF_VERSION_METADATA`); every response has `x-app-version` (tag,
  else version id, else `dev`); `GET /health` → `{ ok, versionId, versionTag }`, no D1.
- `npm run deploy` → `scripts/deploy.mjs`: refuses a dirty tree, an unfetchable origin, or a HEAD
  not on `origin/main`; runs `wrangler deploy --tag <short sha> --message "<sha> <subject>"`;
  prints the version id. Not run. Plain `wrangler deploy` still works; the README says
  `npm run deploy` is the only supported path.
- Tests 98 → 117 (`test/instrument.test.js`, `test/deploy.node.test.js`). No live calls, no
  remote commands, no deploy.

## 2026-11-04 — Phase 1 workstream 1B (search request path, PR #7)

- B4, B5, B6, B7, O3 → `fixed`; B8 stays `reproduced` with three of four sub-claims fixed
  (the Unicode tokeniser is 1A's, in `src/lexical.js`). Characterisation tests flipped.
- `/search`: parameters validated first (400s touch no cache, limiter or binding); canonical
  cache key from validated params + `DATA_VERSION` (`src/data-version.json`, seeded
  `2d138795d387`, the pinned moduleInfo sha256 prefix), no D1 read before the lookup;
  pin, lexical and embed→Vectorize concurrent, then one hydrate of only rendered columns and
  rows; all public D1 reads on `withSession('first-unconstrained')`, admin on `env.DB`.
  Vectorize gets no `returnMetadata`; depth and `MAX_TOPK` stay 50, RRF unchanged.
- Timeouts (`src/upstream.js`): AI 1.5 s (also aborted via `signal`), Vectorize 1.5 s, D1 3 s.
  Hybrid AI/Vectorize failure → lexical-only, `degraded: { source, reason }`, Server-Timing
  `degraded`, cached 60 s; per-isolate breaker skips the dense half for 30 s after 3
  consecutive failures. `mode=vector` still 502s. Top-level catch → JSON 500 with
  `requestId` (cf-ray); `/module` bad percent-encoding → 400; rate limiter fails open.
- `/module/:code` selects the 0001–0005 columns by name. O3: ingest posts the NG list's
  `{ updatedAsAt, source, count }` to `/admin/facets` → `meta('ng_list')`; the constant is gone.
- Neutrality: `test/differential.test.js` runs 522 generated requests (every query × mode with
  random filters/topK/junk, incl. invalid ones) through a frozen copy of the pre-1B route
  (`test/legacy/search-f61072e.js`) and the new Worker: 0 differences beyond the declared
  fixes (empty `topK=`, canonical `query` echo). Mutation check: depth multiplier 3 → 2 fails
  it. With stale vectors injected, results are identical; only `retrieval.fused` may be higher
  (hydration stops when the page is full).
- Not done here (remote, lead's): enabling D1 read replication (ADR 0002), the SC7
  measurement. Ingest does not yet write `src/data-version.json` (1C).
- Tests 119 → 128; full corpus 4/4. No live calls, no remote commands, no deploy.

## 2026-11-04 — Phase 1A: migration 0006 and exact filtered lexical search (`phase1/fts`)

- `migrations/0006_fts_external.sql`: `modules_fts` rebuilt as external-content FTS5
  (`content='modules'`, `content_rowid='rowid'`, `code UNINDEXED`, `prefix='2 3 4'`) with the
  rank config restored; rowid triggers using the FTS5 `'delete'` command, the update trigger
  guarded by `UPDATE OF code, title, description … WHEN` any of them changed; VIRTUAL generated
  `sem1..sem4`, `ng_sem1`, `ng_sem2`; `row_hash`; `meta('schema','6')`. Not applied remotely.
- B1 fixed (`src/lexical.js`): filters in SQL on the generated columns; bounded top-2000 CTE,
  then, only when the cap may have cut matches, a filter-driven plan (indexed filtered rows,
  FTS5 probed by rowid) behind a cap probe. Exact over 440 queries × 13 filters on the full
  corpus; worst 6,989 rows read per search (gate 8,000), mean 1,071
  (`docs/evidence/phase1/lexical-cost.md`). Unfiltered SQL unchanged.
- Deviation: 0006 also creates `idx_modules_level`, `idx_modules_credits` and partial
  `idx_modules_sem3/4`. Without them the filter-driven plan scans `modules` and the worst
  case is 13,278 rows. Cost: 0006 estimate rises from 16k to ~30.1k rows written, and a forced
  full re-ingest writes 34,381 rows locally (index entries ~5/row), reads 6,771.
- B3 fixed: trigger statements plan without scans; a title update reads 1 row (was every FTS
  row); a forced re-ingest of unchanged rows writes nothing to FTS (asserted byte for byte);
  old triggers: 105,404 changes for the same re-ingest in node:sqlite
  (`docs/evidence/phase1/0006-cost.md`).
- Ranking neutrality: 0006 applied on top of a populated 0001–0005 database leaves unfiltered
  lexical top-50 identical for all 417 distinct queries (0 tie-only diffs, 0 bm25 changes).
  Remotely the rebuild realigns FTS rowids, so exact-bm25 ties may reorder (pre-declared, r3).
- `db:rebuild-check` now proves 0001–0005 == the remote capture (unchanged) and the full chain
  == `test/fixtures/schema-0006.json` (`-- --update` regenerates it).
- `scripts/remote-migration.mjs <name> [--bootstrap]` writes `/tmp/vnm-remote-<name>.sql`
  (wrangler's `d1_migrations` DDL + 0001–0005 rows, body, own row) and prints a rows-written
  estimate; its structure is asserted in `test/migrations.node.test.js`, which also fails on
  any `INSERT OR REPLACE` into `modules`.
- New tests: `test/fts.test.js` (trigger fuzz vs `'rebuild'` + `integrity-check`, no-op
  re-ingest, generated columns), `test/full/lexical.test.js`, `test/migrations.node.test.js`;
  B1/B3 characterisation tests flipped. Mutation-checked: removing the update trigger's
  `'delete'`, its `WHEN` guard, or the lexical fallback each fails a test.
- No remote commands, no deploy, no live requests. Corpus copied from the pinned `.data/`.
