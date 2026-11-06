# 3A-1 dev screen: fail, dropped, no look (2026-11-06)

3A-1 prepends bge's retrieval instruction ("Represent this sentence for searching relevant
passages: ") to the query text before it is embedded (draft PR #39, head `ee5b3c8`). It fails the
dev screen. Under plan §3 a candidate goes to its holdout look only after passing dev, so **no
look is spent** and the holdout ledger stays at 0 of 12. 3A-1 has no named retry (§3, "3A-1 has
none") and SC4 does not require it, so it is dropped without going to Jacob (Q4 covers
SC4-required changes only).

## Result (qrels-dev-v3, every compared pair judged)
| | shipped `e8a7124` | 3A-1 | Δ | BCa 95% CI |
|---|---|---|---|---|
| nDCG@10 | 0.688 | 0.694 | +0.005 | [−0.016, 0.029] |
| P@5 | 0.558 | 0.541 | −0.016 | [−0.038, 0.005] |
| MRR@10 | 0.801 | 0.818 | +0.017 | [−0.004, 0.042] |

The general rule needs the lower bound of the ΔnDCG@10 BCa 95% CI above 0. It is −0.016.

## How it was measured
- **Embedding:** 98 prefixed dev query texts (5.5 neurons) and 10 prefixed fixture texts
  (0.5 neurons) were embedded with Workers AI (`requests.tsv` rows 79–80).
- **Runs:** `npm run eval -- --variant shipped --ref e8a7124…`, then
  `npm run eval -- --variant 3a1 --baseline shipped` at the PR head.
- **Before judging:** the candidate's judged@10 was 88.5%. One pooling round
  (`eval:pool --runs shipped,3a1 --unjudged`) found 108 unjudged documents.
- **Judging:** round `p3a1` used judge A (`claude-opus-5-5`, 7 packets, one fresh run each),
  with a 5% drift sample.
  - 193 of 193 items graded.
  - Planted repeats: exact agreement 1.000 (7).
  - Drift: agreement with the stored grade 0.911 over 79 pairs, mean Δ +0.038.
- **Merged** as `qrels-dev-v3` (107 A grades, 1 rule grade). Two more queries are answerable
  under v3, so the shipped ranker reads nDCG@10 0.688 over 85 queries, against 0.712 over 83
  under v2.

## What stays
- **`qrels-dev-v3`:** later rounds and comparisons use it, because every comparison scores under
  the latest qrels.
- **The stored holdout run of the shipped ranker** (`run-shipped-e8a7124`, no look): it is L2's
  baseline.
- **PR #39 is closed unmerged.** Its prefixed embeddings and code stay on its branch as the
  record.

## Full report
```

set dev · queries v2.1 (98) · qrels qrels-dev-v3 · duplicate groups groups-v1 · metrics on top 10
metric                      shipped     3a1
--------------------------  -------  ------
answerable (primary) n           85      85
nDCG@10                       0.688   0.694
P@5                           0.558   0.541
MRR@10                        0.801   0.818
feature-gap n                     5       5
feature-gap nDCG@10           0.592   0.584
no-answer n                       2       2
no-answer correct-empty        0.0%    0.0%
no-answer false positives         2       2
no-answer errors (non-200)        0       0
unscored n                        6       6
violations@10 (total)            12      13
judged@10                    100.0%  100.0%
non-200 responses                 4       4

unscored (untagged, no grade-≥1 document; in neither set): 6: d-005, d-009, d-017, d-020, d-032, d-042

paired over 85 primary answerable queries · qrels qrels-dev-v3
Δ (cand − base)  shipped    3a1       Δ       BCa 95% CI  sign-flip p  persona-cluster 95% CI
---------------  -------  -----  ------  ---------------  -----------  ----------------------
nDCG@10            0.688  0.694  +0.005  [-0.016, 0.029]       0.6579     [-0.032, 0.038] (7)
P@5                0.558  0.541  -0.016  [-0.038, 0.005]       0.1889    [-0.033, -0.000] (7)
MRR@10             0.801  0.818  +0.017  [-0.004, 0.042]       0.1515     [-0.019, 0.057] (7)
correct-empty       0.0%   0.0%  +0.000                                                   n 2

gate (dev): FAIL · rule general
  [pass] no new errors — non-200 responses: baseline 4, candidate 4
  [pass] sufficient queries (>= 10 answerable) — 85 primary answerable queries
  [pass] judged@10 = 100% — baseline 100.0%, candidate 100.0%
  [pass] no exact-code regression — 0 exact-code queries lost their rank-1 hit
  [FAIL] ΔnDCG@10 BCa 95% lower bound > 0 — ΔnDCG@10 0.0055 [-0.0164, 0.0294]

per shape (dev only)
shape          n  nDCG base  nDCG cand       Δ  one-sided 95% upper  P@5 cand       no-answer  unscored  violations@10
------------  --  ---------  ---------  ------  -------------------  --------  --------------  --------  -------------
abbreviation   5      0.694      0.742  +0.049                0.267     0.560               0         1              1
alternatives   5      0.723      0.737  +0.014                0.045     0.880               0         0              1
code          11      0.512      0.520  +0.008                0.031     0.127               0         0              5
code-exact     5      1.000      1.000  +0.000                0.000     0.200               0         0              5
code-partial   3      0.000      0.028  +0.028                0.085     0.067               0         0              0
code-space     3      0.210      0.210  +0.000                0.000     0.067               0         0              0
constraint     5      0.592      0.584  -0.008                0.020     0.400               0         0              2
equivalence    4      0.498      0.447  -0.050                0.043     0.250               0         1              0
ge             6      0.398      0.451  +0.053                0.108     0.433               0         0              0
language       2      0.909      0.924  +0.015                0.067     0.400               0         0              0
level          7      0.649      0.678  +0.028                0.056     0.657               0         0              0
mapping        8      0.886      0.878  -0.008                0.031     0.650               0         4              0
noanswer       3      0.694      0.631  -0.063               -0.011     0.267  2 (0.0% empty)         0              0
sea            4      0.741      0.802  +0.062                0.155     0.850               0         0              0
topical       25      0.815      0.789  -0.026               -0.005     0.688               0         0              2
typo           6      0.427      0.505  +0.077                0.229     0.333               0         0              2
```
