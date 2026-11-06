# Step 3-0.0: embed-latency check (2026-11-06)

**Result: Q3 does not trigger.** With in-Worker exact vectors, the projected warm p67 is
**160.6 ms** over all 12 burst samples, or 156.8 ms without the cold first sample. Both are
under the ~200 ms trigger, so 3-0 goes ahead without asking Jacob.

## Method (plan §2, 3-0.0)
- **Collector:** `embed-burst.mjs`, sent once against production version tag `597c2b7`,
  D1 `nusmods-apac`. Jacob had the VPN off.
- **Routing:** the first `/health` probe went to HKG. A probe on a fresh connection went to
  SIN, and the burst used that keep-alive connection (`sameSocket: true` on every sample).
- **Queries:** 12 fresh ones from `embed-burst-queries.tsv`, none from the dev set, Phase 1's
  SC7 queries or earlier logged calls. They were sent 2 s apart, with no filters and no retries.
- **Recorded per sample:** time to response headers (`ttfbMs`), time to body end (`clientMs`) and
  `Server-Timing`. Raw data is in `embed-burst.jsonl`.
- **An earlier attempt** sent one `/health` probe (HKG) and then crashed in the collector before
  any search. That probe is not in the JSONL. `/health` touches no binding.
- **Projection, per sample:** cache + max(embed + 5, fts, pin) + hydrate, then the p67 by
  linear interpolation. The Worker has no `pin` span yet, so pin = 0.

## Numbers (ms)

| sample set | n (SIN, 200) | projected median | projected p67 | embed median / p67 | current total median / p67 |
|---|---|---|---|---|---|
| this burst, all | 12 | 154 | **160.6** | 90 / 96.1 | 333 / 337.1 |
| this burst, b02–b12 (b01 is the cold first call) | 11 | 154 | 156.8 | 88 / 94.1 | 332 / 335.4 |
| Phase 1 warm (`../phase1/sc7-samples.jsonl`) | 30 | 119.5 | 140.0 | 88 / 99.3 | 350.5 / 367.2 |

- **Embed time** is unchanged since the APAC switch, at median 88–90 ms. The 260–414 ms seen
  right after the switch (`requests.tsv` 72–73) were cold calls just after a deploy.
- **The current warm total**, median 333 ms, still fails SC7 (250 ms). Vectorize is about
  180 ms of it.
- **Hydrate:** warm hydrate is about 44–62 ms here. Phase 1 recorded about 10–42 ms from an
  APAC replica. That is why the projection is ~20 ms above Phase 1's.
- **TTFB baseline before 3-0** (warm, SIN, keep-alive): median 371 ms over b02–b12. The 3-0 PR
  reports TTFB against this figure. There is no guard threshold (B2-7).

## The cold first call (b01)
- **Timings:** b01 is the first search after about two days without traffic. It took embed 242,
  vector 1,417, fts 1,044, hydrate 84 and total 1,769 ms.
- **What 3-0 doesn't fix:** in-Worker vectors remove the 1,417 ms vector cost. The 1,044 ms fts
  on a cold D1 path stays, even with an APAC primary.
- **Why it matters for SC7:** the counted run includes 12 calls spaced about 10 minutes apart. A
  cold path in those calls can still move the p50.
- **What the plan does about it:** SC7's protocol already reports cold and warm samples
  separately. This is recorded as a risk for the counted run, not as a Q3 trigger.

## Cost
- 12 `/search` calls, plus 3 `/health` probes including the crashed attempt.
- **D1:** reads only, roughly 1–2k rows. The Workers analytics token had expired, so
  month-to-date headroom wasn't checked. Reads are about 0.00001% of the 25B allowance.
- **Workers AI:** about 12 × 0.03 neurons.
- **Vectorize:** 12 × 384 queried dims plus the stored term.
- **Log:** `requests.tsv` row 75.
