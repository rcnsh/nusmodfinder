# Phase 6 remote operations log

Every remote operation, reads included, with its estimate and actual. Times are UTC. Headroom
rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance).

## 2026-11-12: the Phase 6 ship (6A–6D, code-only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 18:38:14–18:38:32 | `wrangler dev --remote --port 8791` with a one-off `INGEST_SECRET` (`.dev.vars` backed up first and restored at 18:38:32; port 8791 free afterwards), then `npm run verify -- --url http://localhost:8791 --pre-deploy` | ~6.8k rows read | 6,778 rows read; rowsKey and data version agree; 0 drift; acad year 2026-2027 in D1, `ng-reasons.json` and `ng-unscheduled.json`; the file holds exactly the NG codes with no D1 row |
| 18:38:59 | `/health` (`requests.tsv` 124): version `59986aa3` (tag `965aaf9`) | 1 call | 1 call |
| 18:39:04–18:39:46 | `npm run deploy` of `0b5f360` (guard read 6,778 D1 rows; no D1 write; `wrangler triggers deploy` for the custom domain) | ~6.8k rows read | version **`f8aefeab-49c4-4548-b994-73bc6bae4f86`** (tag `0b5f360`), startup 2 ms |
| 18:39:54–18:40:15 | Smoke, ≥ 5 s apart (`requests.tsv` 124): `/health` (tag `0b5f360`); `/module/ACC1701XB` (`otherCodes` 8 codes, `gradingBasis` Graded); `/module/EE4407` (404, NG-listed with no classes); `machine learning` (EE2211 first); `/?pick=CS2113.1&alt=GE2101.1&view=shortlist` (200) | 5 calls | 5 × 200/404 as expected |

Headroom: about 14k rows read and under 10 requests; the rule holds by orders of magnitude.

Rollback: `npx wrangler rollback 59986aa3-48d9-4344-8f5d-29e095709ca6` (code-only). A rolled-back
page keeps `pick` and `alt` but drops `ay`, `inv` and `view` from a link it settles (plan §3 6E).
