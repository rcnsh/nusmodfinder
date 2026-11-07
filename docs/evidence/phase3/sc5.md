# SC5: the sealed test set, one look (2026-11-08)

**SC5 passes.** On the sealed test set, the frozen ranker `phase3-final` (`c787dea`) beats
`eval-v0` (`7ac9841`, the Phase 2 production ranker) on the pinned corpus:

| | n (primary answerable) | ΔnDCG@10 | ΔP@5 | rule |
|---|---|---|---|---|
| **filtered (the SC5 set)** | 195 | **+0.120 [0.083, 0.161]** | **+0.059 [0.036, 0.090]** | both BCa 95% lower bounds > 0: **pass** |
| unfiltered (secondary) | 280 | +0.100 [0.072, 0.134] | +0.051 [0.031, 0.076] | reported |
| leak-filter drops alone | 85 | +0.056 [0.021, 0.114] | +0.033 [−0.000, 0.089] | reported |

- **Labels:** these are offline-replica results, with exact dense search over the pinned
  2026-09-04 catalogue (ADR 0003). Since 3-0, production's dense search is exact too, so the
  replica differs from production only in the corpus pin.
- **Verdict:** `npm run eval:report -- --set test --run final --baseline v0`. The ledger holds one
  `test` row with rule `sc5`, and the test set allows no further look.
- **Secondary:** `node eval/test-build/sc5-secondary.mjs eval/sealed-unfiltered`
  (`sc5-secondary.txt`). It is computed from the same stored runs and writes no ledger row. Its
  filtered line reproduces the verdict exactly.

## How the set was written (ADR 0003 "Test set, pre-registered now"; plan §5)
1. **Freeze:** `phase3-final` = `c787dea`, the last accepted change (the 3H pin, #61). CI was
   green there.
2. **Persona queries.** Six fresh writer subagents (`claude-opus-5-5`) used the pre-registered
   writer prompt and persona cards (`eval/v2/writer-prompt.md`, `PERSONAS.md`), unchanged.
   - Round 1 used shape seed `vnm-test-2026-11-08` (`eval/test-build/shape-assignment.json`) and
     gave 147 queries.
   - Round 2, an extra persona round, used `vnm-test-2026-11-08-r2` and gave 147 more.
   - Each writer read only its prompt file and saved its JSON with one Write call. That save is
     the only tool use beyond the protocol's "no tools". Writers saw no corpus, no NUSMods data
     and no results.
3. **Code queries:** 18, the v2 forms: 6 exact, 5 space, 4 partial (code families, never a GE
   pillar) and 3 non-existent, the last with `noAnswerByRule`.
   - They were drawn from a secret custody seed, sha256
     `08e926ae6b4b42ed010b7391a07c9971ab15abeaa7556dd341834aa0bf8d8fa0`.
   - The v2.1 overlap rule bars any dev or holdout code target, any SC4 suite code or prefix, a
     writer example, and any earlier draw.
4. **Typo queries:** 15, eval/v2's noise model applied to seeded round-1 sources that have a word
   of 4+ letters.
5. **Leak filter** (`eval/test-build/leak-filter.mjs`): 327 queries in, **227 kept** and 100
   dropped:
   - 37 near-duplicates of dev queries and 23 of holdout queries (cosine ≥ 0.9). Many are
     identical: the writers reproduce the persona cards' named home courses;
   - 1 near-duplicate of an SC4 suite query;
   - 5 typo variants whose source was dropped;
   - **34 near-duplicates inside the test set**, a later query too close to an earlier kept one.
     This within-test step is the lead's addition, not in ADR 0003. Every round uses the same
     cards, so duplicates would otherwise enter the paired comparison twice. It can only shrink
     n.
6. **Size.** Round 1 could not reach 160 primary answerable queries: 140 survived the filter, and
   the constraint block and no-answer queries are outside the primary. So round 2 was written
   before judging, and the whole set was judged once. `eval:count --set test --answerable`
   (custodian, logged in `eval/count-log.md`) printed **195**, at least 160, so writing stopped
   after one extra round of the two allowed.
7. **Runs and judging.**
   - Runs: `v0` (`eval-v0` with its own corpus embedding, `emb-bge-small-v0`) and `final`
     (`phase3-final`), both store-only.
   - Pool: their top 10s, 2,744 pairs over 227 queries.
   - Judge A (`claude-opus-5-5`, single-judge, ADR 0004) graded them in 19 packets. The 134
     planted repeats agree exactly. The 52 hard-constraint pairs were graded by rule.
   - Rule 4's code grades added 42 pairs, giving `qrels-test-v1`. judged@10 is 100%.
   - The dropped 100 were run and judged the same way (1,156 pairs, 8 packets, 57 repeats exact)
     in `eval/sealed-unfiltered/`, for the secondary only.
8. **Embeddings (remote, Workers AI):**
   - 242 + 171 query texts, plus 12 + 5 corrected forms;
   - about 16.7 neurons in all;
   - `requests.tsv` rows 100–102 and 104.

## Cross-family check: not run (deviation, Jacob's sign-off)
ADR 0004's amendment requires the check on the SC5 test pool. It covers the 1,154 non-rule pairs
in the symmetric difference of `final`'s and `v0`'s top 10s (`eval/test-build/xfam-export.mjs`).
`gemini-3.8-flash-high` hit its rate limit on all three attempts (18:48–19:00 UTC), before
grading any pair, which is the same failure as 3D. Jacob chose to skip the check, as for 3D. SC5
rests on judge A's grades alone. The deviation is recorded in ADR 0004.

## Custody
- **Committed as AES-256-GCM ciphertexts only:**
  - queries, embeddings, qrels and both runs, in `eval/sealed/` (and `eval/sealed-unfiltered/`
    for the drops);
  - `npm run eval:verify` checks all three encrypted directories.
- **In custody** (`~/.config/vnm/custody/test/`, mode 700): the writer outputs, the code seed
  and the plaintext sets.
- **Cross-family sheet:** it stays in `.eval-work`.
