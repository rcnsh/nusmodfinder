# 0013: CI's eval gate is a committed ranking lock

Status: accepted. How to use it is in [EVAL.md](../../EVAL.md#the-ranking-lock).

## Context
The holdout stays with the custodian and its key never enters CI (ADR 0003), so CI can't take a
look. It can still notice that a change moved a ranked list, and demand the evidence that such a
change is allowed.

## Decision
- **`eval/ranking-lock.json` holds**, for every open-set query, the sha256 of its HTTP status and
  ordered result codes: the dev set on the pinned corpus filtered, with `ng` stripped and
  unfiltered, and the fixture set in the same three modes. It also records `inputsHash` (the git
  objects of `LOCK_INPUTS` in `eval/lib/ranking-lock.mjs`), the embedding version, the corpus
  release and the evidence for its lists.
- **`npm run eval:lock -- --check`** (the `eval-gate` CI job) takes a fast path when the lock
  equals the base's and the inputs equal the lock's or the base's; otherwise it recomputes every
  list with the eval runner, offline, and requires them to equal the lock.
- **A neutral change never rewrites the lock**, so PRs never conflict on it.
- **Changing the lists needs evidence written after the base lock:** a holdout ledger row with
  verdict `pass` against the base's shipped pin (`holdout-pass <row>`), a count-log row naming a
  no-look route (`no-look <row>`; ADR 0003), or the lists of an earlier lock (`revert <commit>`).
  Each row is cited once. `bootstrap` is allowed only when the base has no lock. A shipped-pin
  line is written after the merge, so it is never evidence.
- **The lock's inputs are closed.** `test/eval/ranking-lock.node.test.js` fails when a file in
  the runner's import closure is outside `LOCK_INPUTS`, or an import can't be resolved to a listed
  path.

## Consequences
- The lock guards against accidents, not false evidence: a lock change shows in every diff.
- It covers the open sets only; the custodian's holdout count at a ship stays.
- A ranker change in `src/`, `data/`, `migrations/` or the runner takes the slow path in CI.
