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

## In the code
- **Variant selectors are constants.** `EMBEDDING_TEXT_VARIANT` (`scripts/lib.mjs`),
  `STOPWORDS_VARIANT` (`src/fts-query.js`) and `TYPO_VARIANT` (`src/typo.js`) are each the only
  difference between their variants' refs, so the ranker tree hash and the lock's `inputsHash`
  name the variant the eval scored. Selecting a variant anywhere else, or by request parameter,
  changes the ranking without moving the hash. The query parser's code-join guard reads the same
  stopword list in force (`STOPWORDS_IN_FORCE`, through `src/intent-data.js`).
- **`eval/lib/ranking-lock.mjs` loads with Node and git only.** `acorn` is imported lazily by the
  closure check, so `eval:lock -- --check` takes its fast path before `npm ci`; a static import
  of an npm package there makes every CI eval-gate run install dependencies.
- **Files reached without a static import are named by hand** for the closure check:
  `eval/runner/vitest-child.mjs` (forked by path) and `eval/runner/retrieval.eval.js` (loaded by
  `vitest.eval.config.mjs`) in `ENTRIES`, each non-literal dynamic import and its targets in
  `DYNAMIC_IMPORTS`, and the bare names `vitest.eval.config.mjs` aliases in `ALIASES`. Dropping
  one hides a ranker dependency from `inputsHash`, so a change to it takes the fast path.
- **Each entry is the status in clear, then the sha256 of `[status, codes]`** (`queryHash`), so
  a 500 never hashes like an empty 200 and a status change shows in the lock's diff.
- **`eval/lib/lock-runner.mjs` `computeLists`** never runs inside the `oracle` Vitest projects,
  so none of their production aliases reach its lists. It deletes its run files; only the
  per-query hashes leave, plus a digest of each run's whole results, printed so a PR can quote it.
