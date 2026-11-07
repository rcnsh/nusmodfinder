# SC7 at the Phase 3 freeze: the counted run

Criterion (`docs/CRITERIA.md`): search p50 server time under 250 ms on a cache miss, measured
with `Server-Timing` from the deployed Worker. Fallback to keyword-only must be graceful if
Workers AI or the dense half fails.

## Method (pre-registered; committed before any sample)

**Rule** (unchanged from Phase 1 Final §2; `docs/plans/phase3.md` §2 "SC7 re-measurement"):
- Pool every SIN-colo cache-miss sample: at least 30 distinct queries spaced ≥ 2 s apart, plus at
  least 10 sparse samples ≥ 10 min apart.
- **Pass iff the point-estimate p50 of `total` < 250 ms.**
- Report the bootstrap CI, and the warm and sparse p50s separately.
- If SIN samples can't be had, use the nearest APAC colo and say so.

**Under test:**
- `https://vector-nusmods.jacobjameswiltshire.workers.dev`, Worker `vector-nusmods`;
- version `ea066ead-8e61-4b1a-b019-2cb85cc6766f`, tag `238e721`, checked on `/health` and on
  every response's `x-app-version`. It is the frozen ranker `phase3-final` (`c787dea`) plus the
  deploy guard's port fix, which is outside the Worker;
- dense search exact in the Worker (production bundle, 6,778 vectors);
- D1 `nusmods-apac`, primary in APAC, read replication on.

**`total`.** The Server-Timing `total` span runs from fetch entry until the response headers are
set (`src/index.js`, `src/timing.js`). Per-span: `cache`, `limit`, `pin`, `embed`, `vector` (the
in-Worker dot product, or Vectorize on the standby), `fts`, `hydrate` and `variants` (3F). The
collector also records the client's time to headers (`headersMs`).

**Queries** (`sc7-queries.tsv`).
- 45 ordinary student-style searches, written for this run at the freeze: 33 warm (`w01`–`w33`)
  and 12 sparse (`s01`–`s12`).
- 23 are unfiltered. 22 use `sem`, `ng=1`, `level` or a combination.
- None appears in dev, the SC4 suite, Phase 1's SC7 queries or `requests.tsv`, checked by exact
  match on the canonical form.
- Each is sent once, so every call should miss the cache. A sample counts only if its header
  says `cache;desc=miss`.

**Calls** (`sc7-collect.mjs`). One `GET /search` per query, with Node `fetch`, a desktop Chrome
User-Agent, and no retries.
- **Warm:** request starts 3 s apart, in list order, until 30 samples are SIN 200s or 33 calls
  are spent.
- **Sparse:** starting ≥ 10 min after the warm run, 12 calls with request starts 630 s apart
  (~2 h).
- **Budget:** at most 45 `/search` calls, enforced by the collector. No pilot.
- **Re-run:** a single re-run is allowed, with 45 new fresh queries and the same rule, only if
  the counted run ends with fewer than 30 warm or 10 sparse SIN samples because of colo
  assignment. No other reason allows a re-run.

**VPN:** off for the run (Jacob, `docs/plans/phase3.md` §10 Q2).

**Colo rule.** Only samples whose `cf-ray` ends in `-SIN` are judged. Others are kept, listed and
reported separately.

**Exclusions.**
- Left out of the pool and listed: non-200 responses, responses that are not `cache;desc=miss`,
  and samples inside an ingest window the lead declares by UTC timestamps. No ingest is planned.
- Degraded (keyword-only) samples stay in the pool and are counted.

**Logs.** `npx wrangler tail vector-nusmods --format json` (read-only) runs for the whole
collection. `sc7-analyse.mjs --extract` keeps only the Worker's own `"event":"search"` lines for
these 45 queries in `sc7-logs.jsonl`. The raw tail stays in `/tmp`.

**Analysis** (`sc7-analyse.mjs`, unchanged from Phase 1 except the span list):
- p50 and p90 by linear interpolation (R type 7);
- a 95% percentile bootstrap CI of the median, with 10,000 resamples and seed 7;
- reported for the pooled set (the rule), for warm and sparse separately, and for non-SIN
  samples;
- per-span p50s;
- per query: colo, `total`, the spans, D1 queries and rows read.

**Graceful degradation** is checked by the B6 tests in `test/findings/backend.test.js`, run
locally (`npm test`).

**Call log.** Every call is a row in `sc7-requests.tsv`, numbered `s7-1`, `s7-2`, …, and the lead
merges them into `docs/evidence/requests.tsv`.

## Results
Not collected yet.
