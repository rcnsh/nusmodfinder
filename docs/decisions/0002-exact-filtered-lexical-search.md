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

## In the code

**The query plans** (`src/lexical.js` `lexicalSearch`)
- The first plan takes the top `FTS_CAP` (2,000) hits by rank, `CROSS JOIN`ed to `modules` so the
  hits stay the outer loop and the `LIMIT` stops early; a plain `JOIN` lets SQLite drive from
  `modules` (7,455 rows read against 211). (rank, rowid) is the total order every plan shares.
- Only when fewer than `limit` survive and the match overflowed the cap does the filter-driven
  plan run. An empty result from it means the bounded answer was already complete. Its cap guard
  sits in a `CROSS JOIN`, because as a scalar subquery in `WHERE` it isn't hoisted (6,831 rows read
  for nothing).
- The filter-driven plan names its driving index itself (`chooseDriver`, from the facets row's
  counts, else `FIXED_DRIVER_ORDER`) and writes every other predicate as `+m.col`. D1 has no
  `sqlite_stat1`, so SQLite picks among equality indexes by creation order and would drive from
  `idx_modules_credits` (credits=4: about 5,000 rows) instead of, say, faculty=Computing (about
  300). With no stat1 the choice doesn't depend on the data, so `test/lexical-driver.test.js`
  shows the full corpus's plan on the fixture.
- Stale facet counts only cost a worse plan; neither a failed counts read nor a row without
  counts is cached. The no-counts order is exact but measured, not gated: no fixed order knows
  that level=5 (2,713 rows) drives worse than credits=5 (407) and better than credits=4 (5,081).
- The FTS triggers (`migrations/0006_fts_external.sql`) stay `AFTER UPDATE`: a `BEFORE UPDATE`
  trigger makes SQLite re-read each row, doubling rows read per update.

**The write estimates** (`scripts/ingest-core.mjs` `DEFAULTS`)
- Measured over the full corpus and rounded up: an insert about 7.1 rows (`writesPerInsert` 8), an
  update about 5.1 (5.5), FTS5 shadow writes 13.19 per inserted row (14) and 15.69 per changed
  title or description (16), none when code, title and description are unchanged, and a delete
  12. A `catalogue_only` row costs 2 (the row and its primary-key entry), with no FTS or index
  fan-out. Lowering them under-charges the budget for writes local D1 doesn't report.
- `catalogueBatchSize` (100) is `/admin/catalogue`'s own per-call limit (`CATALOGUE_LIMIT`,
  `src/ingest.js`); raising it alone makes every catalogue call fail.

**The tests that hold it**
- `test/full/lexical.test.js` gates filtered search at 8,000 D1 rows read per search (with facet
  counts) and compares it with a brute-force oracle that filters from the JSON semesters and plain
  columns, never the generated columns, so a wrong generated column can't agree with itself. Its
  neutrality check lets only exact-bm25 tie groups reorder, and the last rank may differ where the
  depth cut splits a tie group.
- `test/regressions/backend.test.js` plans each statement of each `modules_fts_*` trigger body on
  its own, with `old.x`/`new.x` replaced by bound values, because `EXPLAIN QUERY PLAN` doesn't
  descend into trigger programs: planning the firing `UPDATE` alone would pass even if a trigger
  scanned the whole FTS table.
- The D1 meters in `test/full/ingest.test.js` run `first()` as `all()`, because only `all()`,
  `run()` and `batch()` return D1 meta; metering `first()` directly drops its rows read.
