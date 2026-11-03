# Phase 1 remote operations log

Every remote write step, its estimate and the actual D1 `meta`, in order. Times are UTC.
Headroom rule (ADR 0002): proceed only if `estimate × 1.5 < 100k − account writes today`.

## 2026-11-03

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 21:55 | Headroom check (GraphQL `d1AnalyticsAdaptiveGroups`, all 10 databases) | — | account today: 1,104,963 read / 2,890 written |
| 21:57:02 | Read replication `mode: auto` (REST `PUT …/d1/database/<id>`); was `disabled`, primary `WEUR` | 0 rows | `{"mode":"auto"}` |
| 21:57:07 | Time Travel bookmark before 0006 | — | `0000007e-00000004-00005118-baec8d8f29c9a8d8f4eea741e283f989` |
| 21:57:15 | Remote schema read (sqlite_master) | ~30 read | 29 read / 0 written; no `d1_migrations`, old FTS + 3 triggers |
| 21:57:26 | `d1_migrations` bootstrap + 0006, one `d1 execute --remote --file` (`scripts/remote-migration.mjs 0006_fts_external --bootstrap`) | 30,076 written (×1.5 = 45.1k < 97.1k headroom), ~48k read | **41,440 read / 14,108 written**, 27 queries, 651 ms, 16,005 changes, size 15.59 MB, final bookmark `0000007e-00000014-00005118-087358db79a7a7d987aa8df5ec015ae6` |
| 21:57:40 | Checks: `migrations list --remote` (none pending); FTS `integrity-check`; `meta.schema`=6, 6 `d1_migrations` rows, 4 triggers, `MATCH 'algorithm'` = 220 | ~300 read | integrity 0 read / 1 written; checks 250 read |
| 21:58:24 | Facets row rebuilt: one `POST /admin/facets` through `wrangler dev --remote` (secret from `.dev.vars`; production has none) | ~21.5k read | 200: 26 faculties, 7 levels, 1,175 NG, list dated 01 Sep 2026 |
| 21:58:55 | `npm run deploy`: version `75ec8580-8545-4512-a48d-f1e99b659490`, tag `c2d37d5` | — | live; previous version `c6744373-1aff-4d8d-8b7f-6dd4e6c3d513` (2026-09-04, rollback target) |
| 21:59 | Smoke: `/health` + 3 searches (`requests.tsv` 65–68) | — | all 200, `x-app-version c2d37d5`, none degraded |
| 21:59:56 | Headroom re-check | — | account today: 1,147,208 read / 17,002 written (+42,245 / +14,112); nusmods 110,435 / 14,109 |

**0006 estimate vs actual.** D1 billed 14,108 writes against the 30,076 estimate. The estimate
added every index entry (14,068) to `total_changes()` (16,008); D1's `rows_written` (14,108) is
close to `total_changes()` alone, so remote D1 does not bill index entries as separate rows here.
Reads (41,440) were under the ~48k estimate. The forced re-ingest estimate (37,251 charged) keeps
its margin; the real figure is measured on a small batch first (plan step 4).

**Still to do (plan order):** small-batch remote ingest measurement, then the forced full
re-ingest on a **different UTC day** (2026-11-04, 20:00–23:00 UTC, after the headroom check);
SC7 measurement; second fidelity check; `served_by_region` check of read replication in the
structured logs.
