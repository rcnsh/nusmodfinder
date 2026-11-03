# Ingest cost (Phase 1C, SC6)

Measured 2026-11-04, locally only: workerd + local D1 (vitest-pool-workers), full pinned corpus
(6,771 modules, release `data-2026-2027-20260904`), migrations 0001–0006, fake Workers AI and
Vectorize. No remote command was run. Source: `test/full/ingest.test.js`, which drives
`scripts/ingest-core.mjs` (the code `npm run ingest` runs) into the real admin routes and logs
the `[1C] {…}` line below (`FULL_CORPUS=1 npx vitest run test/full/ingest.test.js --silent=false`).

**Meter.** Every D1 statement any admin route runs, `/admin/hashes` and the facets rebuild
included, is wrapped and its `meta.rows_read` / `meta.rows_written` summed. "Budget sum" is
what D1 reported to the ingest script: `meta.rows_written` from the `/admin/ingest` and
`/admin/delete` responses only (the facets rebuild writes 2 more rows). "Charged" is what the
script counts against `--write-budget`: per call, the larger of that and its estimate, which
includes FTS5 shadow-table writes (below). Local D1 does not see the writes FTS5 makes to its
own shadow tables (0006-cost.md), so the D1 written figures are table and index rows only.

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

| run | rows read | rows written (D1) | budget sum | charged | Workers AI calls | estimate (read / written) |
|---|---:|---:|---:|---:|---:|---|
| **forced full re-ingest** (`--force`, 6,771 re-embedded) | **35,102** | **34,383** | 34,381 | **37,251** | 136 | 35k / 34.4k |
| no-op rerun (nothing changed) | 28,331 | 2 | 0 | 0 | 0 | 28.3k / 2 |
| **field-only change**, 25 modules (semesters ×10, credits ×5, prerequisite ×5, NG ×5) | **28,357** | **138** | 136 | 138 | 0 | 28.3k / 125 |
| **delete 10 modules** | **28,380** | **32** | 30 | 120 | 0 | 28.3k / 60 |
| `npm run verify` (D1 side, sample 100) | 6,761 | 0 | | | | ~7k |
| cold load, default budget (empty 0006 database) | 5,689 | 12,788 | 12,784 | 39,600 | 36 | stopped cleanly at 1,800 / 6,771 |
| cold load, rerun with `--write-budget 200000` (resumes through the hash skip) | 23,360 | 35,141 | 35,139 | 109,362 | 100 | |

**SC6: a forced full re-ingest reads 35,102 rows, 0.7% of the 5,000,000/day limit (gate:
< 500,000).** D1 reports 34,381 rows written to the script, and the budget charges 37,251
(5.5 per row, no FTS term), inside the 40,000 default (ADR 0002), so it completes in one run.
Most of the reads are fixed per run: `/admin/hashes` reads every row (6,771) and the facets
rebuild's aggregates read ~21.5k; the upserts themselves read one row each. (Reads are 23 per
run higher than before the PR #13 review fixes: the schema check now lists every trigger in
`sqlite_master`.)

Line from the run:
```
[1C] {"modules":6771,"coldDefaultBudget":{"status":"budget","plan":{"embed":6771,"rowOnly":0,"unchanged":0,"deletes":0},"embedded":1800,"deleted":0,"aiCalls":36,"budgetRowsWritten":12784,"budgetRowsCharged":39600,"rowsRead":5689,"rowsWritten":12788,"statements":1809},"coldResume":{"status":"done","plan":{"embed":4971,"rowOnly":0,"unchanged":1800,"deletes":0},"embedded":4971,"deleted":0,"aiCalls":100,"budgetRowsWritten":35139,"budgetRowsCharged":109362,"rowsRead":23360,"rowsWritten":35141,"statements":4980},"forced":{"status":"done","plan":{"embed":6771,"rowOnly":0,"unchanged":0,"deletes":0},"embedded":6771,"deleted":0,"aiCalls":136,"budgetRowsWritten":34381,"budgetRowsCharged":37251,"rowsRead":35102,"rowsWritten":34383,"statements":6780},"noop":{"status":"done","plan":{"embed":0,"rowOnly":0,"unchanged":6771,"deletes":0},"embedded":0,"deleted":0,"aiCalls":0,"budgetRowsWritten":0,"budgetRowsCharged":0,"rowsRead":28331,"rowsWritten":2,"statements":9},"fieldOnly25":{"status":"done","plan":{"embed":0,"rowOnly":25,"unchanged":6746,"deletes":0},"embedded":0,"deleted":0,"aiCalls":0,"budgetRowsWritten":136,"budgetRowsCharged":138,"rowsRead":28357,"rowsWritten":138,"statements":34},"delete10":{"status":"done","plan":{"embed":0,"rowOnly":0,"unchanged":6761,"deletes":10},"embedded":0,"deleted":10,"aiCalls":0,"budgetRowsWritten":30,"budgetRowsCharged":120,"rowsRead":28380,"rowsWritten":32,"statements":11},"verify":{"rowsRead":6761,"rowsWritten":0,"sample":100}}
```

## FTS5 shadow-table writes

`docs/evidence/phase1/fts-writes.mjs` (`node docs/evidence/phase1/fts-writes.mjs`):
migrations 0001–0006 in node:sqlite, the pinned corpus through the exact `/admin/ingest` and
`/admin/delete` SQL in batches of 50, `total_changes()` per batch minus the same statements'
count on a twin database without the three FTS triggers (the method of 0006-cost.md):

```
{"coldLoad":{"modules":6771,"ftsShadowWrites":89337,"perModule":"13.19","maxFtsWritesInOneBatch":2402,"totalChanges":96108},"forcedReingest":{"modules":6771,"ftsShadowWrites":0,"perModule":"0.00","maxFtsWritesInOneBatch":0,"totalChanges":6771},"titleChange":{"modules":678,"ftsShadowWrites":10635,"perModule":"15.69","maxFtsWritesInOneBatch":1818,"totalChanges":11313},"delete":{"modules":677,"ftsShadowWrites":1974,"perModule":"2.92","maxFtsWritesInOneBatch":336,"totalChanges":3328}}
```

| operation | FTS5 shadow writes | per module | max in one batch of 50 |
|---|---:|---:|---:|
| cold load (6,771 inserts) | **89,337** | 13.19 | 2,402 |
| forced re-ingest, text unchanged | **0** | 0 | 0 |
| title change (678 modules) | 10,635 | 15.69 | 1,818 |
| delete (677 modules) | 1,974 | 2.92 | 336 |

The forced re-ingest writes no FTS row: the update trigger fires only when code, title or
description change (`test/full/lexical.test.js` also asserts the shadow tables are byte-identical
after it). The budget's estimate per module (`scripts/ingest-core.mjs` DEFAULTS) is: insert 8 +
14 FTS; text changed (by `text_hash`, a superset of a title/description change) 5.5 + 16 FTS;
same text 5.5; delete 12 (the hash-clearing UPDATE, the DELETE and FTS). Automerges bunch the
FTS writes into a few batches (max 2,402, ~48 per module), so one batch can exceed its estimate;
over a run the estimate exceeds the measured mean.

## Against the estimates
- Forced, no-op and field-only land within 1–10% of the estimates. Field-only writes 5.4 rows
  per changed module (estimate 5).
- Deletes write one more row per module than before the PR #13 review fixes: `/admin/delete`
  clears the row's hashes before Vectorize deletes the vector, so a module whose D1 delete
  fails is re-embedded if it comes back.
- **Deletes are under the estimate** (2 rows written per deleted module, estimated 6): local D1
  reports the row and its primary-key entry but not the filter-index entries a DELETE removes,
  and not FTS5's `'delete'` writes. Remote D1 may count more; a bound from structure is ≤ ~10
  per module (row, PK, ≤ 6 index entries, FTS docsize and segment rows), so a 10-module delete
  is ≤ ~100 rows written either way, and ingest reserves deletes at the run's worst upsert rate (6 per module if none) against its
  budget until a batch reports.
- **A cold load costs ~137k rows written, over the 100k/day account cap.** An INSERT writes
  ~7.1 table and index rows per module (row, PK entry and every filter index; local D1 reports
  47,923 for the corpus) plus ~13.2 FTS5 shadow rows local D1 does not report (89,337): about
  137k in all. This doc used to say ~47.9k, from local D1's meta alone; the PR #13 review caught
  it. The budget now charges each insert 22 rows (148,962 for the corpus), so the default stops
  a cold load cleanly after ~1,800 modules; the test resumes it with a higher budget.
- **A cold load must not run remotely with the default budget until the remote metering of FTS
  writes is measured.** Whether remote D1 bills FTS5 shadow writes as rows written, and how
  many, is unknown. The charged estimate stops the default run at 40k *if* remote billing
  matches it. The remote database is not empty, so the planned remote operation is the
  forced re-ingest above, which writes no FTS rows. Rebuilding production from empty takes
  at least four UTC days at the default budget. Before that, measure one remote batch's
  FTS writes with `d1 info` before and after.

## Remote estimate
Same SQL, so remote reads should match these within the FTS caveat above (reads are not
affected: the forced re-ingest touches no FTS row, `test/full/lexical.test.js` asserts the
shadow tables are byte-identical). For the first remote run after 0006 every `row_hash` is NULL
and every `text_hash` uses the new formula (model + text version + text), so that run is the
forced full re-ingest: **≈ 35k rows read, ≈ 34.4k rows written** (37.3k charged; no FTS
writes), ~6,771 embeddings (≈ 2k neurons, plan "Write-cap safety"). With the ×1.5 headroom
rule: 52k writes, as ADR 0002 budgets. Every existing vector lacks `metadata.textHash`, so this
run re-embeds everything anyway, and later row-only runs reuse stored values. Measured remote figures come from the run itself (the script prints the
budget sum) and `d1 info` before and after.
