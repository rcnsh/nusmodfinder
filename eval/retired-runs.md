# Retired runs

Append-only. One row per stored encrypted run retired with `node eval/cli.mjs retire-run` so that
`--store-only` may write its replacement. Retiring is not a look.

| date | set | file | sha256 | reason |
|---|---|---|---|---|
| 2026-11-07 | holdout | run-shipped-f004351.json.enc | 8699683ba4d873d8b2256f7a26ff87601d9ed2d32aa1b323db8d5a57eab7c5df | stored under short ref f004351; the baseline pin needs the full sha (same commit, same lists); re-stored before any verdict |
