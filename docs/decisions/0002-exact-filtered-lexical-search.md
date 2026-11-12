# 0002: Filtered keyword search stays exact, paid for with filter indexes

Status: accepted.

## Context
The keyword half of a search is a D1 FTS5 query with the request's filters in SQL. Without
indexes on the filter columns, the exact filtered fallback scans `modules`: up to 13,278 rows
read for one search. Bounding the scan instead (stop after N rows) would make deep matches
disappear under a filter, which is a recall bug.

## Decision
- **Keep the filtered search exact**, and add indexes on the filter columns: `level`,
  `credits`, and partial indexes on `sem3` and `sem4` (`migrations/0006_fts_external.sql`).
  Measured over 440 queries × 13 filters with 0 mismatches against brute force: worst case
  6,989 rows read (`"how to"` + `credits=8`), p99 6,018, mean 1,071.
- **Pay the write cost.** The indexes add about 14k rows written to a forced full re-ingest
  (about 34k in all against about 20k without them) and about 14k once to build them.
- **Ingest's `--write-budget` defaults to 40,000 rows**, so a forced full re-ingest finishes in
  one run. It is a runaway guard, not a cost limit: ADR 0004 sets the cost rule.

## Consequences
- Every remote D1 write is estimated first and logged (ADR 0004's headroom rule).
- A cold load writes far more than the default budget (about 137k rows with the FTS5 shadow
  tables) and passes `--write-budget` explicitly (docs/data.md, "Write budget").
