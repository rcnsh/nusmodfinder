# Count log

Append-only. One row per `npm run eval:count` call, which only the custodian runs. A count
prints one integer and no verdict, so it is not a look (ADR 0003, amendment 2026-11-06). The
holdout ledger never reads this file and refuses a row copied from it.

| date | set | kind | run | count |
|---|---|---|---|---|
