# Phase 7 exit checks

## 7A CI and the ranking lock (merged as `51851b6`, PR #103)

| Check | Evidence | Result |
|---|---|---|
| `main` green after the merge | CI run 43143948232 on `51851b6`: `changes`, `check`, `eval-gate`, `full-corpus`, `sc1`, `ui (chromium)`, `ui (webkit)` all succeeded; Findings succeeded | pass |
| A PR that edits only `docs/REFERENCE.md` runs `check`, and `eval-gate` takes its fast path | PR #104 (closed unmerged), CI run 43145128798: `check` ran in full (181 s, success); `eval-gate` took "Fast path (the lock and the eval's inputs unchanged)" in 9 s; `full-corpus`, `sc1` and both `ui` jobs started and skipped by steps (3–29 s) | pass |
| A PR that changes `RRF_K` fails `eval-gate` | PR #105 (closed unmerged), `src/search.js:98` `RRF_K` 60 → 30, CI run 43145138172: `eval-gate` failed in 71 s and named every changed query (dev filtered, `--strip ng` and unfiltered, plus fixture lists, e.g. `fixture filtered fx-01: status 200 -> 200 (codes or their order changed)`). `check` failed too, from the existing 1B differential test (`test/differential.test.js`, 289 differing requests), a second guard catching the same change | pass |
| The slow path within a 15-minute budget | PR #103's first `eval-gate` run: 46 s to recompute, 64 s for the job (timeout 12 min); PR #105: 71 s | pass |
| Production schema equals the full-chain snapshot | `scripts/schema-snapshot.mjs --compare-remote docs/evidence/phase7/schema`: equal in every section, same set of 10 migrations, applied 0008 before 0007 (PR #103 body) | pass |

## 7D the corpus manifest and the live year (merged as `96c3103`, PR #107)

| Check | Evidence | Result |
|---|---|---|
| `main` green after the merge | CI run 43171399659 on `96c3103`, every job succeeded; the Deploy workflow skipped (`DEPLOY_FROM_ACTIONS` unset) | pass |
| The 162 codes, locally | `test/sc1/catalogue.test.js` over production: 149 answer `not-offered`, 9 `ng-unscheduled` (NG-listed, no classes), 4 don't parse as a code (EX2991, EX2992, EX3993, EX4995: no offered course has the EX prefix; a parse rule older than 7D, left as a known limit because changing it changes ranking) | pass, with the 4 recorded |
| `sc1` green over production | PR #107's CI, and `main`'s; 15 passed, 0 skipped locally | pass |
| The lock passes as ranking-neutral | `eval-gate` on PR #107 and on `main`; `eval/ranking-lock.json` unchanged | pass |
| One `catalogueKey` read of D1 from merged `main`, after a preflight | 2026-11-12 07:05:09 UTC, `SELECT code FROM catalogue_only` over the D1 REST client (read-only): 14,430 codes, `catalogueKey` `5b1e2f06e559`, equal to `data/catalogue-codes.json` (14,430 codes); 14,430 rows read, 0 written (run record `20261112T070509Z-catalogue-read-9380.json`; the try at 07:05:01 stopped before any request, for want of an account id: `…-dfc9.json`). The back-filled `deploy/*` tags carry the same key and were pushed after this read. `npm run deploy -- --preflight` on `96c3103` passed at 07:05:30 (`…-deploy-preflight-2c6b.json`) | pass |
