# Plan

Mission: turn vector-nusmods into the NUS course planner for incoming exchange students.
Success criteria SC1–SC10 are defined in the mission brief and restated in
[`docs/CRITERIA.md`](CRITERIA.md). Findings live in [`FINDINGS.md`](FINDINGS.md), the
log in [`PROGRESS.md`](PROGRESS.md), decisions in [`decisions/`](decisions/).

## Phase status

| Phase | Title | Status | Exit gate |
|---|---|---|---|
| 0 | Safety net | **passed** (PRs #1, #2) | CI green on main; every finding triaged; DB rebuilds from scratch |
| 1 | Backend correctness and pipeline | planned ([plan](plans/phase1.md), converged r3) | SC6, SC7 measured; README cost section fixed |
| 2 | A real eval (may run parallel to 1) | planned ([plan](plans/phase2.md), converged r3) | one-command harness; baseline in EVAL.md |
| 3 | Search that understands students | planned (converged r3.1), awaiting Q1–Q4 ([plan](plans/phase3.md), [ADR 0006](decisions/0006-phase3-search-quality-plan.md)) | SC4, SC5 (+ SC7 carried over) |
| 4 | Exchange mode that is correct | not started | SC1; persona red team finds nothing |
| 5 | Frontend and design overhaul | not started | SC2, SC8; design gate |
| 6 | Shortlist and export | not started | SC3 |
| 7 | Ops and architecture | not started | SC9 |
| 8 | Launch readiness | not started | SC10; name/domain gate |

## Phase 0 plan (revision 2)

### Scope
1. Initial commit + private remote. **Done** (`3b18041`, `rcnsh/vector-nusmods`; deployed
   version `c6744373-1aff-4d8d-8b7f-6dd4e6c3d513` serves this commit: live `/` is byte-identical
   to `src/page.html`).
2. Upstream data pinned. **Done**: the 2026-09-04 `.data/` production was built from is the
   release asset `data-2026-2027-20260904` (gz; raw sha256 moduleInfo `2d138795…57b1`,
   moduleList `c56b6fbe…e36e`).
3. Remote schema snapshot captured read-only. **Done** (`docs/evidence/phase0/remote-schema.json`,
   query in `remote-schema-query.sql`; 77 rows read, 0 written). Copied to
   `test/fixtures/remote-schema.json` by 0a.
4. Migrations formalised for `wrangler d1 migrations apply`.
5. Test harness: Vitest 5.1.0 + `@cloudflare/vitest-plugin@1.5.1` (pinned exactly; the old
   `vitest-pool-workers` is deprecated and its workerd can't run compat date 2026-09-01).
6. Lint (ESLint 9 flat) + `// @ts-check` + `tsc --noEmit`.
7. CI on GitHub Actions.
8. Every §4 finding reproduced; `FINDINGS.md` complete; a check fails CI if any ID lacks a status.

**Phase 0 makes no behavioural change to `src/`.** Only JSDoc/type annotations and
comment-free refactors that tsc forces; any such edit is listed in the PR. Production stays on
`3b18041` until Phase 1 deploys.

### Remote-safety rules for Phase 0 (all agents)
Banned: `wrangler dev` / `npm run dev` in **any** form except `-c test/wrangler.test.jsonc` (the
production config's `ai` binding always calls the real account, even locally), `npm run eval`
and `scripts/pool.mjs` with any URL, `wrangler d1 migrations list|apply --remote` (both run `CREATE TABLE d1_migrations`
remotely, wrangler cli.js `initMigrationsTable`), `wrangler dev --remote`, `npm run ingest`,
`wrangler deploy`, any remote D1 write. Allowed: read-only `wrangler d1 execute --remote
--command "SELECT|EXPLAIN …"` with estimate + actual logged in PROGRESS. Live `/search`:
every call (curl or browser-driven) appended to `docs/evidence/requests.tsv` (committed shared
counter; `.log` is gitignored); 36 of the 40 budget are spent (33 curl + 3 browser from
`fe.mjs`), so ≤ 4 more in Phase 0.

### Migrations
- `migrations/0001_init.sql` = original `modules` (13 columns, `ng`/`ng_semesters` stay in
  0003) + `idx_modules_faculty`. FTS stays in 0002, `meta` in 0004. All `CREATE … IF NOT
  EXISTS`. `schema.sql` is deleted; README points at migrations.
- 0003's `ALTER TABLE ADD COLUMN`: SQLite has no `IF NOT EXISTS` for columns, so idempotency
  for ALTER comes from migration tracking. Failure mode if someone runs `apply --remote`
  before bootstrap: 0001/0002 no-op and get recorded, 0003 fails `duplicate column name: ng`;
  recover by inserting the remaining rows. Recorded in ADR 0001.
- Remote bootstrap is **Phase 1**, before 0006: take a time-travel bookmark, then one
  `d1 execute --remote` running wrangler's exact DDL
  `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`
  and `INSERT OR IGNORE` of `0001_init.sql`…`0005_rank.sql`. Est. ≤ 10 rows written.
- **Rebuild proof**: `scripts/schema-snapshot.mjs` runs the same pragma query used for the
  remote capture (`test/fixtures/schema-query.sql`) against a local D1 built from empty by
  `wrangler d1 migrations apply nusmods --local --persist-to <tmp>`, normalises (sorted rows,
  internal tables `_cf_%`, `d1_%`, `sqlite_%` excluded), and diffs against the committed remote
  snapshot `test/fixtures/remote-schema.json` (unwrapping wrangler's `[{results}]` envelope).
  `test/fixtures/schema-query.sql` is a byte-identical copy of the evidence query; CI checks they
  match. Compares columns (pragma_table_xinfo), indexes
  (pragma_index_list), object names, and `modules_fts_config` (so a missing 0005 is caught).
  Not raw `sqlite_master.sql` text, which differs by comments and apply path. Runs in CI with
  no Cloudflare credentials. Strengthened (round 2): also builds the *old recipe*
  (`schema.sql` and 0002–0005 all taken from `git show 3b18041:…`) locally and diffs normalised `sqlite_master.sql`
  (comments stripped, whitespace collapsed) and `pragma_index_xinfo` between the two local
  builds, which covers index columns, trigger bodies and the FTS `tokenize` option.

### Test harness
- `vitest.config.mjs` with `cloudflareTest({ wrangler: { configPath: './test/wrangler.test.jsonc' },
  remoteBindings: false })`. `test/wrangler.test.jsonc` (`main: "../src/index.js"`) = production
  config minus `ai`, `vectorize` and `ratelimits`, with `"migrations_dir": "../migrations"`, so nothing can reach a metered remote service;
  it lives in `test/` so the root `.dev.vars` secret is not loaded. A guard test asserts
  `env.AI`, `env.VECTORIZE` and `env.INGEST_SECRET` are undefined in the raw test env.
- Fakes in `test/fakes.js`: deterministic hashing embedder for AI (384-d), in-memory cosine
  Vectorize (`query` with topK ceiling 50 when `returnValues` or `returnMetadata` is `all`/`indexed`, else 100;
  implicit-eq/`$eq`/`$ne`/`$in` filters, unknown operator throws; `upsert`, `deleteByIds`,
  `getByIds`), fake `SEARCH_LIMIT` (always allow, or configurable). Each can be set to throw or
  hang. All requests go through a helper `call(path, {fakes})` that builds env, creates an
  execution context and awaits `waitOnExecutionContext`.
- Isolation: `caches.default` and D1 persist across tests in a file, so each test file seeds in
  `beforeAll` and the helper deletes the `/search` cache entry it is about to use (or tests use
  unique query strings); `reset()` + re-migrate where a test mutates D1.
- **Fixture corpus** (committed): `test/fixtures/corpus.json`, ~400 normalised modules built by
  `scripts/build-fixture.mjs` from the pinned snapshot, selected to cover the findings
  (all "management" modules with sem 3, CS1010S, CS2109S, CS3244, CG3201, PC3270, GEA*, TR3202*,
  PL1101E, CE5316QA, LAK1201/LAK2201, level 5–6 AI courses, non-ASCII titles, etc.). Records
  source sha256.
- **Full corpus**: `vitest.config.mjs` (Node side) reads `.data/2026-2027-moduleInfo.json`
  **directly** (never via `fetchAcadYearFile`, which falls back to fetching upstream), checks its
  sha256 against the pinned value, normalises via `scripts/lib.mjs`, and `provide`s it; tests use `inject('corpus')`. `test/full/*` use
  `describe.skipIf(!corpus)`; with `FULL_CORPUS=1` (set only in the `full-corpus` CI job) a
  missing or mismatched corpus is a hard failure.
  CI fetches the release asset (`gh release download`, `GITHUB_TOKEN`), verifies sha256,
  caches on that hash. Never fetches api.nusmods.com. The `FULL_CORPUS=1` hard failure lives on the
  Node side of the config.
- **Known-bug tests are characterisation tests** with plain `it`, named `[B1 known-bug] …`,
  asserting the current wrong output specifically. When a phase fixes the bug, the test fails
  and is rewritten to assert correct behaviour in the same PR. No `it.fails` (it passes on
  any error, including harness breakage). Hang/timeout behaviours use fake hangs with a short
  test timeout and assert the specific outcome.

### Lint/typecheck
ESLint 9 flat config (`@eslint/js` recommended + `globals`). Two `tsc --noEmit` projects with `checkJs`:
`tsconfig.json` (worker: `src/`, `test/`, types from `worker-configuration.d.ts` +
`@cloudflare/vitest-plugin/types`) and `tsconfig.node.json` (`scripts/`, config files,
`@types/node`). Types from `wrangler types --env-file .dev.vars.example`
(committed example has no secrets; `worker-configuration.d.ts` committed), drift-checked with `wrangler types --check` (or regenerate
and `git diff --exit-code`). `src/env.d.ts` declares optional `INGEST_SECRET?` and
`EMBEDDING_MODEL?` by hand.

### CI
Two workflows. `ci.yml`: `push: { branches: [main] }` + `pull_request`, `paths-ignore:
['docs/**', '**.md']`, `concurrency` grouped on ref with cancel-in-progress only for PRs, jobs
`check` (npm ci, lint, typecheck, types drift, unit/integration tests, migration rebuild + schema
diff) and `full-corpus` (download pinned data, verify raw sha256 after gunzip, run `test/full`;
fails if zero tests ran). `findings.yml` (**added by 0c**, not 0a, so 0a's PR isn't red before FINDINGS.md exists): no path filter, runs `scripts/check-findings.mjs`
(asserts the ID block parses to exactly 35 IDs, each has a status from the closed set
`reproduced | partially-reproduced | rejected | fixed` (anything else fails), and each `reproduced` row
names an evidence file or test that exists). `permissions: contents: read`,
`WRANGLER_SEND_METRICS=false`, `GH_TOKEN` for `gh release download`. Node pinned via `.nvmrc`
(22) and `engines`. Actions billing API moved (HTTP 410) so minutes
are watched in the GitHub UI; jobs are kept to two.

### Findings
Reproductions from workstream 0b are in `/tmp/vnm-repro/` (requests.log, raw/, fe-*.json,
axe-*.json, shots/). They go into `FINDINGS.md` with commands and key output. Locally testable
findings additionally get a characterisation test. B3 gets a local `EXPLAIN QUERY PLAN` test
(no remote call needed: the query plan is a property of the schema).
`docs/CRITERIA.md` holds the SC list and every §4 ID; `scripts/check-findings.mjs` fails if an
ID lacks a status.

### Risks
- Plugin 1.5.1 published today: pin exactly; if it misbehaves, fall back to 1.4.12.
- Fixture too small for ranking findings (S2, S6): those stay recorded live commands.
- Fakes diverging from real Vectorize semantics: ceilings and operators enforced, unknown
  operators throw.
- Miniflare does not enforce the 10 ms CPU limit: CPU measured in Phase 1 from the deployed
  Worker's observability, not locally.
- Branch protection is unavailable for private repos on GitHub Free, so "green before merge"
  is enforced by process: merges only via `gh pr merge --squash` after `gh pr checks --watch`.

### Quota cost
Already spent: 77 rows read (snapshot), 36 `/search` + 7 other live calls. Remaining Phase 0:
≤ 4 `/search`, ≤ 20 rows read. No writes.

### Exit criteria
- CI green on `main` (both jobs).
- `scripts/check-findings.mjs` passes: every §4 ID has reproduced/rejected/fixed status.
- Migration rebuild diff is empty against the remote snapshot.

### Workstreams
| WS | Owner | Branch | Depends on | Status |
|---|---|---|---|---|
| 0b live + frontend reproductions | agent | — | — | done (`/tmp/vnm-repro/`) |
| 0a harness+migrations+lint+CI | implementer | `phase0/harness` | — | merged #1 |
| 0c reproduction tests + FINDINGS.md | implementer | `phase0/findings` | 0a merged | merged #2 |

### Critic round 1 objection log
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 1 | A, B | `vitest-pool-workers` deprecated; 0.23 needs vitest 4, workerd too old for compat date | Switched to `@cloudflare/vitest-plugin@1.5.1` pinned |
| 2 | A, B | `remoteBindings` defaults true; AI binding without `remote` connects to real account | `remoteBindings:false` + test config without ai/vectorize/ratelimits + guard test |
| 3 | A | `caches.default` persists across tests → false results | per-test cache delete / unique URLs; `reset()` + re-migrate |
| 4 | A | real rate limiter trips in tests | fake `SEARCH_LIMIT`; limiter removed from test config |
| 5 | B | `migrations list --remote` writes to prod | banned in Phase 0; bootstrap in Phase 1 with bookmark + `INSERT OR IGNORE` |
| 6 | B | `wrangler types` drift fails because `.dev.vars` has `INGEST_SECRET` | `--env-file .dev.vars.example`; hand-declared optional vars |
| 7 | B | CI data not reproducible (upstream drifted, cache evicts) | pinned release asset with sha256; never fetch upstream in CI |
| 8 | A, B | schema text diff fragile; misses 0005 | pragma-based normalised diff incl. `modules_fts_config` |
| 9 | A, B | `it.fails` hides harness breakage | characterisation tests with plain `it` |
| 10 | B | Actions minutes | 2 jobs, concurrency cancel, paths-ignore |
| 11 | B | main may drift from live | no behavioural `src/` change in Phase 0; version mapped |
| 12 | B | live budget unenforced across agents | committed `docs/evidence/requests.tsv` incl. browser calls; ≤ 4 left |
| 13 | B | durable docs missing | PROGRESS, CRITERIA, ADR 0001 written; FINDINGS.md created by 0c |
| 14 | A | full-corpus can pass by skipping | hard fail when `CI=true` |

### Critic round 2 objection log
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 15 | C (blocking) | `paths-ignore` skips the findings check on docs-only PRs | separate `findings.yml` with no path filter |
| 16 | D (blocking) | plain `wrangler dev`, `npm run eval`, `pool.mjs` hit real AI / live site | banned except `-c test/wrangler.test.jsonc` |
| 17 | C | root test config loads `.dev.vars` secret | config moved to `test/`; guard asserts `INGEST_SECRET` undefined |
| 18 | C | corpus loader may fetch upstream | read file directly, sha256 check |
| 19 | C, D | schema diff misses index columns, trigger bodies, tokenize | old-recipe local build + `sqlite_master`/`index_xinfo` diff |
| 20 | C | one tsc mixes worker and node types | two tsconfigs |
| 21 | D | concurrency cancels main runs | cancel only for PRs |
| 22 | D | check-findings could pass with 0 IDs | assert 35 IDs + evidence existence |
| 23 | D | request log uncommitted / incomplete | `docs/evidence/requests.tsv` incl. browser calls |
| 24 | C, D | Node/wrangler version split; CI hygiene | `.nvmrc`, `engines`, telemetry off, read-only perms |

### Critic round 3 objection log
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 25 | E (blocking) | `CI=true` hard-fail would break the `check` job | gated on `FULL_CORPUS=1`, set only in `full-corpus` |
| 26 | E (blocking) | `findings.yml` in 0a would be red until 0c | `findings.yml` moves to 0c |
| 27 | E | status values not a closed set | closed set enforced |
| 28 | E | test config needs `migrations_dir` | added |
| 29 | E | old recipe should use 0002–0005 from `3b18041` | done |
| 30 | E | query file duplicated; envelope | byte-identical check; unwrap |
| 31 | E | counts/ceiling details | `requests.tsv` counts by call id; `returnValues` ceiling |

**Convergence (round 3 of 3):** every blocking objection from all three rounds was accepted and
the plan changed; none was rebutted, so no dissent. Phase 0 plan is the shared understanding.

## Phases 1 and 2 (running in parallel)

Plans: [`plans/phase1.md`](plans/phase1.md), [`plans/phase2.md`](plans/phase2.md). Each was reviewed by
critics over 3 rounds; later "amendments"/"Final" sections supersede earlier text.

Cross-phase ordering constraints:
- Phase 2's baseline runs at tag `eval-v0` (= `7ac9841`) and its live fidelity check (15 calls)
  must finish **before** Phase 1 applies 0006 remotely or deploys a ranking-affecting Worker.
- Phase 1 step 0 (module split + instrumentation) is behaviour-neutral and may deploy first.

| WS | Scope | Branch | Depends on | Status |
|---|---|---|---|---|
| 1-0 | split `src/index.js` into modules; Server-Timing, structured logs, version_metadata, `npm run deploy` | `phase1/instrument` | — | |
| 1A | 0006 migration, filtered lexical (B1), generated filter columns | `phase1/fts` | 1-0 | |
| 1B | request path: parallel, sessions/replication, timeouts, fallback, cache key, input bugs | `phase1/search-path` | 1-0 | |
| 1C | ingest: row_hash, deletes, cache expiry, verify, data-version, O3 | `phase1/ingest` | 1A | |
| 2a | eval runner, metrics, reporter, embed script, encryption, CLI | `phase2/harness` | — | |
| 2b | persona queries (no corpus access), typo noise model, split | `phase2/queries` | — | |
| 2c | embeddings, baseline run at eval-v0, fidelity check | `phase2/baseline` | 2a, 2b | |
| 2d | pooling + blind judging + agreement | `phase2/judging` | 2c | |
