# 3-0 cutover: live evidence (2026-11-06)

Production has served in-Worker exact vector search since version
**`343ea371-1da0-46b2-9299-4d74770acf5a`** (tag `e8a7124`), deployed at 10:28:51 UTC. The local
evidence (identity, bundle size, CPU benchmark) is in `3-0.md`, and every remote step is logged in
`remote-ops.md`.

## Runbook as run
1. **Bundle built:** the production bundle covers 6,778 rows at data version `c1cf88518972`.
   - 169 texts missing from `emb-bge-small-v0` were embedded (53.5 neurons).
   - The bundle was uploaded as `vec-production-c1cf88518972-emb-bge-small-v0-xd4228f1d` and its
     manifest entry merged in PR #36.
2. **D1 untouched:** the offline data version equalled the committed one, so D1 already held
   these rows. Steps 3–4 wrote nothing. The bookmark is still recorded.
3. **Pre-deploy verify (step 5):** D1, the manifest and the bundle agree on 6,778 rows, rowsKey
   `aeebeb1e…`, data version and row hashes.
4. **Deploy (step 6):** the guard, the startup gate, `versions upload` and `versions deploy` all
   passed.
   - **Startup time is not recorded:** the gate passed it under 200 ms, but my output filter
     dropped the printed figure, and `wrangler versions view --json` does not return it. The next
     deploy records it. Locally, `wrangler check startup` showed 0 ms of active CPU, because the
     bundle is read on the first search (`3-0.md`).
5. **Smoke (step 7):** `/health` reports `vectors.corpus: "production"`, 6,778 rows, data version
   `c1cf88518972`. Two searches went through SIN, returned 200 with 20 results each and were not
   degraded.
6. **Standby (step 8):** 6,778 upserts with full metadata and 0 deletes. Verify then found D1 and
   Vectorize agreeing, with 0 drift in 100-row metadata and value samples. Vectorize is an exact
   standby for the bundle.

## Latency: warm burst on one SIN keep-alive connection, 12 fresh queries each (ms)

| | before (`ee96bbd0`, Vectorize) | after (`343ea371`, in-Worker) |
|---|---|---|
| server `total`, p50 / p67 (all 12) | 333 / 337.1 | **132 / 168.1** |
| server `total`, p50 / p67 (warm, calls 2–12) | 332 / 335.4 | **131 / 156.8** |
| TTFB p50 (warm, calls 2–12) | 371 | **231** |
| `embed` p50 | 90 | 72.5 |

- **The projection held:** step 3-0.0 projected a warm p67 of 160.6 ms (`embed-latency.md`),
  and the measured warm p67 is 156.8 ms.
- **Not the SC7 verdict:** SC7 is a pooled p50 under 250 ms over warm and sparse samples, taken
  in the counted run at the Phase 3 freeze (plan §3). This burst shows the warm half is now well
  under the target. The sparse, cold half is still unmeasured; see `embed-latency.md`, "The cold
  first call".
- **Where the burst ran:** VPN off; the first SIN connection came on the fourth probe (NRT, HKG,
  HKG, SIN).
- **One query overlaps a dev topic:** p12, "maritime law and shipping contracts", overlaps the
  topic of a dev query. That breaks this burst's freshness rule, but not the eval, which makes no
  live calls.
- **Raw data:** `post-3-0-burst.jsonl` and `post-3-0-burst-queries.tsv`.

## CPU per request (B-5, B2-8)
Workers Logs (`CPUTimeMs`) is not readable with the wrangler OAuth token (HTTP 403). The figures
come from GraphQL `workersInvocationsAdaptive` instead, filtered to `343ea371`, over the first 18
recorded requests. Those are the 3 smoke calls plus burst probes and searches, so `/health` calls
are mixed in.
- **CPU (µs):** p25 7,318, p50 9,145, p75 15,459, p99 34,152. Wall time p50 148 ms.
- **The two smoke searches** each used 33–34 ms of CPU. They probably ran on fresh isolates,
  which pay the one-off bundle read and the first unoptimised search.
- **Against the plan's estimate:** 5 ms per search in the plan, against about 9–15 ms measured
  per mixed request.
- **Monthly capacity at that rate:** 30M included CPU-ms / ~12 ms ≈ **2.5M requests a month**.
  That is still about 20 times the old Vectorize-bound limit of ~123k searches. CPU becomes the
  binding allowance, with a lot of headroom.
- **README:** the cost section quotes this measured range, not the plan's 5 ms.
