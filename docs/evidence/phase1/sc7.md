# SC7: search latency, D1 read replication and rows read per search

Criterion (`docs/CRITERIA.md`): search p50 server time under 250 ms on a cache miss, measured
with `Server-Timing` from the deployed Worker; graceful fallback to keyword-only if Workers AI or
Vectorize fails.

## Method (pre-registered; committed before any sample was collected)

**Rule** (`docs/plans/phase1.md`, "SC7 measurement (changes vs r1)" and "Final" item 2, unchanged
here): pool every SIN-colo cache-miss sample, at least 30 distinct queries spaced ≥ 2 s apart plus
at least 10 sparse samples ≥ 10 min apart. **Pass iff the point-estimate p50 of `total` < 250 ms.**
Report a bootstrap CI and the warm and sparse p50s separately. If SIN samples can't be obtained,
use the nearest APAC colo and say so.

**Under test.** `https://vector-nusmods.jacobjameswiltshire.workers.dev`, Worker `vector-nusmods`,
version `78ef263b-4039-4c7c-9b79-eb17443e68d3`, tag `8d94982` (checked on `/health` and on every
response's `x-app-version`). D1 primary WEUR, read replication `mode: auto`
(`remote-ops.md`, 2026-11-03 21:57:02).

**`total`.** The Server-Timing `total` span: `performance.now()` from fetch entry to the moment
the response headers are set (`src/index.js`, `src/timing.js`). It includes `cache.match` and the
rate limiter. workerd's clock advances only across I/O, so spans measure waiting on bindings.
Per-span: `cache`, `limit`, `pin`, `embed`, `vector`, `fts`, `hydrate` (`src/search.js`).

**Queries** (`sc7-queries.tsv`). 45 ordinary student-style searches written for this run, none
taken from the eval sets (dev, fixtures, v1; checked by exact match on the canonical form) or
earlier `requests.tsv` calls. 33 warm (`w01`–`w33`) and 12 sparse (`s01`–`s12`). Mixed:
unfiltered, and filtered with `sem`, `ng=1`, `level` and combinations (23 unfiltered,
22 filtered). Each query is sent exactly once, so every call should miss the cache; a sample
counts only if its header says `cache;desc=miss`.

**Calls** (`sc7-collect.mjs`). One `GET /search` per query, Node `fetch`, a desktop Chrome
User-Agent, no retries (an error is recorded as-is). Each sample records its UTC start, the
path, HTTP status, `cf-ray` (colo = the suffix), `x-app-version`, the raw `Server-Timing`
and its parsed spans, and the response's `count`/`degraded`.
- **Warm:** request starts 3 s apart, in list order, until 30 samples are SIN 200s or 33 calls
  are spent.
- **Sparse:** starting ≥ 10 min after the warm run, 12 calls with request starts 630 s apart
  (~2 h).
- **Budget:** at most 45 `/search` calls in total, enforced by the collector; no pilot.

**Colo rule.** Only samples whose `cf-ray` ends in `-SIN` are judged. Others are kept, listed
and reported separately.

**Deviation: VPN on.** The rule says "VPN off". At collection time this Mac's default route is a
Mullvad VPN tunnel (exit `146.70.199.165`, AS9009 M247, Singapore). Jacob decided to keep it on
(it is a machine-level privacy setting) and collect through the Singapore exit, since the rule's
intent is SIN-colo samples; non-SIN samples stay out of the pool. Five `/health` probes through it
before collection were served by SIN, HKG, SIN, SIN, NRT. Node `fetch` reuses a keep-alive
connection between warm calls 3 s apart, so warm samples likely share the first connection's colo;
sparse calls 10 min apart open new connections. If the 45-call cap leaves fewer than 30 warm or
10 sparse SIN samples, collection stops at the cap and the shortfall is reported; the cap is not
exceeded.

**Exclusions.** Non-200 responses, any response that is not `cache;desc=miss`, and samples inside
an ingest window the lead declares (by UTC timestamps) are left out of the pool and listed.
Degraded (keyword-only) samples stay in the pool and are counted.

**Logs.** `npx wrangler tail vector-nusmods --format json` (read-only) runs in the background for
the whole collection. `sc7-analyse.mjs --extract` keeps only the Worker's own `"event":"search"`
lines for these 45 queries (`sc7-logs.jsonl`; the raw tail, which holds request headers, stays in
`/tmp`). From each: `colo`, `d1.queries`, `d1.rowsRead` (summed over the search's D1 calls),
`d1.servedByRegion` (distinct `meta.served_by_region` values) and `d1.servedByPrimary` (true iff
every D1 call that reported it was served by the primary). The read session is
`withSession('first-unconstrained')` (`src/modules.js`).

**Analysis** (`sc7-analyse.mjs`). p50 and p90 by linear interpolation (R type 7); 95% percentile
bootstrap CI of the median, 10,000 resamples, seed 7. Reported for the pooled set (the rule),
warm and sparse separately, and non-SIN samples separately. Per-span p50s (warm, sparse,
pooled). Per query: colo, `total`, `fts`, `hydrate`, D1 queries, rows read, serving region
and primary flag. Rows read per search: min/p50/p90/max/mean, all, unfiltered and filtered.

**Graceful degradation** is checked by the B6 tests in `test/findings/backend.test.js`, run
locally (`npm test`).

**Call log.** Every call is a row in `sc7-requests.tsv` (format of `docs/evidence/requests.tsv`,
numbered `s7-1`, `s7-2`, …; the lead merges them).
