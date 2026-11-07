# 3G gate: τ = `max` (0.6013) passes; no look (2026-11-07)

3G gives `/search` a "no matches" answer. It answers `count: 0` with
`noMatch: { reason: "no-signal" }` when all three of these hold (plan §2 3G, C-3, C2-10):
1. no code, prefix or GE route fired;
2. no pre-correction token has df > 0, and no pre-correction token of 4+ letters has an FTS prefix
   match (3C's correction runs after this test);
3. the top exact cosine of the query as typed, under the request's filters, is below τ.

The gate needs no holdout look (ADR 0003, A2-9, A3-1, A3-2). The selected τ is the largest
candidate that passes every dev condition: `max`, 0.6012585039510654. It passes all five gate
conditions.

## τ candidates (3G-1)
`node scripts/no-signal-cosines.mjs --write` makes `3g-1-cosines.json`. It runs the product's own
parse and exact search over the pinned (eval) corpus, with the committed embeddings, and makes no
remote call.
- **Inputs:** the gibberish set `gibberish-v1`, split by seed 20261106 into a derivation half and
  a gate half of 20 each, plus the 93 dev queries not tagged no-answer. It reads tags, never
  relevance labels.
- **Top-1 cosine ranges:** the derivation half runs from 0.489 to 0.601, the gate half from 0.473
  to 0.609. All 40 gibberish strings pass the vocabulary test.
- **Dev:** one untagged dev query passes the vocabulary test. It is d-095,
  `microbbiology bacteia`, with a top cosine of 0.6157.

| variant | τ (derivation half) | gate half predicted | derivation half | untagged dev emptied |
|---|---|---|---|---|
| `p90` | 0.5693180883526313 (18th of 20) | 15/20 | 18/20 | none |
| `p95` | 0.5814376699800824 (19th) | 16/20 | 19/20 | none |
| **`max`** | **0.6012585039510654** | **18/20** | 20/20 | none |

Only `max` can meet the gate half's 90%. So `max` is selected, and no fallback is eligible.

## Gate (τ = `max`)
| condition | result |
|---|---|
| **SC4 suite green**, typo, gibberish, non-existent-code and guard items included | `npm run test:full`: 92/92, with 3G in `MERGED` |
| **≥ 90% of the gate half returns count 0** | 18/20 through the Worker over the pinned corpus (`[3G]` test in `test/full/sc4.test.js`). The two that still return results are g-03 `jkl jkl jkl` (0.6015) and g-36 `qw3rty` (0.6091) |
| **No untagged dev query returns `no-signal`** | none. The only dev list that changes is d-025, which is tagged no-answer |
| **Dev answerable ΔnDCG@10 ≥ −0.01** (`answerable-floor`) | +0.000 [0.000, 0.000] over 85 primary answerable queries, judged@10 100% (qrels-dev-v9), vs shipped `2ce17c6` |
| **The custodian's count of emptied untagged holdout queries is 0** | 0 (`eval/count-log.md`, run `3g-max` stored with `--holdout --store-only`; not a look) |

## Lead decisions (the plan doesn't name these)
- **The cosine is the query as typed.** Under 3C-2, `/search` also embeds the corrected text, but
  only the first dense text's top cosine counts. "From 3-0" names the raw query, and a correction
  must not rescue gibberish.
- **The cosine is taken under the request's filters**, since that is the list the dense half
  returns. If the filters admit no module, there is no cosine and 3G does not fire. The review
  found this case.
- **Needs the dense half.** Lexical mode, a degraded search and an open circuit never fire.
- **A query with no tokens** (only punctuation, or non-Latin script) passes the vocabulary test
  vacuously. The cosine then decides, as the rule says.
- **τ is derived on the eval corpus** (the pinned 2026-09-04 catalogue) and applies to
  production's. The eval corpus has 6,771 modules and production's 6,778.
- **The operator switch.** `NO_SIGNAL_TAU=off`, or a number, overrides τ. It exists for tests,
  and production sets none.

## How it was measured
- **Code:**
  - `src/no-signal.js` holds the candidate table and the variant in force;
  - `parsed.noSignal` is in `src/query-intent.js`;
  - the dense half and the early answer are in `src/search.js`.

  The table is tied to the measurement by test.
- **Review:** the fresh-context review found two defects, each with a failing input. Both are
  fixed with tests:
  - an empty dense list (filters admitting no module) fired at any τ;
  - a numeric `NO_SIGNAL_TAU` was ignored.

  The fixed commit `3g` returns lists identical to `3g-max` on all 98 dev queries. The fix
  changes only queries whose filters admit no module, which return count 0 either way.
- **Runs:** `npm run eval -- --variant shipped-2ce17c6 --ref 2ce17c6`, then
  `--variant 3g-max --ref 3g-max --baseline shipped-2ce17c6`, then
  `eval:report --change-kind answerable-floor`.
- **No pool or judging round:** no new document entered a top 10.
- **No remote call.**
