# 3F gate: identity and dev no-loss pass; no look (2026-11-07)

3F collapses near-duplicates in `/search`. After the filters and fusion, each groups-v1 group
keeps only its first-ranked member. The other members that pass the filters ride along on it as
`variants: [{ code, credits }]`, and the page fills with the next distinct results (plan §2 3F).
The gate needs no holdout look (ADR 0003, A2-4). It is identity with the group-first projection on
the fixture and on dev, plus dev ΔnDCG@10 ≥ 0 (change kind `no-loss`), plus the S8 test green. All
three pass.

## Result (qrels-dev-v9, 85 primary answerable queries, judged@10 100% for both runs)
| run | nDCG@10 | Δ | BCa 95% CI | gate |
|---|---|---|---|---|
| shipped `89cb10e` | 0.766 | | | |
| 3F | 0.775 | +0.009 | [0.005, 0.016] | **pass** (`no-loss`; sign-flip p 0.0001) |

The eval already scores only the first member of each group, so the gain comes from the
collapse letting new distinct modules into the top 10. The biggest per-shape gains are
equivalence (+0.035), sea (+0.033) and level (+0.023). No shape loses, and no exact-code query
loses its rank-1 hit.

## Identity
- **Dev:** `node docs/evidence/phase3/3f-identity.mjs eval/runs/shipped-89cb10e.json eval/runs/3f.json .eval-work/ws-dev-3f/data/groups.json`
  covers 94 answered queries. 46 lists are unchanged and 48 collapse. In all 94, the 3F list
  starts with the group-first projection of shipped's list. There are no failures, and no list
  is shorter than shipped's.
- **Fixture:** `test/search-groups.test.js` compares each page with the projection of the
  uncollapsed list (`COLLAPSE_GROUPS=off`, topK 50). This holds in every mode, under the
  Vectorize standby, for one or two pins from one group, and for whole-query masks.
- **Full corpus:** `test/full/sc4.test.js` is green (87/87), with 3F among the merged changes.
  3B's bare-prefix check is now group-aware: `ges` covers the GES groups, and lexical `cs` is
  the projection of the CS members.

## Lead decisions (the plan doesn't name these)
- **Retrieval depth.** The reference list is "the uncollapsed list, fetched deep enough to fill
  the page" (§11, decisions beyond a critic's text), and the deepest uncollapsed ranking is topK 50, which reads 50 per list. So,
  with the collapse on:
  - a fused search (hybrid, or any mode with a code list) reads 50 per list at every topK;
  - a single list (lexical, or vector on the bundle) reads 100, since a deeper list only
    continues the same order and the projection is unchanged;
  - fused lists can't go deeper, because that changes RRF's sums.

  Two consequences:
  - a hybrid page near topK 50 can come back short (fixture: `law`, 43 of 50);
  - a hybrid page at topK < 17 now ranks from 50-deep lists rather than topK×3.

  The app asks for 20, which already reads 50 per list.
- **Variants keep the query's level window** (`XX N000`, `level 4`), as results do, but not its
  code ranges. A GES result may list its GESS cross-listing under `ges`.
- **Pins collapse too.** With two pinned codes from one group, the first stands and the second is
  its variant. This matches the uncollapsed list's projection.
- **D1 cost.**
  - A page with grouped results makes one more read, of only the columns a variant needs.
  - A single-list lexical search reads up to 100 FTS rows rather than 50.
  - Mask hydration and the variants read are chunked to D1's 100 bound parameters.

## How it was measured
- **Code:** groups-v1 moved to `src/groups.js` (the eval re-exports it). `data/groups.json` is
  built with the production vectors (dv `32b590de51aa`, 502 groups, 1549 members), and
  `test/fixtures/groups.json` from the fixture. `COLLAPSE_GROUPS=off` gives the uncollapsed
  ranking.
- **Review:** the fresh-context review found three defects, each with a failing input, and all
  three are fixed with tests:
  - two pins from one group both stood (`cs2030 or cs2030s`);
  - single-list pages came back short (`programming`, vector topK 50 gave 39);
  - variants ignored the level window (`llj 5000` listed LL4295).

  A fourth problem was found earlier, before the review: a full-corpus mask page at topK 50 hydrated
  150 codes in one statement and got a 502. That is now chunked.
- **Runs:** `npm run eval -- --variant 3f --ref 3f --baseline shipped-89cb10e`, then
  `npm run eval:report -- --run 3f --baseline shipped-89cb10e --change-kind no-loss`.
- **Pool:** one round over shipped and 3F found 6 unjudged documents.
- **Judging:**
  - Round `p3f` used judge A, one fresh subagent per packet (6), and graded 124 of 124 items.
  - Planted repeats agreed exactly (2).
  - On the 116-pair drift sample, A agreed with the stored grade 0.931 of the time (mean Δ
    +0.026).
  - The round merged as `qrels-dev-v9`, and the typo diagnostic set was rebuilt from it.
- **No remote call** before the deploy.
