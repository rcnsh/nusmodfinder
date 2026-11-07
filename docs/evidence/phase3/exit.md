# Phase 3 exit: where each criterion stands (2026-11-08)

Exit criteria: `docs/plans/phase3.md` §8. The ranker is frozen at `phase3-final` (`c787dea`) and
live as version `ea066ead` (tag `238e721`).

| criterion | status | evidence |
|---|---|---|
| **SC5**: one look passes, under the sealed reading Jacob chose before L1 | **met** | `sc5.md`: ΔnDCG@10 +0.120 [0.083, 0.161], ΔP@5 +0.059 [0.036, 0.090] over 195 queries vs `eval-v0` |
| **SC7**: the counted run at the frozen ranker passes | **pending** | `sc7.md`: the method and queries are committed, and the run waits on the VPN being off |
| SC7: the B6 fallback tests pass | met | `npm test` (`test/findings/backend.test.js`), green at `phase3-final` in CI |
| SC7: the startup gate passed on every deploy | met | `npm run deploy` promotes only below 200 ms. The 3H ship's figure was printed but not kept |
| **SC4**: the suite is green in CI at `phase3-final`, and the live confirmation agrees | **not met in full** | CI is green (59 items run, 31 listed as waiting). The waiting items are 3D's level items and 3H's 14 parsed-intent items, both for Phase 4 (Jacob's decisions). `sc4-live.txt`: 20 live calls agree on every rule they sample |
| **FINDINGS S2–S8** `fixed` or `rejected` | **not met** | S5, S7 and S8 are fixed. Four still reproduce, because the changes aimed at them were dropped at their gates (listed below) |
| README's cost section names the binding limit | met | README "Cost": Workers CPU or Workers AI neurons, since 3-0 |
| ADR 0006 carries the bundle size, startup time and CPU per query | met (startup local only) | ADR 0006 "Measured at 3-0" and "Measured live" |

The four open findings:
- **S2** (equal-weight RRF): 3E dropped at the dev screen.
- **S3** (query prefix half): 3A-1 dropped at the dev screen. The passage-text half is fixed.
- **S4** (stopword half): `stopwords-v2` was not selected. The code and fuzzy halves are fixed.
- **S6** (graduate flood): 3D dropped after two failed looks.

## Holdout and test-set use
- **Holdout:** 7 of 12 looks used (`eval/holdout-ledger.md`).
- **Test set:** its one look is spent.

## Left for Phase 4
- 3D's level intent (branch `level-intent-3d`).
- 3H's phrase parsing (`PARSE_PHRASES`).
- The open findings above.
- A compliance-measuring rule for parsed constraints. Judges never see constraint fields, so a
  relevance-only rule scores a hard filter's intended removals as loss.
