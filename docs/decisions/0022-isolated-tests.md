# 0022: Tests run isolated from metered services and production, and never pass by skipping

Status: accepted. Builds on ADR 0004 (no spending) and ADR 0011 (deploys follow green CI).

## Context
The Worker binds Workers AI, Vectorize and two rate limiters, all metered, and a D1 database that
production serves from. A test that reached any of them would spend money, or change or read
production state, and a test run on a laptop holds the root `.dev.vars` with a real
`INGEST_SECRET`. The full-corpus and oracle suites need large data that isn't in the repo
(the pinned corpus and bundle, production's corpus and bundle), so they must be able to run
without it locally, and CI must still not report green when it is missing. Many tests also
name fixture codes, so the fixture corpus must not move under them.

## Decision
**No test can reach a metered service or production.**
- `vitest.config.mjs` runs every workerd project against `test/wrangler.test.jsonc` with
  `remoteBindings: false`. That file is production's config minus `ai`, `vectorize` and
  `ratelimits`; it lives in `test/` so wrangler does not load the root `.dev.vars`, and its D1 id
  is not production's, so a `--remote` command pointed at it fails. `vitest.eval.config.mjs`
  applies the same isolation to the eval runner.
- `test/guard.test.js` fails if the test env holds AI, Vectorize, a rate limiter,
  `INGEST_SECRET` or any binding but `DB` and `TEST_MIGRATIONS`. When it fails the harness is
  unsafe, and nothing else should run until it passes.
- Each bare data import (`vectors-bundle`, `vocabulary-data`, `groups-data`,
  `ng-unscheduled-data`, `catalogue-codes-data`, `prefixes-data`, `catalogue-only-data`) is aliased
  in the Vitest config, because the plugin ignores wrangler's `alias`, and points at the files of
  the corpus that project searches (the fixture, `data/pinned/` or, for the oracle, `data/`),
  never at production's `data/` by accident.
- `*.node.test.js` runs in Node, because it covers Node-side scripts and reads repository files,
  which workerd can't do without `nodejs_compat`, and production sets none.
- The `node` project sets `VNM_RUNS_DIR` to a temp dir, and `scripts/run-record.mjs` refuses to
  write into `ops/runs/` under Vitest, so a test never leaves a run record in the repo.
- `playwright.config.mjs` runs the UI suite against `scripts/ui-server.mjs` (local `wrangler dev`,
  FakeAI, the fixture). It picks one free port in the runner (its workers reload the config with
  `VNM_UI_PORT` set, so they agree), waits for the line the server prints only after seeding,
  and stops it with SIGINT so it can stop wrangler and delete its state.

**The metered services are contract-tested fakes** (`test/fakes.js`).
- `FakeAI`, `FakeVectorize` and `FakeRateLimit` stand in for `AI`, `VECTORIZE`, `SEARCH_LIMIT`
  and `SEARCH_LIMIT_MINUTE`, and enforce the real limits where breaking them would be a bug:
  Vectorize's topK ceiling (50 when values or metadata are returned, else 100), one operator per
  filter object except one upper bound with one lower, a throw on any unknown operator, and,
  with `deferApply`, mutations that lag as the real async ones do. Every fake can be told to throw
  or hang, for upstream-failure tests.
- `hashEmbed()` is a deterministic hashed bag of words, enough for retrieval tests without a
  model. Its cosine scale is not the model's, so a test that depends on one (the no-signal τ in
  `test/search-no-signal.test.js`) sets it through env.
- `test/fakes.test.js` tests the fakes' contract: a fake that diverges from Cloudflare makes
  every test built on it lie. `test/fakes.js` is also a ranking-lock input
  (`eval/lib/ranking-lock.mjs`).
- `test/helpers.js` `call()` deletes the URL's `caches.default` entry and resets the dense-half
  circuit breaker before each call by default, since both persist across a file's tests;
  `seed()` loads modules through the Worker's own `/admin/ingest`, so D1 and the fake index hold
  what production would.
- Over real corpora, Workers AI answers only from committed embedding caches and throws on a text
  with none, never inventing a vector (`SuiteAI` in `test/full/query-suite.test.js`, `CacheAI` in
  `test/oracle/shared.js`).

**test/full and test/oracle never pass by skipping.**
- Without their data both suites skip locally. With `FULL_CORPUS=1` or `PRODUCTION_CORPUS=1`,
  set only by their CI jobs, a missing or sha-mismatched corpus or bundle fails the run on the
  Node side of the config, and those jobs fail on any skipped test (`.github/workflows/ci.yml`).
- So nothing in them uses `it.skip`: query-suite items whose feature is not in force are listed
  as pending in one test, with what they wait for.
- `LEXICAL_GRID=sample` runs a fixed 1-in-10 sample of `test/full/lexical.test.js`'s brute-force
  grid (about 25 s instead of about 4 min locally, 12 min on CI). CI runs the full grid whenever
  `scripts/ci-changes.mjs`'s `GRID` paths change (`src/`, `migrations/`, `scripts/`, `test/full/`
  and the test config among them).

**The fixture corpus is a deterministic selection** (`scripts/build-fixture.mjs`).
- It orders the filler sample by `hashOf('fixture:<code>')`, so the sample doesn't favour
  early-alphabet codes and doesn't change between runs. It keeps two modules per faculty (so
  `/facets` lists every faculty), plus special-term and NG samples, and adds the exchange-mode
  picks after the filler, so a new coverage rule never reshuffles the filler.
- A rebuild with unchanged input is byte-identical; the tests and aria snapshots that name fixture
  codes rely on it.

## Consequences
- `npm test` costs nothing and needs no credentials; a test can't spend inside ADR 0004's
  allowances or touch production D1.
- A green full-corpus or oracle job means every test in it ran.
- A Cloudflare behaviour the fakes don't model goes untested until the fake learns it, and the
  fake's contract test is where it lands.
- Timeouts above Vitest's 5 s default are sized from measured CI runtimes (subprocess-heavy CLI
  tests, the full-corpus group build, the oracle sweep, the vector CPU measurement).
  `test/full/oracle-pinned.test.js` loads no `catalogue_only` rows, since neither of its checks
  reads them and about 14k rows took the workerd pool down in CI.
