# Holdout ledger

Append-only. One row per look at an encrypted set (`holdout` max 12, `test` max 1), written
by `npm run eval -- --holdout`. Phase 3 tuning stops at 12 holdout looks.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-07 | holdout | 8acc204 | 3a2-v1 | shipped-e8a7124 | pass | +0.038 [-0.007, 0.092] | +0.037 [-0.003, 0.085] | general | e8a7124 |
| 2026-11-07 | holdout | a3f9647 | 3b | shipped-45bd716 | pass | +0.013 [0.003, 0.050] | +0.003 [0.000, 0.017] | targeted: code-space,code-partial,ge,abbreviation | 45bd716 |
| 2026-11-07 | holdout | a9f634b | 3c2 | shipped-ad8e10c | pass | +0.006 [-0.002, 0.019] | +0.020 [0.006, 0.045] | targeted: typo | ad8e10c |
| 2026-11-07 | holdout | 55f41d2 | 3d | shipped-89cb10e | fail | -0.005 [-0.020, 0.004] | -0.020 [-0.045, 0.003] | targeted: level | 89cb10e |
