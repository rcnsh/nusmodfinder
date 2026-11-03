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

## 2026-11-04 — Phase 2 workstream 2a (eval harness)

- Branch `phase2/harness`: eval runner (`vitest.eval.config.mjs`, separate from `npm test`;
  actual Worker in workerd, seeded through `/admin/ingest`, fake Vectorize with real corpus
  vectors, fake AI serving precomputed vectors and failing loudly otherwise), custom reporter via
  `task.meta`, `--ref` overlay (used with `eval-v0`), metrics/stats/gate, `scripts/embed.mjs`,
  holdout custody (`scripts/holdout.mjs`, AES-256-GCM, ledger, 12-look limit), CLI
  (`eval`, `eval:report`, `eval:pool`, `eval:embed`, `eval:verify`, `test:eval`). v1 eval moved
  to `eval/v1/`. Docs: `eval/README.md`.
- **Workers AI neurons (estimated from token counts, 1,841/M tokens; logged in
  `docs/evidence/neurons.tsv`): 1,837.2 total** = fixture set 6.7 (31 texts, 1 request) + one
  corpus pass 1,829.1 (5,920 unique texts, 60 requests) + determinism check 1.4 (3 texts).
  No Vectorize, D1 remote, deploy, live-site or api.nusmods.com call.
- Release `emb-bge-small-v0` (corpus embeddings, text = `embeddingText()` at `eval-v0`):
  `corpus.f32.gz` sha256 `584555bb3a5d277c82b93ac4b4a0774ccf49004d7836df66a7aa7716ec70a3f2`,
  `corpus.index.json` sha256 `2de0622cd47bba4befb4e0532904fcb0c4854e066639c9bb82479f38dc84d495`.
- Finding: Workers AI embeddings are not bit-deterministic across calls/batches. Same text,
  two REST calls: cosine 0.9994–0.9998; batch of 31 vs batches of 100: min 0.9797, median 0.9957
  (23 texts). Relevant to the 2c fidelity check (offline vs live near-tie order).
- Full-corpus smoke run (fixture queries, 6,771 modules, `--ref eval-v0`): 19 s end to end.

## 2026-11-04 — Phase 2 2a: PR #6 review fixes (eval harness)

- **Errors** (medium): a non-200 response is never correct-empty or relevant; every gate (dev,
  holdout, cutoff, SC5) has "no new errors"; `npm run eval` prints the error count after a dev
  run. The reviewer's case (8 answerable + 4 no-answer, candidate 500s on the 4) now fails the
  cutoff gate on dev and holdout instead of passing.
- **Ledger custody** (medium): `holdout` and `test` always count looks in
  `eval/holdout-ledger.md`, whatever `--set-dir` says. Ciphertexts are `VNMENC2` with AAD
  `<set>/<file>`, so files copied into another set's directory do not decrypt. The self-test
  uses a new encrypted `selftest` set (ledger in its own directory; ciphertexts regenerated with
  a throwaway key each run). `holdout.mjs encrypt|decrypt` take `--set`.
- **Concurrency** (medium): check-then-append runs under an `O_EXCL` lock (`<ledger>.lock`; waits
  2 min; a lock older than 30 min is removed with a message). `npm run eval` reserves its look
  (`reserved` row, counted) before retrieval and finalises it as the verdict, `aborted` or
  `unjudged`. Three parallel reports from 11 rows now record 12, not 14.
- **Leaks** (medium): holdout/test errors print only `eval: <set> run failed (<class>); details
  withheld`. Metrics errors give a bad grade's value and position, never the rationale or id.
- **Tampering** (low): every table row counts however it is spaced; a look is refused when the
  ledger has fewer rows than `HEAD` or `origin/main`, or is missing while git has it.
- **Small samples** (low): < 10 primary answerable queries fails every gate ("insufficient
  queries"); zero-variance BCa intervals are `degenerate` and never pass a CI check; tripwires
  with n < 3 use the point estimate.
- **Corpus** (low): `report`/`run` refuse when qrels and run corpus sha256s (moduleInfo; NG if
  recorded) differ; comparison output names the qrels version.
- **Which ranker ran** (low): run files record `ranker.treeHash`; the self-test checks it against
  `git archive eval-v0`. A mutant that runs HEAD under `--ref eval-v0` now fails the self-test.
- No Cloudflare, live-site or api.nusmods.com call; no neurons spent.

## 2026-11-04 — PR #6 review round 2 (fix delta `3eee229..bcd843b`)

A fresh-context review of the fixes found 7 issues (1 high); all fixed, each with a test that
fails on the previous code.

- **Worker output** (high): workerd prints a Worker's uncaught exceptions to stderr itself, so
  holdout query text reached the terminal despite `silent`. Vitest now runs in a child process
  (`eval/runner/vitest-child.mjs`); for encrypted sets its stdout and stderr are discarded and
  the outcome returns over IPC. Self-test step 5 runs a probe ranker (a dangling commit object)
  that logs, throws and throws uncaught with the query text: visible on the fixture set, absent
  on `selftest`.
- **Ledger edits** (medium): the tamper check compares looks per known set against `HEAD` and
  `origin/main`, so relabelling `holdout` rows `selftest` or `test` is refused.
- **Lock ownership** (medium): the lock holds a random token; a holder writes (`assertHeld()`
  right before a synchronous append) and removes the lock only while the token is its own. A
  stale lock is broken under `<ledger>.lock.break`, so two breakers cannot remove each other's
  fresh lock; an abandoned break lock is cleared after 1 min.
- **Decisive comparison** (low–medium): gate amendment, to record in ADR 0003. A cutoff verdict
  needs ≥ 3 no-answer queries; the dev targeted route needs ≥ 3 distinct answerable queries
  across its target shapes (otherwise only the CI route can pass). The 10-query overall floor
  stays. Floors are 3, not 10, because dev has 5 `noanswer` queries and some shapes have 2.
- **Withheld line** (low): a failed encrypted run now prints `eval: <set> run failed
  (RunFailedError); details withheld`.
- **treeHash** (low): covers `test/wrangler.test.jsonc` (its compatibility date and flags change
  what runs).
- Tests 207 → 213 unit; self-test 5 steps. No Cloudflare, live-site or api.nusmods.com call.
- Round 3 (fresh review of `bcd843b..bd43eb5`): one finding. With `--embed-missing` on an
  encrypted set, a failed `scripts/embed.mjs` exited directly, leaving the reserved look
  unfinalised and printing its output. Now its output is discarded for encrypted sets and the
  failure throws `EmbeddingError` (withheld line; look finalised `aborted`). `.lock.break`
  gitignored. Tests 214.
