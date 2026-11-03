# Filtered lexical search: exactness and rows read (Phase 1A, B1)

Measured 2026-11-04, locally only: workerd + local D1 (vitest-pool-workers), full pinned corpus
(6,771 modules, release `data-2026-2027-20260904`) loaded through `/admin/ingest`, migrations
0001–0006. Source: `test/full/lexical.test.js`, test `filtered lexical equals brute force for
every query x filter, and costs <= 8,000 rows read`, which logs the `[1A] {"filteredCost": …}`
line quoted below (`FULL_CORPUS=1 npx vitest run test/full --silent=false`). An independent
Node harness over `getPlatformProxy` (same `src/lexical.js`, separate oracle) gave identical
numbers.

## Grid
- Queries: `test/fixtures/lexical-queries.json`, critic C's 440-query set (27 eval queries,
  400 synthetic title/description word queries, 13 natural-language and stopword queries);
  417 distinct, 82 of them match more than 2,000 modules.
- Filters (13): `sem` 1/2/3/4, `ng`, `ng+sem1`, `ng+sem2`, `level` 1/3/5/8, the largest
  faculty (Arts and Social Science), `credits=8` (offered in the UI; it is the one that needed
  its own index, see below).
- Depth 50 (the `MAX_TOPK` ceiling) for every pair; depths 3 and 15 (`topK` 1 and 5) as well for
  the selective filters `sem3`, `sem4`, `level8`, `credits8`, `ng+sem2`.
- Oracle: every match of the MATCH expression with its `rank`, sorted by (rank, rowid), filtered
  in JS from the JSON `semesters` and the plain columns (not the generated columns), cut to the
  depth.

## Result
- **Exact: 0 mismatches** over 5,421 query × filter pairs at depth 50 and every shallow pair.
- **Rows read per search (D1 `meta.rows_read`, depth 50, 5,421 pairs):**

| mean | p50 | p90 | p99 | max | > 4,000 |
|---:|---:|---:|---:|---:|---:|
| 1,071 | 681 | 2,521 | 6,018 | **6,989** | 219 |

- Gate (plan Final #1): worst ≤ 8,000. **Met: 6,989**, `q="how to"` (5,840 matches),
  `credits=8`, which hit the cap with too few survivors and ran the filter-driven plan.
- Worst per filter: sem1 318, sem2 360, sem3 6,791, sem4 6,749, ng 2,695, ng+sem1 3,189,
  ng+sem2 2,942, level1 4,886, level3 1,904, level5 680, level8 6,022, faculty 1,867,
  credits8 6,989.
- 2,285 pairs ran the second statement (fewer than 50 survivors in the bounded pass); for
  narrow queries its cap probe costs a few rows and the join is skipped.

## How the cost is bounded
`src/lexical.js` `runFts`, filtered branch:
1. Bounded pass: `WITH hits AS (… MATCH ? ORDER BY rank LIMIT 2000) SELECT … FROM hits CROSS
   JOIN modules m … WHERE <filters> ORDER BY hits.rank, hits.rowid LIMIT ?`. Local D1 counts one
   row per FTS hit yielded and one per `modules` lookup, so ≤ ~4,000; it stops as soon as
   `limit` rows survive (sem1: ≤ 318).
2. Only if fewer than `limit` survived: one statement whose outermost loop is
   `capped = count(*) of ≤ 2,001 matches` (≤ 2,001 rows). If `capped.n ≤ 2000` the bounded answer
   was complete and the join below it never runs. Otherwise the filter-driven plan: walk the
   filtered rows through an index, probe FTS5 by rowid (`INDEX 0:=M3`), sort the survivors by
   (rank, rowid). Cost ≈ filtered-set size + matching rows.

Measured details that shaped this:
- A scalar-subquery guard in `WHERE` is not hoisted: SQLite still walked every `modules` row
  (6,831 rows read on `"quantum"`, `sem1`, guard false). The guard as the outermost
  `CROSS JOIN` row costs 60.
- Without indexes on the selective filter columns the filter-driven plan is `SCAN m`:
  worst 13,278 rows (sem3/sem4), level8 12,787. 0006 therefore adds `idx_modules_level`,
  `idx_modules_credits` and partial `idx_modules_sem3`/`idx_modules_sem4`
  (EXPLAIN then shows `SEARCH m USING INDEX …`).
- With those indexes and a plain `JOIN` in the bounded pass, SQLite drove from the level index
  and built an automatic index on `hits`, losing the early stop (`level=5` on
  "buildings and urban design": 7,455 rows; `CROSS JOIN`: 211).
- FTS5's `ORDER BY rank` returns exact-bm25 ties in rowid order (checked over all 417 queries
  at LIMIT 50/200/2000, old and new schema), so (rank, rowid) is one total order across the
  bounded pass, the fallback and the oracle.

## Residual
The bound depends on the filtered set being small whenever the fallback runs. A filter set
with no selective indexed column (sem1 or sem2 alone, or with ng) would scan `modules` if it
ever reached the fallback: it needs fewer than `limit` of the top 2,000 matches to be in a
62% (sem1/2) or 17% (ng) slice, which none of the 82 broad queries comes near (sem1 worst
318). Theoretical worst then ≈ 4,000 + 2,001 + 6,771 + matches.
