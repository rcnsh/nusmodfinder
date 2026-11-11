# Phase 6 gates

## 6A: `/module/:code`'s new fields and `ng-unscheduled.json` are ranking-neutral (no pin move)

6A adds `gradingBasis`, `otherCodes` and a 404's `kind` to `/module/:code`, a data file
(`data/ng-unscheduled.json`) and `/facets`' `offListRules`. On `/search` it changes only the
no-match branch and `notOffered`: a typed NG-listed code with no classes answers `ng-unscheduled`
instead of `unknown-code` or `not-offered`. The parse, the pins, both retrievers, the fusion and
the collapse are untouched. `src/` and `data/` are ranker files, so `ranker.treeHash` differs
(`fe8592741c02` at the pin `8a86bf6`, `a4deb6941c44` at `a05dfc7` and at `7974f5c`, 6A's last
ranker commit; all clean). The ranking does not change.

Local eval runs, `--ref 8a86bf6` (`SHIPPED_BASELINE`) against `--ref 7974f5c`, the HEAD runner,
sha256 of each run's `results` (first 16):

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, the queries' filters | 98 | `21245ed8fe04ba32` both | yes |
| dev, `--strip ng` | 98 | `62e5ab9a8150508f` both | yes |
| dev, `--unfiltered` | 98 | `a7593696c94b041a` both | yes |
| fixture, `--strip ng` | 11 | `7a5d58bbe50972c0` both | yes |

The four hashes equal those Phase 5 recorded at the pin (`docs/evidence/phase5/gates.md`, "The
red-team fixes ship"), and the same runs at `a05dfc7` (before the review fix, which touched only
`public/`) gave the same four. The same queries answer 400 on both sides (d-005, d-017, d-032,
d-042; fx-10). No holdout run, no count and no look; holdout looks stay at 8 of 12. The pin moves
with 6E's ship, as ranking-neutral.
