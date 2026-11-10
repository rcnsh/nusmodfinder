# Phase 4 gates (4A, 4C, 4D, 4E): exchange mode, no holdout look

`docs/plans/phase4.md` §4 and ADR 0003's amendment "Phase 4 is gated without a look". Every run
here is local: workerd with fakes, the pinned corpus (6,771 modules) and bundle, committed
embeddings. Nothing reads the holdout or the test set, and nothing calls Cloudflare.

## 1. SC1: oracle and path tests
- **Oracle** (`test/full/sc1-oracle.node.test.js`, from 4B): `eligibility()` agrees with the
  independent oracle on 101,565 pinned cases.
- **Production catalogue** (`ship-oracle.mjs`, ship step 5, run ahead of the ship too): the
  6,778 production-normalised modules × 15 combinations, the `ng_allow` ingest computes against
  the oracle. 101,670 cases, 12,549 shown, **0 differences**.
- **Path tests** (`test/sc1/paths.test.js`, CI job `sc1`): 5 of 5 pass.
  - Set equality for all 15 (sem, study): the lexical filter SQL over every D1 row, `compileMask`
    over every bundle row and the D1 recheck over every row each equal the oracle's open ∪ note set.
  - Pins: a code search for every NG code in the corpus × 15 combinations shows the code exactly
    when the oracle does.
  - Variants: no duplicate group with an NG member shows a closed member.
  - `related`: a not-offered code's neighbours are never closed, on the bundle or the standby.
  - The standby (the fake Vectorize holding the bundle's vectors, topK 100, then the D1 recheck)
    leaks nothing. Its recall@50 against the bundle, mean over 20 queries per combination, is
    0.994–1.000, against a floor of 0.85.
- **Fixture** (`test/exchange.test.js`, 14 tests), in every mode and on the standby:
  - results, variants, pins, a mask route and `related` against the oracle;
  - a zero `ng_allow` in D1 hides the module on every path, the bundle's dense rows included;
  - `study-required`, `ng-special-term`, the cache key and the echo;
  - the cards' and `/module/:code`'s reasons.

## 2. Per-list identity on dev (`test/sc1/identity.test.js`)
The 98 dev queries were run with `study` from `eval/study-map.json`:
- **93 compared.** Every list (pins, dense, lexical, code, mask) equals its ignore-mode list,
  with the bit ignored at full depth, projected by the oracle and cut at the pipeline's depth.
  Every page equals the fusion of the filtered lists, built to the page size. **0 problems.**
- **4 refused** with a 400 all three ways: queries over 200 characters, as before Phase 4.
- **The ignore mode is not vacuous:** 148 ignore-mode lists held a closed module within their
  depth.
- **3G:** one dev query answers no-signal, d-025, which is tagged `noanswer` (topCosine 0.541).
  No other query crosses τ, so no ruling is needed.
- The trace is honoured only with `TEST_MIGRATIONS` bound, skips the cache both ways and is sent
  `no-store`. `npm run deploy` refuses any wrangler var but `DENSE_BACKEND` (test in
  `test/deploy.node.test.js`).

## 3. Unfiltered guard
Baseline ranker `238e721` (the shipped pin) against candidate `9146cb8`, local eval runs:

| run | queries | results sha256 (first 16) | identical |
|---|---|---|---|
| dev, `--strip ng` (sem kept) | 98 | `ae4f077e0ad06ef2` both | yes |
| dev, `--unfiltered` | 98 | `8fde32e1783d6d6b` both | yes |
| fixture, `--strip ng` | 11 | `ce4f61e83ce5a52f` both | yes |

The SC4 suite (`test/full/sc4.test.js`) and the rest of `test/full` pass.

## 4. `eval:report` on dev (reported, not a gate)
`eval/runs/phase4.json` against `shipped-f004351` (ranking-identical to the shipped `238e721` on
dev, ADR 0003 pin line), `qrels-dev-v10`, 85 answerable:

| metric | shipped | phase4 | Δ (BCa 95% CI) |
|---|---|---|---|
| nDCG@10 | 0.775 | 0.768 | −0.007 [−0.014, −0.001] |
| P@5 | 0.661 | 0.661 | −0.000 [−0.009, 0.009] |
| MRR@10 | 0.941 | 0.923 | −0.019 [−0.049, −0.006] |
| judged@10 | 100.0% | 98.9% | |

The judges graded relevance and never saw NG semesters or restrictions. Gate 2 shows every list
is the unfiltered list minus closed modules, so the small loss is removed courses the judges
rated relevant, and unjudged courses moving up into their places.

## 5. Live (after the ship, `remote-ops.md`)
- **Smoke:** `/health` reports data version `62e5a0011231` and tag `9d91605`; `ng=1` without
  `study` answers 400 `study-required`; `ng=1&sem=1&study=ug3` answers 20 results.
- **SC1 live** (`sc1-live.mjs`, `sc1-live.jsonl`): 30 fresh queries, two per (semester, year of
  study), on version `efd3dc25`. Every course shown, variants included, is open or noted for
  that combination by the oracle over the production-normalised modules. 30 of 30, 0 leaks.
- **Standby:** 6,778 vectors, 0 missing or extra, 0 metadata or value drift on a 100 sample.

## 6. Pin move (PR #67)
`SHIPPED_BASELINE` moves to `9d91605` with its ADR 0003 pin line. The custodian stored its holdout
run with `npm run eval -- --holdout --variant shipped-9d91605 --ref 9d91605… --store-only`
(`eval/holdout/run-shipped-9d91605.json.enc`, 81 queries): no look, no ledger row. Holdout looks
stay at 7 of 12.

## Fresh-context review
A subagent given only the diff and the goal reported three findings, each with a failing input:
- two page tests (`F8`, `P3`) still asserted the old page;
- `npm run typecheck` failed because a Node test imported Worker code;
- the gate-2 page check passed for a page cut short.

All three are fixed: the tests and `FINDINGS.md` match the page, `UPSERT_SET` lives in
`src/rowhash.js`, and the expected page is built to the page size. It found no closed course
shown or open course hidden on any path, and no cache-key, echo or ingest problem.
