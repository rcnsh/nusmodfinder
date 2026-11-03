# Ingest cost (Phase 1C, SC6)

Measured 2026-11-04, locally only: workerd + local D1 (vitest-pool-workers), full pinned corpus
(6,771 modules, release `data-2026-2027-20260904`), migrations 0001–0006, fake Workers AI and
Vectorize. No remote command was run. Source: `test/full/ingest.test.js`, which drives
`scripts/ingest-core.mjs` (the code `npm run ingest` runs) into the real admin routes and logs
the `[1C] {…}` line below (`FULL_CORPUS=1 npx vitest run test/full/ingest.test.js --silent=false`).

**Meter.** Every D1 statement any admin route runs, `/admin/hashes` and the facets rebuild
included, is wrapped and its `meta.rows_read` / `meta.rows_written` summed. "Budget" is what
the ingest script itself sums against `--write-budget`: `meta.rows_written` from the
`/admin/ingest` and `/admin/delete` responses only (the facets rebuild writes 2 more rows).
Local D1 does not see the writes FTS5 makes to its own shadow tables (0006-cost.md), so the
written figures below are table and index rows only.

## Estimates (written before measuring)
From `0006-cost.md` (forced upsert: 6,771 read / 34,381 written; ~5.1 writes per upserted
row) and `src/modules.js` (the facets rebuild's live aggregates: ~21.5k rows read):

| run | rows read | rows written |
|---|---:|---:|
| forced full re-ingest | 6,771 hashes + 6,771 upserts + 21.5k facets ≈ 35k | ≈ 34.4k |
| no-op rerun | 6,771 + 21.5k ≈ 28.3k | ≈ 2 |
| field-only change, 25 modules | ≈ 28.3k + 25 | 25 × ~5 ≈ 125 |
| delete 10 modules | ≈ 28.3k + 10 | 10 × ~6 ≈ 60 |

## Measured

| run | rows read | rows written | budget sum | Workers AI calls | estimate (read / written) |
|---|---:|---:|---:|---:|---|
| **forced full re-ingest** (`--force`, 6,771 re-embedded) | **35,079** | **34,383** | 34,381 | 136 | 35k / 34.4k |
| no-op rerun (nothing changed) | 28,308 | 2 | 0 | 0 | 28.3k / 2 |
| **field-only change**, 25 modules (semesters ×10, credits ×5, prerequisite ×5, NG ×5) | **28,334** | **138** | 136 | 0 | 28.3k / 125 |
| **delete 10 modules** | **28,317** | **22** | 20 | 0 | 28.3k / 60 |
| `npm run verify` (D1 side, sample 100) | 6,761 | 0 | | | ~7k |
| cold load, default budget (empty 0006 database) | 17,872 | 39,627 | 39,623 | 112 | stopped cleanly at 5,600 / 6,771 |
| cold load, rerun (resumes through the hash skip) | 27,137 | 8,302 | 8,300 | 24 | |

**SC6: a forced full re-ingest reads 35,079 rows, 0.7% of the 5,000,000/day limit (gate:
< 500,000).** It writes 34,381 rows by the script's own count, inside the 40,000 default
budget (ADR 0002), so it completes in one run. Most of the reads are fixed per run:
`/admin/hashes` reads every row (6,771) and the facets rebuild's aggregates read ~21.5k; the
upserts themselves read one row each.

Line from the run:
```
[1C] {"modules":6771,"coldDefaultBudget":{"status":"budget","plan":{"embed":6771,"rowOnly":0,"unchanged":0,"deletes":0},"embedded":5600,"deleted":0,"aiCalls":112,"budgetRowsWritten":39623,"rowsRead":17872,"rowsWritten":39627,"statements":5609},"coldResume":{"status":"done","plan":{"embed":1171,"rowOnly":0,"unchanged":5600,"deletes":0},"embedded":1171,"deleted":0,"aiCalls":24,"budgetRowsWritten":8300,"rowsRead":27137,"rowsWritten":8302,"statements":1180},"forced":{"status":"done","plan":{"embed":6771,"rowOnly":0,"unchanged":0,"deletes":0},"embedded":6771,"deleted":0,"aiCalls":136,"budgetRowsWritten":34381,"rowsRead":35079,"rowsWritten":34383,"statements":6780},"noop":{"status":"done","plan":{"embed":0,"rowOnly":0,"unchanged":6771,"deletes":0},"embedded":0,"deleted":0,"aiCalls":0,"budgetRowsWritten":0,"rowsRead":28308,"rowsWritten":2,"statements":9},"fieldOnly25":{"status":"done","plan":{"embed":0,"rowOnly":25,"unchanged":6746,"deletes":0},"embedded":0,"deleted":0,"aiCalls":0,"budgetRowsWritten":136,"rowsRead":28334,"rowsWritten":138,"statements":34},"delete10":{"status":"done","plan":{"embed":0,"rowOnly":0,"unchanged":6761,"deletes":10},"embedded":0,"deleted":10,"aiCalls":0,"budgetRowsWritten":20,"rowsRead":28317,"rowsWritten":22,"statements":10},"verify":{"rowsRead":6761,"rowsWritten":0,"sample":100}}
```

## Against the estimates
- Forced, no-op and field-only land within 1–10% of the estimates. Field-only writes 5.4 rows
  per changed module (estimate 5).
- **Deletes are under the estimate** (2 rows written per deleted module, estimated 6): local D1
  reports the row and its primary-key entry but not the filter-index entries a DELETE removes,
  and not FTS5's `'delete'` writes. Remote D1 may count more; a bound from structure is ≤ ~10
  per module (row, PK, ≤ 6 index entries, FTS docsize and segment rows), so a 10-module delete
  is ≤ ~100 rows written either way, and ingest reserves deletes at the run's worst upsert rate (6 per module if none) against its
  budget until a batch reports.
- **Cold load was not estimated and exceeds the default budget.** An INSERT writes ~7.1 rows
  per module (row, PK entry and every filter index) against ~5.1 for an update, so loading an
  empty database costs ~47.9k rows written. The budget stopped it cleanly at 39,623 and the
  rerun finished it through the hash skip, which is the resume path working as designed. The
  remote database is not empty, so the planned remote operation is the forced re-ingest above;
  rebuilding production from empty would take two runs on two UTC days, or a higher
  `--write-budget` after the headroom check.

## Remote estimate
Same SQL, so remote reads should match these within the FTS caveat above (reads are not
affected: the forced re-ingest touches no FTS row, `test/full/lexical.test.js` asserts the
shadow tables are byte-identical). For the first remote run after 0006 every `row_hash` is NULL
and every `text_hash` uses the new formula (model + text version + text), so that run is the
forced full re-ingest: **≈ 35k rows read, ≈ 34.4k rows written**, ~6,771 embeddings
(≈ 2k neurons, plan "Write-cap safety"). With the ×1.5 headroom rule: 52k writes, as ADR
0002 budgets. Measured remote figures come from the run itself (the script prints the
budget sum) and `d1 info` before and after.
