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

## Results (collected 2026-11-04 06:17–07:22 UTC)

**Verdict: FAIL.** Pooled SIN cache-miss p50 of `total` = **351.0 ms** (95% bootstrap CI
343.0–385.0, n = 33) against the < 250 ms rule. Warm p50 350.5 ms (n = 30, CI 341.0–368.5);
sparse p50 871.0 ms (n = 3; with three samples the bootstrap CI, 856.0–1028.0, only spans the
data). The `total` of every one of the 33 SIN samples is ≥ 304 ms.

**Shortfall: 3 SIN sparse samples, not ≥ 10.** The warm run gave 30 of 30 SIN (one keep-alive
connection). The first six sparse calls, each on a fresh connection through the VPN exit, were
served by NRT, NRT, SIN, SIN, SIN, MRS. With 6 of the 12 pre-registered sparse calls left, at most
9 SIN sparse samples were reachable, so collection stopped at 07:22:47 UTC after 36 of 45 calls,
as Jacob instructed (stop and report rather than stretch the method). This shortfall cannot change
the verdict. 33 SIN samples are ≥ 304 ms. The 45-call cap allows at most 9 more. Even if all 9 were
faster, the pooled median of 42 is the mean of the 21st and 22nd smallest, both ≥ 304 ms.

No ingest window was declared during collection; nothing is excluded. Every call returned 200
with `cache;desc=miss`, version `78ef263b` / `x-app-version 8d94982`, none degraded. 36 of 36
calls have a matching structured log line.

### Latency by span

| span | warm p50 | sparse p50 | pooled p50 | pooled p90 |
|---|---|---|---|---|
| cache | 8.0 | 25.0 | 9.0 | 20.0 |
| limit | 0.0 | 0.0 | 0.0 | 0.0 |
| embed | 88.0 | 227.0 | 92.0 | 226.8 |
| vector | 232.0 | 272.0 | 232.0 | 276.8 |
| fts | 19.0 | 616.0 | 20.0 | 461.6 |
| hydrate | 13.0 | 214.0 | 13.0 | 208.6 |
| **total** | **350.5** | **871.0** | **351.0** | **868.0** |

`embed`→`vector` and `fts` run concurrently, so `total` ≈ `cache` + max(`embed`+`vector`,
`fts`) + `hydrate`. In the warm state the dense half (`embed` + `vector`, ~320 ms at the median)
sets the total; `vector` alone is ~232 ms on every warm search. In the sparse and cold samples
`fts` (520–715 ms) and `hydrate` (201–250 ms) dominate instead.

### Replication: where D1 served each search

Primary WEUR, replication `mode: auto`, session `first-unconstrained`.

- **Cold start and every sparse search went to the WEUR primary.** s7-1 to s7-3, the first three
  warm searches, logged `servedByRegion: ["WEUR"]`, `servedByPrimary: true`, with `fts` 215–573 ms
  and `hydrate` 203–211 ms. The same holds for all six sparse searches (s7-31 to s7-36, each after
  ≥ 10 min idle): `fts` 520–715 ms and `hydrate` 201–250 ms from SIN and NRT. The MRS sample,
  served from Marseille, logged `fts` 128 ms and `hydrate` 83 ms against the same primary.
- **From s7-4 on, an APAC replica served the warm burst.** s7-4 logged both regions (`WEUR, APAC`):
  its `fts` (227 ms) took primary-like time and its `hydrate` (13 ms) did not. The log records the
  set of regions, not which query went where. s7-5 to s7-30 logged `["APAC"]`,
  `servedByPrimary: false`, with `fts` 13–42 ms and `hydrate` 10–22 ms.
- So the pilot's `fts;dur=588, hydrate;dur=201` matches the pattern logged here for searches the
  primary served. In these logs, after ≥ 10 min without traffic, D1 reads went to WEUR rather than
  a nearby replica. The logs do not show why.

| samples | servedByRegion | servedByPrimary | n |
|---|---|---|---|
| s7-1–3, s7-31–36 | WEUR | true | 9 |
| s7-4 | WEUR, APAC | false | 1 |
| s7-5–30 | APAC | false | 26 |

### D1 rows read per search (`d1.rowsRead`, from the log)

| | n | min | p50 | p90 | max | mean |
|---|---|---|---|---|---|---|
| all | 36 | 137 | 244 | 744.5 | 1,784 | 406.4 |
| unfiltered | 18 | 137 | 239 | 239 | 239 | 233.3 |
| filtered | 18 | 249 | 497 | 857.8 | 1,784 | 579.4 |

17 of 18 unfiltered searches read exactly 239 rows; `entrepreneurship startup` read 137. Filtered
searches range from 249 (`sem=2`) to 1,784 (`creative writing workshop`, `sem=2&ng=1`, which ran 3
D1 queries); `level` filters read 617–757. Every search is under the plan's 8k worst-case gate. The
per-query table is in the analysis output (`node sc7-analyse.mjs`).

### Graceful degradation (B6)

Local run on this branch, 2026-11-04 (`npx vitest run test/findings/backend.test.js -t B6`): 4 of 4 pass.

- `[B6 fixed] ai throwing in hybrid mode returns the keyword results, flagged degraded and cached for 60 s`
- `[B6 fixed] vectorize throwing in hybrid mode returns the keyword results, flagged degraded and cached for 60 s`
- `[B6 fixed] mode=vector still fails loudly with a 502 from the failing binding`
- `[B6 fixed] after 3 consecutive dense failures the dense half is skipped for 30 s, then retried`

The full `npm test` also passes (463 tests). No live sample was degraded.

### Files

`sc7-samples.jsonl` holds the raw client samples: UTC, path, status, cf-ray, every Server-Timing span.
`sc7-logs.jsonl` holds the Worker's search log lines for these queries, extracted from
`wrangler tail`. `sc7-requests.tsv` is the call log (s7-1 to s7-36). Reproduce the tables with
`node docs/evidence/phase1/sc7-analyse.mjs`.

The tail ran in one session from 06:16:46 to 07:22:47 UTC, covering every call. An earlier tail
session, started before any search, dropped on keep-alive pings and was restarted before collection.
