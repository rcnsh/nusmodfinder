# Calibration of judge A by model cross-check (dev)

Jacob chose a model cross-check over grading the 150 calibration pairs by hand
(2026-11-04, ADR 0004 amendment).

- **Sample:** `npm run eval:judge -- calibrate export --n 150 --seed 20261106` over
  `qrels-dev-v1`, stratified by shape and grade (`sample.meta.json`). The pairs themselves
  are in `.eval-work/calibration-dev.csv`, which is not committed and is rebuilt by the
  same command.
- **Cross-grader:** `gemini-3.8-flash-high`, a different model family from judge A, run as
  5 T3 delegates of 30 pairs. It saw only `rules.md` (the judge packet's rules and worked
  examples) and its pairs, never A's grades. Output: `gemini-grades.csv`.
- **Verifier:** 5 fresh Claude Sonnet subagents checked every Gemini grade against the rules
  and fields. They saw Gemini's grade and note, never A's. They overturned 4 of 150 (c019,
  c110, c111 and c122; `verifier-verdicts.csv`), giving `verified-grades.csv`. A verifier that
  sees the grade first may anchor on it, so 4 is a floor on Gemini's errors.

## Agreement with judge A (`calibrate import --csv <file> --baseline v0-lexical --run v0`)

| grades vs A | n | raw | Krippendorff α (ordinal) | κ binary (≥ 1) | κ quadratic |
|---|---|---|---|---|---|
| Gemini | 150 | 0.867 | 0.892 | 0.802 | 0.893 |
| verified | 150 | 0.880 | 0.915 | 0.842 | 0.915 |

Judge A (rows) against the verified grades (columns):

| A \ verified | 0 | 1 | 2 |
|---|---|---|---|
| 0 | 49 | 1 | 0 |
| 1 | 10 | 35 | 5 |
| 2 | 0 | 2 | 48 |

- **Direction:** A is higher on 12 pairs and lower on 6. Most of the gap is A giving 1 where the
  verified grade is 0, so A is slightly lenient on partial matches. There are no 0 against 2
  disagreements.
- **Δ sign:** on the calibrated subset, Δ nDCG@10 (v0 − v0-lexical) is +0.052 under A, +0.059
  under Gemini and +0.054 under the verified grades. Same sign under every grader.

## Limits

This is a model cross-check, not human calibration. The verifier is a Claude model, as A is, and
saw Gemini's answer before deciding.
