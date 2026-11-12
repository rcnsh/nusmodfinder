# Count log

Append-only. One row per `npm run eval:count` call, which only the custodian runs, and per passing
`npm run eval:representatives -- --route` call. A count prints one integer and no verdict, so it is
not a look (ADR 0003, amendment 2026-11-06). The holdout ledger never reads this file and refuses a
row copied from it. `route` names the no-look route the row was taken for (ADR 0003, amendment
2026-11-12); a ranking-lock change can cite such a row once (`eval:lock -- --evidence no-look <row>`).

| date | set | kind | run | count | route |
|---|---|---|---|---|---|
| 2026-11-07 | holdout | count: emptied-untagged | 3g-max | 0 |
| 2026-11-07 | test | count: answerable | — | 195 |
| 2026-11-07 | holdout | count: lists differing (inline custodian script, not eval:count; logged after the fact) | 3h vs 3h-r | 1 |
| 2026-11-07 | holdout | count: lists differing (inline custodian script, not eval:count; logged after the fact) | 3h-p vs shipped-1ad4086 | 0 |
| 2026-11-10 | holdout | count: lists-differing | shipped-072b208 vs shipped-610e734 | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-f64ccec vs shipped-072b208 | 0 |
| 2026-11-11 | holdout | count: lists-differing-by-group | cand-3f96d79 vs shipped-f64ccec | 0 |
| 2026-11-11 | holdout | count: lists-differing | cand-3f96d79 vs shipped-f64ccec | 3 |
| 2026-11-11 | holdout | count: lists-differing-by-group | shipped-04a118a vs shipped-f64ccec | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-04a118a vs cand-3f96d79 | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-6c1ed1c vs l8-ff54fdc | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-669fe7f vs shipped-6c1ed1c | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-8e24b21 vs shipped-669fe7f | 0 |
| 2026-11-12 | holdout | count: lists-differing | shipped-b75ac19 vs shipped-8e24b21 | 0 |
