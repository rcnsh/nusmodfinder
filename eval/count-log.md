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
| 2026-11-07 | holdout | count: lists differing (inline custodian script, not eval:count; logged after the fact) | 3h-p vs shipped-f004351 | 0 |
| 2026-11-10 | holdout | count: lists-differing | shipped-f798542 vs shipped-9d91605 | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-fdec96f vs shipped-f798542 | 0 |
| 2026-11-11 | holdout | count: lists-differing-by-group | cand-3f96d79 vs shipped-fdec96f | 0 |
| 2026-11-11 | holdout | count: lists-differing | cand-3f96d79 vs shipped-fdec96f | 3 |
| 2026-11-11 | holdout | count: lists-differing-by-group | shipped-c645e85 vs shipped-fdec96f | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-c645e85 vs cand-3f96d79 | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-75ca23c vs l8-ff54fdc | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-8a86bf6 vs shipped-75ca23c | 0 |
| 2026-11-11 | holdout | count: lists-differing | shipped-0b5f360 vs shipped-8a86bf6 | 0 |
| 2026-11-12 | holdout | count: lists-differing | shipped-a23601d vs shipped-0b5f360 | 0 |
