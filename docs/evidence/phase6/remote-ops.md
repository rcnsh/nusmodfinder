# Phase 6 remote operations log

Every remote operation, reads included, with its estimate and actual. Times are UTC. Headroom
rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance).

> **Correction (Phase 7 7C, 2026-11-12).** The headings below say 2026-11-12, but the times in
> their tables are UTC on 2026-11-11: the Phase 6 ship ran 18:38–18:40 and the live check
> 19:16–19:19 on 2026-11-11 (`0b5f360`, the commit deployed, was committed at 18:37:35 UTC on
> 2026-11-11). The red-team follow-up ran from 23:58:49 on 2026-11-11 to 00:00:02 on 2026-11-12
> (`a23601d` was committed at 23:58:29 UTC on 2026-11-11). `requests.tsv` rows 124, 125 and 127
> carry the same slip; row 143 there corrects them. The headings stay as written.

## 2026-11-12: the Phase 6 ship (6A–6D, code-only)

> Correction: 2026-11-11 UTC (see the note above).

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 18:38:14–18:38:32 | `wrangler dev --remote --port 8791` with a one-off `INGEST_SECRET` (`.dev.vars` backed up first and restored at 18:38:32; port 8791 free afterwards), then `npm run verify -- --url http://localhost:8791 --pre-deploy` | ~6.8k rows read | 6,778 rows read; rowsKey and data version agree; 0 drift; acad year 2026-2027 in D1, `ng-reasons.json` and `ng-unscheduled.json`; the file holds exactly the NG codes with no D1 row |
| 18:38:59 | `/health` (`requests.tsv` 124): version `59986aa3` (tag `965aaf9`) | 1 call | 1 call |
| 18:39:04–18:39:46 | `npm run deploy` of `0b5f360` (guard read 6,778 D1 rows; no D1 write; `wrangler triggers deploy` for the custom domain) | ~6.8k rows read | version **`f8aefeab-49c4-4548-b994-73bc6bae4f86`** (tag `0b5f360`), startup 2 ms |
| 18:39:54–18:40:15 | Smoke, ≥ 5 s apart (`requests.tsv` 124): `/health` (tag `0b5f360`); `/module/ACC1701XB` (`otherCodes` 8 codes, `gradingBasis` Graded); `/module/EE4407` (404, NG-listed with no classes); `machine learning` (EE2211 first); `/?pick=CS2113.1&alt=GE2101.1&view=shortlist` (200) | 5 calls | 5 × 200/404 as expected |

Headroom: about 14k rows read and under 10 requests; the rule holds by orders of magnitude.

Rollback: `npx wrangler rollback 59986aa3-48d9-4344-8f5d-29e095709ca6` (code-only). A rolled-back
page keeps `pick` and `alt` but drops `ay`, `inv` and `view` from a link it settles (plan §3 6E).

## 2026-11-12: the live check

> Correction: 2026-11-11 UTC (see the note above).

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 19:16:16–19:19:09 | `node scripts/p6-live.mjs` on version `f8aefeab` (`requests.tsv` 125, `p6-live.jsonl`): `/facets`, 8 `/module` for a 6-pick, 2-backup list across Sem 1 and 2, 3 `/module` 404s (one of each kind), then the page's files once; Chromium and WebKit fulfilled from memory | ~43 calls | 43 sent (12 API, 31 page files), one at a time, ≥ 4 s apart; **18 of 18 checks pass** |

## 2026-11-12: the red-team follow-up (code-only)

> Correction: 2026-11-11 23:58 to 2026-11-12 00:00 UTC (see the note above).

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 23:58:49 | `/health` (`requests.tsv` 127): version `f8aefeab` (tag `0b5f360`) | 1 call | 1 call |
| 23:58:54–23:59:33 | `npm run deploy` of `a23601d` (guard read 6,778 D1 rows; no D1 write) | ~6.8k rows read | version **`b0834844-f6fd-4bb9-838d-a45927c195fb`** (tag `a23601d`) at 100% |
| 23:59:53–00:00:02 | Live re-check (`requests.tsv` 127), 2 Chromium page loads ≥ 6 s apart: a list with CS2030 (Sem 2) and CS2113 (Sem 1) under `sem=2` reads "Sem 1 and Sem 2 · 3rd-year exchange student · NUS's 2026/27 courses" (RT6-PD1); CS4268 for a 2nd-year in Sem 2 reads "Sem 2 · Open, with 1 note" with GRO's line (R6-2) | ~70 calls (page files included) | 68 calls, both as fixed |

Rollback: `npx wrangler rollback f8aefeab-49c4-4548-b994-73bc6bae4f86` (code-only).
