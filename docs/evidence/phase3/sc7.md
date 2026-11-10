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
- Phase 4 adds `study=ug2` to the 10 `ng=1` rows, since exchange mode now requires a year of
  study (`docs/plans/phase4.md` §3, B2-3). The run reported here sent them without it.
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

## Results (collected 2026-11-07 19:08–21:05 UTC)

**Verdict: PASS.** The pooled SIN cache-miss p50 of `total` is **186.0 ms** (95% bootstrap CI
164.0–224.0, n = 41), against the < 250 ms rule. The whole CI sits below 250 ms.

| set | n | p50 total | p90 total | 95% bootstrap CI of p50 |
|---|---|---|---|---|
| **pooled (the rule)** | 41 | **186.0** | 334.0 | 164.0–224.0 |
| warm | 30 | 173.5 | 266.2 | 139.0–202.5 |
| sparse | 11 | 274.0 | 367.0 | 175.0–334.0 |

- **Calls:** 41 of 45: 30 warm and 11 sparse. Every call returned 200 from SIN as a cache miss,
  on `x-app-version` `238e721`. Every log line carries `scriptVersion` `ea066ead`. Nothing was
  excluded, no ingest window was declared, and no sample was degraded.
- **Warm:** 30 calls, 30 SIN samples, so the run stopped at the method's 30.
- **Sparse: 11 calls, not 12.** The harness stopped the collector at its 2-hour background limit
  after s11 (21:05:15 UTC) and before s12 was due (about 21:15:45). The rule needs ≥ 10 sparse
  SIN samples, and 11 is enough, so no re-run is allowed or needed. s12 was not sent afterwards,
  because adding a sample after the timings were visible would be post hoc.
- **Sparse is slower.** Its p50 of 274.0 ms is above 250 ms. The rule judges the pooled p50
  only, and the sparse set is reported as the method says. The extra time is spread across
  `cache`, `embed`, `fts` and `hydrate`, which each roughly double, as fits a cold isolate and
  cold connections after 10 idle minutes. Phase 1's sparse p50 was 871.0 ms (n = 3).
- **Logs:** the read-only tail matched 41 of 41 calls (`sc7-logs.jsonl`). Every search was served
  by the APAC primary of `nusmods-apac` (`servedByPrimary` true).
- **Rows read per search:** p50 255, max 1,403. Unfiltered searches have a p50 of 240 and
  filtered ones 613.5.
- **Client time to headers** (`headersMs`, reported and not judged): p50 303 ms and p90 675 ms
  from the Mac in Singapore with the VPN off. This adds the network and TLS round trip to
  `total`.
- **Graceful degradation:** the B6 tests in `test/findings/backend.test.js` pass in `npm test`.

Per-span p50s over the pooled samples (ms):

| span | warm p50 | sparse p50 | pooled p50 | pooled p90 | n |
|---|---|---|---|---|---|
| cache | 4.0 | 15.0 | 4.0 | 18.0 | 41 |
| limit | 0.0 | 0.0 | 0.0 | 0.0 | 41 |
| embed | 54.5 | 107.0 | 61.0 | 131.0 | 41 |
| vector | 0.0 | 0.0 | 0.0 | 0.0 | 41 |
| fts | 50.0 | 110.0 | 55.0 | 117.0 | 41 |
| hydrate | 50.5 | 103.0 | 57.0 | 135.0 | 41 |
| variants | 47.0 | 44.5 | 45.0 | 49.4 | 27 |
| total | 173.5 | 274.0 | 186.0 | 334.0 | 41 |

- `vector` is the in-Worker dot product, which rounds to 0 ms. Phase 1's warm embed plus vector
  was about 320 ms. Here `embed`, `fts` and `hydrate` take roughly equal shares.
- **Per query:** `node docs/evidence/phase3/sc7-analyse.mjs` prints the per-query table, with
  colo, spans, D1 queries, rows read and serving region.
- **Analysis changes:** two printed labels in `sc7-analyse.mjs` were corrected after collection.
  The `--tsv` note now reads "phase3", and the serving-region line no longer says the primary is
  WEUR. No computation changed.
- **Call log:** `sc7-requests.tsv` (s7-1 to s7-41) is merged into `docs/evidence/requests.tsv` as
  row 105.
