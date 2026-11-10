# Phase 5 gates

## 5A: exam dates are ranking-neutral (pin move, no look)

Plan §3 5A: the dev set and the eval's fixture set, run at the 5A commit, must be byte-identical
to the shipped-ranker pin `9d91605`'s. Then `SHIPPED_BASELINE` moves with a "ranking-neutral"
line, and the custodian counts the holdout lists that differ (expected 0).

5A changes ranker files (`src/`, `migrations/`, `scripts/lib.mjs`, `data/`), so `ranker.treeHash`
differs (`8e94e8274306` at `9d91605`, `5c790ef78d27` at `f798542`; both clean). The ranking does
not change.

Local eval runs, `--ref 9d91605` against `--ref f798542`, the HEAD runner, sha256 of each run's
`results` (first 16):

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, the queries' filters | 98 | `8229314651577034` both | yes |
| dev, `--strip ng` | 98 | `ae4f077e0ad06ef2` both | yes |
| dev, `--unfiltered` | 98 | `8fde32e1783d6d6b` both | yes |
| fixture, `--strip ng` | 11 | `ce4f61e83ce5a52f` both | yes |

The `--strip ng`, `--unfiltered` and fixture hashes also equal Phase 4's (`docs/evidence/phase4/gates.md`
§3), so the lists have not moved since `238e721`.

Holdout, custodian only:
- `npm run eval -- --holdout --variant shipped-f798542 --ref f798542… --store-only`
  (`eval/holdout/run-shipped-f798542.json.enc`, 81 queries): no verdict, no ledger row;
- `npm run eval:count -- --custodian --holdout --lists-differing --run shipped-f798542 --baseline shipped-9d91605`
  printed `0` (`eval/count-log.md`). The new count kind prints one integer and is not a look
  (ADR 0003, "counts are not looks").

Holdout looks stay at 7 of 12. `SHIPPED_BASELINE` is `f798542`, with its ADR 0003 pin line.
