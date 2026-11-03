# Filtered lexical search: exactness and rows read (Phase 1A, B1)

Measured 2026-11-04, locally only: workerd + local D1 (vitest-pool-workers), full pinned corpus
(6,771 modules, release `data-2026-2027-20260904`) loaded through `/admin/ingest`, migrations
0001–0006, facets row rebuilt through `/admin/facets`. Source: `test/full/lexical.test.js`, test
`filtered lexical equals brute force on a grid of single, two- and many-filter searches, and
costs <= 8,000 rows read`, which logs the `[1A] {"filteredCost": …}` line quoted below
(`FULL_CORPUS=1 npx vitest run test/full --silent=false`).

## Grid
- **Single filters (62):** every value each filter takes on the corpus: `sem` 1–4, `ng`, 7
  `level` values, 24 `credits` values, 26 faculties. Run over `test/fixtures/lexical-queries.json`
  (critic C's 440-query set, 417 distinct) plus the broad queries below: 419 queries. Depth 50
  (the `MAX_TOPK` ceiling) for every pair; depths 3 and 15 (`topK` 1 and 5) as well for the
  selective values (sem3, sem4, level 8, credits 8, a third of the faculties).
- **Two filters (1,263):** every combination of values of two different filters.
- **Three to five filters (412):** every combination of each filter's two most common values
  (sem: all four; level 5, 4; credits 4, 2; Arts and Social Science, College of Design and
  Engineering; ng), plus 200 seeded uniform draws over all values.
- **Broad queries (12)** for the multi-filter grids, each matching more than 2,000 modules
  (asserted), so every search can reach the filter-driven plan: `and`, `the`, `in`,
  `students will learn`, `how to`, `students`, `of`, `to`, `for`, `with`, `is`, `course`.
- Oracle: every match of the MATCH expression with its `rank`, sorted by (rank, rowid), filtered
  in JS from the JSON `semesters` and the plain columns (not the generated columns), cut to the
  depth.

46,078 depth-50 searches with counts, plus 6,700 without (below).

## Result (facets row with counts, the production path)
**Exact: 0 mismatches** in every grid, every depth. **Rows read per search** (D1
`meta.rows_read`, depth 50):

| grid | searches | mean | p50 | p90 | p99 | max | > 6,000 | > 8,000 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| single filter | 25,978 | 2,160 | 1,334 | 6,004 | 6,312 | **6,989** | 3,230 | 0 |
| two filters | 15,156 | 5,843 | 6,011 | 6,272 | 6,720 | **7,646** | 14,273 | 0 |
| 3–5 filters | 4,944 | 6,009 | 6,243 | 7,100 | 7,420 | **7,772** | 4,589 | 0 |

Gate (plan Final #1): worst ≤ 8,000. **Met: 7,772**, `"students will learn"` (5,596 matches)
with sem=1, level=5, Arts and Social Science.

Worst per shape: single: sem 6,791, level 6,022, credits 6,989, faculty 6,850, ng 2,695. Two:
level+sem 6,855, credits+sem 7,016, faculty+sem 7,110, ng+sem 6,294, credits+level 6,842,
faculty+level 7,576, level+ng 7,242, credits+faculty 6,953, credits+ng 6,590, faculty+ng 7,646.
Three to five: 6,494–7,772 for every shape.

Before this driver choice the PR #8 review measured 657 of 34,385 searches over 8,000 on a
similar grid; worst example `lexicalSearch(db, 'in', { faculty: 'Computing', credits: 4 }, 50)`
at 11,546 rows. It is now 6,781.

## Without counts (fixed order): exact, but over the gate
A facets row written before the counts existed (the production row until `/admin/facets` runs
after the deploy) falls back to `FIXED_DRIVER_ORDER`: sem3/sem4, faculty, ng, level, credits,
the indexed filters ordered by their largest per-value row count (sem3 284, sem4 242; faculty
up to 1,363; ng 1,175; level up to 2,713; credits up to 5,081). Over the two-filter and 3–5
grids on `and`, `the`, `in`, `students will learn`, 0 mismatches:

| grid | searches | mean | p99 | max | > 8,000 |
|---|---:|---:|---:|---:|---:|
| two filters | 5,052 | 6,115 | 8,715 | **9,148** | 85 |
| 3–5 filters | 1,648 | 6,256 | 7,773 | **9,005** | 16 |

Worst: `and`, level=5 + credits=5 (level drives: 2,713 rows instead of 407). No order by
filter alone can be right here: level=5 is a worse driver than credits=5 but a better one than
credits=4. The fix is the rebuild, done **before** the deploy: apply 0006, then run
`POST /admin/facets` with this code through `wrangler dev --remote` (~21.5k rows read), then
deploy. Until the counts exist, search costs up to ~9.1k rows on these shapes. A row without
counts is not cached, so an isolate that read it re-reads it on its next fallback. The test
logs these numbers and asserts exactness, not the gate.

## How the cost is bounded
`src/lexical.js` `runFts`, filtered branch:
1. Bounded pass: `WITH hits AS (… MATCH ? ORDER BY rank LIMIT 2000) SELECT … FROM hits CROSS
   JOIN modules m … WHERE <filters> ORDER BY hits.rank, hits.rowid LIMIT ?`. Local D1 counts one
   row per FTS hit yielded and one per `modules` lookup, so ≤ ~4,000; it stops as soon as
   `limit` rows survive.
2. Only if fewer than `limit` survived: one statement whose outermost loop is
   `capped = count(*) of ≤ 2,001 matches` (≤ 2,001 rows). If `capped.n ≤ 2000` the bounded answer
   was complete and the join below it never runs. Otherwise the filter-driven plan: walk the
   filtered rows through **one** index, probe FTS5 by rowid (`INDEX 0:=M3`), sort the survivors
   by (rank, rowid). On a broad query steps 1–2 cost ~6,000 before the walk, so the walk is
   what the driver choice controls.
3. The driver (`chooseDriver`) is the active indexed filter with the fewest rows, from the
   per-value counts in `meta('facets')`: faculty, level, ng (already there) and credits, sem1–4,
   ng_sem1–2 (added; `/admin/facets` rebuilds them). sem1/sem2 have no index and never drive.
   Every other filter is written `+m.col`, so SQLite cannot use its index. The counts are read
   once per isolate, only when a search with two or more indexed filters reaches step 2 (a test
   asserts the common path stays one D1 query).

Without sqlite_stat1, SQLite chooses among equality indexes by creation order, not selectivity;
`ANALYZE` would not help, since stat1 holds per-index averages and still ranks credits ahead of
level=6. EXPLAIN QUERY PLAN for the filter-driven statement, the `m` line (query `in`; rows read
by that statement alone):

| filters | before (no driver) | after |
|---|---|---|
| faculty=Computing, credits=4 | `idx_modules_credits (credits=?)`, 7,498 | `idx_modules_faculty (faculty=?)`, 2,732 |
| credits=4, level=5 | `idx_modules_credits (credits=?)`, 10,426 | `idx_modules_level (level=?)`, 8,058 (¹) |
| faculty=Computing, level=4 | `idx_modules_level (level=?)`, 3,213 | `idx_modules_faculty (faculty=?)`, 2,448 |
| level=1, ng | `idx_modules_level (level=?)` | `idx_modules_level (level=?)` (531 < 1,175) |
| level=5, ng | `idx_modules_level (level=?)` | `idx_modules_ng (ng=?)` (1,175 < 2,713) |
| credits=4, Computing, level=3, ng, sem=3 | `idx_modules_sem3 (sem3=?)` | `idx_modules_sem3 (sem3=?)` |

(¹) Never reached by a search: credits=4 + level=5 is common enough that the bounded pass fills
the page (`lexicalSearch` on `in`: 350 rows read, one statement).

The full plan is otherwise unchanged: `SCAN modules_fts VIRTUAL TABLE INDEX 0:M3` (cap probe),
`SCAN capped`, `SEARCH m USING INDEX …`, `SCAN modules_fts VIRTUAL TABLE INDEX 0:=M3`,
`USE TEMP B-TREE FOR ORDER BY`. `test/lexical-driver.test.js` asserts, for nine shapes and each
of their filters as driver, that the plan walks exactly that index.

Measured details that shaped the earlier design:
- A scalar-subquery guard in `WHERE` is not hoisted: SQLite still walked every `modules` row
  (6,831 rows read on `"quantum"`, `sem1`, guard false). The guard as the outermost
  `CROSS JOIN` row costs 60.
- Without indexes on the selective filter columns the filter-driven plan is `SCAN m`:
  worst 13,278 rows (sem3/sem4), level8 12,787. 0006 therefore adds `idx_modules_level`,
  `idx_modules_credits` and partial `idx_modules_sem3`/`idx_modules_sem4`.
- With those indexes and a plain `JOIN` in the bounded pass, SQLite drove from the level index
  and built an automatic index on `hits`, losing the early stop (`level=5` on
  "buildings and urban design": 7,455 rows; `CROSS JOIN`: 211).
- FTS5's `ORDER BY rank` returns exact-bm25 ties in rowid order (checked over all 417 queries
  at LIMIT 50/200/2000, old and new schema), so (rank, rowid) is one total order across the
  bounded pass, the fallback and the oracle.

## Residual
- Headroom is thin: a search that reaches step 2 on a broad query costs ≥ ~6,000 before the
  walk (p50 of the two-filter grid is 6,011), and the worst is 7,772. A combination where every
  active filter has a large row count yet few of the top 2,000 matches pass could exceed
  8,000; none of the 46,078 searches does.
- A filter set with no indexed column (sem1 or sem2 alone) would scan `modules` if it ever
  reached step 2; it never does in the grid (worst sem 6,791 is sem3/sem4).
- Counts go stale between ingests; that only affects which index drives, never the answer.
