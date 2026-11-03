# 0002 — Phase 1 remote operations: 0006 write budget, read replication, ordering

Status: accepted (lead decision, 2026-11-04). Read replication part pending execution.

## Context
Phase 1 changes the production D1 schema (0006) and forces a full re-ingest (SC6). D1 Free caps
writes at 100k rows/day **account-wide**; exceeding it fails every D1 query on the account until
00:00 UTC. The plan (`docs/plans/phase1.md`, Final) budgeted 0006 at ~16k rows written.

## Evidence (PR #8, `docs/evidence/phase1/0006-cost.md`, `lexical-cost.md`)
- Without filter-column indexes the exact filtered fallback scans `modules`: worst case 13,278 rows
  read per search, over the 8,000 gate. With indexes on level, credits, partial sem3/sem4:
  worst 6,989 (`"how to"` + `credits=8`), p99 6,018, mean 1,071, over 440 queries × 13 filters,
  0 mismatches vs brute force.
- Cost of those indexes: 0006 ≈ 30,100 rows written (16,008 FTS rebuild + 14,068 index entries),
  ≈ 48k read; forced full re-ingest ≈ 6,771 read / 34,381 written (vs ~20k without indexes; old
  triggers: ~45.9M read).

## Options
1. Drop the indexes, accept a 13k-row worst case (violates the 8k gate).
2. Keep exactness, add indexes, pay ~14k extra writes once and ~14k extra per forced re-ingest.
3. Bound the fallback and give up exactness (violates SC6).

## Decision
Option 2. Both remote write steps fit inside the cap individually with the ×1.5 headroom rule
(0006: 45k; re-ingest: 52k) but **not together** (97k + other projects). So:
- 0006 and the forced re-ingest run on **different UTC days**, each late in the UTC day, each only
  after the account-wide headroom check (`estimate × 1.5 < 100k − today's writes`).
- Ingest's `--write-budget` default is raised to 40k so a single forced run completes in one go.

## Read replication
Enable `read_replication.mode = auto` (free; APAC replica; reversible within 24 h) before the
Phase 1 deploy, verified by `served_by_region` in the structured logs. The Worker already reads via
`withSession('first-unconstrained')` (PR #7), which is harmless with replication off.

## Dissent
None from critics (this trade-off was found during implementation, after the planning loop).
