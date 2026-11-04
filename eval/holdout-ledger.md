# Holdout ledger

Append-only. One row per look at an encrypted set (`holdout` max 12, `test` max 1), written
by `npm run eval -- --holdout`. Phase 3 tuning stops at 12 holdout looks.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |
|---|---|---|---|---|---|---|---|---|---|
