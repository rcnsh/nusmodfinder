# Phase 1 remote operations log

Every remote write step, its estimate and the actual D1 `meta`, in order. Times are UTC.
Headroom rule: ADR 0002 (Free plan, until 2026-11-04) was `estimate × 1.5 < 100k − account writes today`;
ADR 0004 (Workers Paid) is `estimate × 1.5 <` the month's remaining included writes (50M/month).

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

## 2026-11-04

Account on Workers Paid (ADR 0004): no daily write cap, so the forced re-ingest ran the same
morning instead of in the 20:00 UTC window. All runs went through `wrangler dev --remote --port 8787`
from `main` (`src/` identical to the deployed `c2d37d5`), secret from `.dev.vars`.

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 05:39 | Headroom check (GraphQL, account-wide, today) | — | 191,499 read / 503 written; Workers AI 0 neurons |
| 05:42 | **Small batch**: `ingest --force --batch 10 --concurrency 1 --write-budget 100` (fresh NUSMods fetch) | ~55 written, ~7k read (hashes) | 10 modules: **52 written** (5.2/module), 71 charged, 10 read by the ingest calls; stopped by the budget as intended (exit 2), no deletes, facets rebuilt. Extrapolated ×677: ~35.2k written, well under the plan's 60k / 250k gate |
| 05:42 | Finding: the fresh fetch overwrote `.data/2026-2027-moduleInfo.json`, which is also the pinned snapshot path | — | restored from release `data-2026-2027-20260904` (sha256 `2d138795…` checked); cache moved to `.data/cache/` in PR #16 |
| 05:44–05:47 | **Forced full re-ingest** from the pinned snapshot: `ingest --force --offline --write-budget 45000` | ~35.2k written (37.3k charged), ~35k read incl. hashes and facets, 2–3k neurons | **6,771 upserted, 6,771 embedded, 0 deleted; D1 reported 34,383 written** (local: 34,381), 37,267 charged, 6,771 read by the ingest calls; 101 s of batches, Vectorize confirmed the last mutation after 19 polls; **2,395 neurons**; data version `2d138795d387` → `c25f43ebfbdb` |
| 05:48 | `npm run verify` | 6,771 read | OK: 6,771 rows, 6,771 vectors, 0 missing, 0 extra, 0 row_hash drift, 100-vector metadata sample 0 drift |
| 05:49 | Headroom re-check (GraphQL lags a few minutes) | — | 239,690 read / 26,209 written so far today; 2,394.7 neurons |

**SC6.** A forced full re-ingest against production writes 34,383 rows (local measurement 34,381) and
its metered ingest calls read 6,771 rows, far under the SC6 gate of 500,000 read.

**Why the pinned snapshot.** NUSMods published a new `moduleInfo.json` at 05:35 UTC: 6,778 offered
modules, 97 dropped and 104 added against the pinned 6,771, and 302 changed (prerequisites 97,
semesters 82, preclusions 57, department 48, descriptions 27). The forced run uses the pinned file so
production keeps matching the eval corpus for the second fidelity check. The new catalogue lands
afterwards as an ordinary incremental ingest.

| 06:05 | `npm run deploy` (PR #18 merged): version `78ef263b-4039-4c7c-9b79-eb17443e68d3`, tag `8d94982` | — | live; smoke `/health` + 1 search 200, `x-app-version 8d94982`, SIN, not degraded |
| 06:22:59 | Second fidelity check's live calls done (PR #20) | — | production still on the pinned corpus |
| 06:29 | Headroom check | — | 296,079 read / 34,999 written today; 2,907 neurons |
| 06:29:35–06:31:02 | **Incremental ingest of the 2026-11-04 NUSMods catalogue** (`ingest --write-budget 20000`, fresh fetch into `.data/cache/`) | ~10k written, ~30k read incl. hashes and facets, ~70 neurons | plan 194 embed / 212 row-only / 6,372 unchanged / 97 delete; **406 upserted (194 embedded), 97 deleted; D1 reported 2,617 written**, 5,596 charged; 1,078 read by the ingest and delete calls; Vectorize confirmed after 13 polls; facets 26 / 7 / 1,167 NG; data version `c25f43ebfbdb` → `c1cf88518972` |
| 06:31 | `npm run verify` | 6,778 read | OK: 6,778 rows, 6,778 vectors, 0 missing / extra / drift |

The catalogue estimate over-counted FTS writes: 2,617 reported against ~10k estimated.

**Production now runs a newer corpus than the eval.** Production has the 2026-11-04 catalogue (6,778
modules). The eval, the full-corpus tests and both fidelity checks use the pinned 2026-09-04
snapshot (6,771). Offline comparisons stay valid, since both sides are replica against replica. A
future live fidelity check needs a new pinned snapshot first.

**Still to do:** deploy data version `c1cf88518972`; the SC7 measurement and the `served_by_region`
check (PR pending). SC7 samples taken between 06:29:35 and 06:31:02 overlap the ingest and are
excluded.

## 2026-11-04: D1 primary to APAC (ADR 0005)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 06:59:17–06:59:32 | `npm run deploy` (PR #22): version `d367e6e0-5f5e-42e6-9410-1c8429e76adf`, tag `2cd9273` | — | live; `/health` 200 |
| 07:38 | Headroom check | — | 357,657 read / 37,712 written today; 2,976 neurons |
| 07:38 | `wrangler d1 create nusmods-apac --location apac` | 0 rows | `de4527ff-19ec-4a5b-9c5c-4d1791078b25`, "created in region APAC" |
| 07:39 | `wrangler d1 migrations apply nusmods-apac --remote` (0001–0006 on an empty database) | < 500 written | 25 commands; schema 6, 4 triggers, 6 `d1_migrations` rows, 0 modules (check read 30, served by APAC) |
| 07:40 | Read replication `mode: auto` on `nusmods-apac` (REST PUT) | 0 rows | `{"mode":"auto"}`; `running_in_region: APAC` |
| 07:41:19–07:42:39 | **Cold load** through `wrangler dev --remote` bound to `nusmods-apac`: `ingest --write-budget 160000` | ~137k written (149k charged), ~30k read, ~2.4k neurons | **6,778 upserted, 6,778 embedded** (in-place upsert to the production index), 0 deleted; **D1 reported 47,981 written**, 149,116 charged; Vectorize confirmed after 5 polls; data version `c1cf88518972` (unchanged) |
| 07:43 | `npm run verify` | 6,778 read | OK: 6,778 rows, 6,778 vectors, 0 missing / extra / drift |
| 07:44 | Old and new compared: `MATCH 'algorithm'` and `'management'` counts, module count, facets length; FTS `integrity-check` on the new database | ~16k read | identical (222 / 961 / 6,778 / 2,270) on both; integrity OK |
| 07:44 | Headroom (GraphQL, lagging) | — | 373,701 read / 76,570 written today; 5,971 neurons |

**FTS writes on a cold load.** D1's `meta.rows_written` reported 47,981, about 7.1 per module: table
plus index rows, with no FTS5 shadow rows. The budget's estimate of 149k assumed FTS shadow writes
are billed. The account-wide GraphQL total, once it settles, decides which is right; it is
recorded with the switch below.

**Old database.** `nusmods` (`c6a769d3-…`, WEUR) holds the same catalogue and data version, and
stays as the rollback target (ADR 0005).

| 07:57:37–07:57:54 | `npm run deploy` (PR #24): version `ee96bbd0-add9-4aa6-8f2f-78e219087817`, tag `597c2b7`, `env.DB (nusmods-apac)` | — | live |
| 07:58–08:11 | Post-switch check with `wrangler tail`: two searches right after the deploy, one after 12 min idle (`requests.tsv` 72–74) | — | all three logged `servedByRegion: ["APAC"]`, `servedByPrimary: true`. From SIN: fts 45–269 ms, hydrate 16–43 ms (before the switch the same situations were 520–715 / 201–250 ms from the WEUR primary). The idle sample left through the VPN's Marseille exit, so its fts 399 / hydrate 164 ms is a Marseille-to-APAC round trip, not a SIN measurement |
