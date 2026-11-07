# 3A-2 dev screen and cross-family check: v1 selected, goes to L2 (2026-11-07)

3A-2 changes the text each course is embedded from (plan §2, `phase3-prereg.md` "3A-2
variants"). Three variants were scored on dev against the shipped ranker `e8a7124`:
- **v1:** `CODE. Title. Level N (label). Description. Department. Faculty.`
- **v2:** v1 without department and faculty.
- **v3:** v1 without the code.

v1 ranks first and passes the dev screen. Judge A's sign holds under the ADR 0004 cross-family
check, run on 435 of its 519 pairs (an 84% deviation, below). v1 goes to its holdout look (L2). v2
ranks second and is the named retry.

## Dev screen (qrels-dev-v4, 85 primary answerable queries, judged@10 100% for every run)
| | nDCG@10 | Δ | BCa 95% CI | P@5 | MRR@10 | violations@10 | gate |
|---|---|---|---|---|---|---|---|
| shipped `e8a7124` | 0.640 | | | 0.558 | 0.801 | 12 | |
| **v1** | **0.697** | **+0.057** | **[0.027, 0.109]** | 0.598 | 0.857 | 8 | **pass** |
| v2 | 0.691 | +0.051 | [0.022, 0.103] | 0.605 | 0.850 | 5 | pass |
| v3 | 0.645 | +0.005 | [−0.014, 0.023] | 0.560 | 0.800 | 12 | fail |

Selection takes the highest dev nDCG@10 among passing variants: v1 (sign-flip p 0.0006,
persona-cluster CI [0.016, 0.121]). From `npm run eval:report -- --run 3a2-v<n> --baseline shipped`.

## Cross-family check (ADR 0004 amendment)
- **Pairs:** every non-rule pair in the symmetric difference of v1's and shipped's dev top-10s:
  519 pairs, shuffled with seed 20261107 (`3a2-xfam/export.mjs`). They were split into six
  chunks of about 87 pairs.
- **Grading:** `gemini-3.8-flash-high` graded each chunk blind to judge A, through T3
  `delegate_task`, from `3a2-xfam/rules.md` and its chunk only. A fresh Claude Sonnet agent then
  checked every Gemini grade, also blind to A. It upheld 426 and overturned 9
  (`3a2-xfam/verdicts.csv`).
- **Chunks 1–5 (435 pairs) are graded and verified.** Chunk 6 (84 pairs) is not. All five Gemini
  attempts on it, between 00:30 and 02:20 UTC, failed with "rate limit reached". The later
  attempts were split in halves (6a and 6b). Jacob chose to accept the check on 435 pairs (option b,
  2026-11-07).

### Result on the 435 verified pairs (`3a2-xfam/import-435.txt`)
| verified grades vs A | n | raw agreement | Krippendorff α | κ binary (≥ 1) | κ quadratic |
|---|---|---|---|---|---|
| | 435 | 0.936 | 0.860 | 0.843 | 0.892 |

Verified grade by A's grade: A 0 → 342 / 16 / 0; A 1 → 5 / 44 / 7; A 2 → 0 / 0 / 21 (verified
0 / 1 / 2). The 28 disagreements run both ways.

| grades | Δ nDCG@10 on the pairs (35 queries) | sign |
|---|---|---|
| A | +0.113 | + |
| verified | +0.111 | + |

The sign matches A's, so the ADR 0004 stop does not apply.

### What chunk 6 could do
Chunk 6 is a random sample of the 519 pairs, because the export was shuffled. Three checks
bound how much it could move the sign:
- **Worst case** (`build.mjs`, `import-worstcase.txt`): every chunk-6 pair is graded against
  v1, 0 if only v1 retrieves it and 2 if only shipped does. The verified Δ is **−0.153**, sign −.
  This needs the chunk-6 grades to disagree with A on all 53 pairs where A's grade is not
  already the worst case. On the 435 pairs, 6.4% disagree.
- **Break-even** (`breakeven.mjs`, `breakeven.txt`): with chunk 6 at A's grades, Δ is +0.104. The
  sign turns after **7** chunk-6 grades go against v1, chosen greedily as the most damaging. That
  is 8% of chunk 6. The subset scores only 35 queries, so one grade can move a query's whole
  nDCG. Seven disagreements, all against v1 and all on the pairs that matter most, would be
  needed.
- **Resampling** (`simulate.mjs`, `simulate.txt`): each chunk-6 grade is drawn from the observed
  distribution of verified grade given A's grade, in 4,000 draws with seed 20261107. **P(Δ ≤ 0) =
  0.0000.** The median is +0.101, the 2.5% quantile +0.068 and the minimum +0.031.

Only a targeted set of disagreements flips the sign, and the observed disagreements do not run
that way. The check stands on 435 pairs.

## Deviation from the ADR 0004 amendment
The amendment says every pair in the symmetric difference. This check covers 435 of 519 (84%),
because the Gemini route was rate-limited for chunk 6. Jacob accepted that, with the bounds above
recorded. The final grade of every pair is still the rule's, else A's. `qrels-dev-v4` is
unchanged.

## How it was measured
- **Corpus vectors:** `emb-bge-small-v1`, `-v2` and `-v3` (`eval/embeddings.json`, 6771, 6771 and
  6197 vectors; `requests.tsv` rows 81–83).
- **Judging:** round `p3a2` pooled the shipped run and the three variants. Judge A
  (`claude-opus-5-5`) graded it with a 5% drift sample, merged as `qrels-dev-v4`.
- **Runs:** `npm run eval -- --variant 3a2-v<n> --ref 3a2-v<n> --embedding emb-bge-small-v<n>
  --baseline shipped`.
- **Sheets:** `3a2-xfam/3a2-xfam-verified.csv` holds the 519 pairs, with the verified grade in
  `your_grade` and chunk 6 blank. `npm run eval:judge -- calibrate import --csv <it> --baseline
  shipped --run 3a2-v1` reproduces `import-435.txt`. The scripts ran from scratch and read the
  chunk files `pairs-6a.csv` and `pairs-6b.csv` beside them. Those are rows 436–519 of the sheet.

## L2 holdout look (custodian, 2026-11-07): pass, look 1 of 12
- **Store:** `npm run eval -- --holdout --variant 3a2-v1 --ref 3a2-v1 --embedding emb-bge-small-v1
  --store-only` stored v1's run on 81 queries, with no look.
- **Pool:** `eval:pool --holdout --custodian --unjudged --runs shipped-e8a7124,3a2-v1` found 149
  unjudged documents.
- **Judge:** round `h2` used judge A (`claude-opus-5-5`), one fresh subagent for each of the 5
  packets. 154 of 154 items were graded; the planted repeats agreed exactly (7). The round merged
  as `qrels-holdout-v3` (147 A grades and 2 rule grades), and its plaintext directory is
  deleted.
- **Verdict:** `eval:report --holdout --run 3a2-v1 --baseline shipped-e8a7124` gives **pass**, rule
  general (ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 as point estimates, every pair judged, no exact-code
  regression; `eval/lib/gate.mjs` `holdoutGate`).

| | Δ | BCa 95% CI |
|---|---|---|
| nDCG@10 | +0.038 | [−0.007, 0.092] |
| P@5 | +0.037 | [−0.003, 0.085] |

Both intervals include 0. The holdout rule is a point-estimate rule, so this passes as
preregistered. It is weaker evidence than the dev screen's CI. The look used no remote request.
