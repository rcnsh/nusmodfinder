# Phase 3 exit: where each criterion stands (2026-11-08)

Exit criteria: `docs/plans/phase3.md` §8. The ranker is frozen at `phase3-final` (`c787dea`) and
live as version `ea066ead` (tag `238e721`).

| criterion | status | evidence |
|---|---|---|
| **SC5**: one look passes, under the sealed reading Jacob chose before L1 | **met** | `sc5.md`: ΔnDCG@10 +0.120 [0.083, 0.161], ΔP@5 +0.059 [0.036, 0.090] over 195 queries vs `eval-v0` |
| **SC7**: the counted run at the frozen ranker passes | **met** | `sc7.md`: pooled SIN cache-miss p50 of `total` 186.0 ms (95% CI 164.0–224.0, n = 41: 30 warm and 11 sparse) against < 250 ms. The sparse p50 alone is 274.0 ms (reported, not judged). The 12th sparse call was not sent because the harness stopped the collector, and 11 meets the ≥ 10 rule |
| SC7: the B6 fallback tests pass | met | `npm test` (`test/findings/backend.test.js`), green at `phase3-final` in CI |
| SC7: the startup gate passed on every deploy | met | `npm run deploy` promotes only below 200 ms. The 3H ship's figure was printed but not kept |
| **SC4**: the suite is green in CI at `phase3-final`, and the live confirmation agrees | **not met** | CI is green, but 31 of 90 items don't run. They need 3D's level parsing (dropped) or 3H's phrase parsing (off), both left for Phase 4 by Jacob's decisions. Six of them are rows the plan says are never skipped: typo sc4-026 and guards sc4-064, 078, 079, 080 and 081. Each expects a level window, and they would fail at `phase3-final`. The listing labels them `pending` and the suite stays green. They were pending at 3G's gate too, so `3g-gate.md`'s "typo … and guard items included" overstates it. Live (`sc4-live.txt`): 15 of 17 checks as written pass. L05 and L09 failed on checks stricter than the suite's rules. They were re-checked to the suite's rules with the last 2 calls (`sc4-live-recheck.mjs`; L09b uses a new text) and pass |
| **FINDINGS S2–S8** `fixed` or `rejected` | **not met** | S5, S7 and S8 are fixed. Four still reproduce, because the changes aimed at them were dropped at their gates (listed below) |
| README's cost section names the binding limit | met | README "Cost": Workers CPU or Workers AI neurons, since 3-0 |
| ADR 0006 carries the bundle size, startup time and CPU per query | met (startup local only) | ADR 0006 "Measured at 3-0" and "Measured live" |

The four open findings:
- **S2** (equal-weight RRF): 3E dropped at the dev screen.
- **S3** (query prefix half): 3A-1 dropped at the dev screen. The passage-text half is fixed.
- **S4** (stopword half): `stopwords-v2` was not selected. The code and fuzzy halves are fixed.
- **S6** (graduate flood): 3D dropped after two failed looks.

## Custody and test-set caveats (phase-exit red-team)
- **Look guard.** The ledger guard (`eval/lib/ledger.mjs`) reads the ledgers at HEAD and
  `origin/main` only. From the pushed commit `d85c3e1`, which holds the sealed runs but not the
  SC5 row, a second test-set look would have been allowed. The protection is the SC5 row
  reaching `main`, which this PR does. A guard that reads every pushed branch is left for
  Phase 4.
- **Leak filter gaps, as run.** It compared SC4 item texts but not the suite's 17 typo clean
  forms and constraint references. Re-checked by the custodian: no kept test query has cosine
  ≥ 0.9 to any of them. Its within-test step also dropped 2 typo variants for being close to
  their own source, which it should have exempted. The step can only drop queries, and the set
  is sealed as run.
- `sc5-secondary.mjs` re-reads the stored runs without the verdict path's pin and judged@10
  checks. Its filtered line reproduces the recorded verdict.

## Holdout and test-set use
- **Holdout:** 7 of 12 looks used (`eval/holdout-ledger.md`).
- **Test set:** its one look is spent.

## Left for Phase 4
- 3D's level intent (branch `level-intent-3d`).
- 3H's phrase parsing (`PARSE_PHRASES`).
- The open findings above.
- A compliance-measuring rule for parsed constraints. Judges never see constraint fields, so a
  relevance-only rule scores a hard filter's intended removals as loss.
