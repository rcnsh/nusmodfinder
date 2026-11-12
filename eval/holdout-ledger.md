# Holdout ledger

Append-only. One row per look at an encrypted set (`holdout` max 12, `test` max 1), written
by `npm run eval` and `npm run eval:report` on those sets. A look past the limit is refused.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-07 | holdout | 8acc204 | 3a2-v1 | shipped-8adb476 | pass | +0.038 [-0.007, 0.092] | +0.037 [-0.003, 0.085] | general | 8adb476 |
| 2026-11-07 | holdout | a3f9647 | 3b | shipped-42c25b1 | pass | +0.013 [0.003, 0.050] | +0.003 [0.000, 0.017] | targeted: code-space,code-partial,ge,abbreviation | 42c25b1 |
| 2026-11-07 | holdout | a9f634b | 3c2 | shipped-a1867ea | pass | +0.006 [-0.002, 0.019] | +0.020 [0.006, 0.045] | targeted: typo | a1867ea |
| 2026-11-07 | holdout | 55f41d2 | 3d | shipped-91f11b9 | fail | -0.005 [-0.020, 0.004] | -0.020 [-0.045, 0.003] | targeted: level | 91f11b9 |
| 2026-11-07 | holdout | 6cb0a12 | 3d-r2 | shipped-91f11b9 | fail | -0.004 [-0.019, 0.004] | -0.017 [-0.042, 0.003] | targeted: level | 91f11b9 |
| 2026-11-07 | holdout | 2476012 | 3h | shipped-1ad4086 | fail | -0.024 [-0.081, -0.005] | -0.014 [-0.084, 0.000] | general | 1ad4086 |
| 2026-11-07 | holdout | f9a4b6e | 3h-r | shipped-1ad4086 | fail | -0.024 [-0.081, -0.005] | -0.014 [-0.084, 0.000] | general | 1ad4086 |
| 2026-11-07 | test | 0878efb | final | v0 | pass | +0.120 [0.083, 0.161] | +0.059 [0.036, 0.090] | sc5 | 5c5cce4 |
| 2026-11-11 | holdout | ff54fdc | l8-ff54fdc | shipped-04a118a | pass | +0.012 [0.000, 0.061] | +0.009 [0.000, 0.043] | compliance | 04a118a |
