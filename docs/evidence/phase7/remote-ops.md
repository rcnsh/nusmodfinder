# Phase 7 remote operations log

Every remote operation, reads included, with its estimate and actual. Times are UTC. Headroom
rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance). Until 7C's ops log
exists, entries are written by hand.

## 2026-11-12: 7-0 measure (reads only; nothing written anywhere)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 01:10:02–01:10:22 | Deploy token check (`requests.tsv` 128): `tokens/verify`, `workers/scripts/nusmodfinder/settings`, a D1 query and the D1 list, ≥ 4 s apart | 4 calls | 4 calls; the token had no D1 permission yet (7403, 10000) |
| 01:19:27–01:19:46 | Re-check after D1 Read was added and the token rolled (`requests.tsv` 129): verify, settings, D1 list, `SELECT count(*) FROM modules` over the D1 REST query endpoint | 5 calls, ~6.8k rows read | 6,778 rows read. The fifth call was a `CREATE TABLE IF NOT EXISTS` probe, refused (7500), so nothing was written. It shouldn't have been sent: permission checks on production stay read-only. |
| (GitHub) | `gh api` reads: repo visibility, rulesets, branch protection on `main`, the last 20 `CI` runs on `main` and their jobs | — | see `measure.md` |
| 01:25:00–01:25:18 | Schema capture (`requests.tsv` 130), 4 × `wrangler d1 execute nusmods-apac --remote --command … --json`, one at a time: the Phase 0 pragma query (`test/fixtures/schema-query.sql`), `sqlite_master`, `index_xinfo` over every index, the `d1_migrations` rows | ~400 rows read | 213 rows read (133 + 25 + 45 + 10); 0 written; saved to `schema/{pragma,master,index_xinfo,d1_migrations}.json` |
| 01:27:44–01:27:46 | GraphQL Analytics (`requests.tsv` 131) with Wrangler's OAuth login: an introspection of the Workers invocations and D1 group fields | 1 call | 1 call |
| 01:28:00–01:28:03 | GraphQL Analytics (`requests.tsv` 131): account-wide `workersInvocationsAdaptive` and `d1AnalyticsAdaptiveGroups` for 2026-11-01 to 2026-11-12 01:28 | 1 call | 1 call; see `measure.md` |

Headroom: about 7k rows read and 11 API calls. The rule holds by orders of magnitude.

## 2026-11-12: field names for 7F (reads only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 02:31:45 | GraphQL Analytics, Wrangler's OAuth login: the `account` type's dataset names (introspection) | 1 call | 1 call; Workers AI is `aiInferenceAdaptiveGroups` |
| 02:31:57 | GraphQL Analytics: `aiInferenceAdaptiveGroups` sum and dimension fields (introspection) | 1 call | 1 call; sums include `totalNeurons`, dimensions include `date` and `modelId` |

## 2026-11-12: 7G ship and the rollback drill (run records in `docs/evidence/ops/runs/`)

Every step below left its own run record; this table only ties them together.

| Time | Step | Run record | Result |
|---|---|---|---|
| 11:13:00 | `year check --full` after the red team fixes (#112): NG list re-extracted byte for byte (Sem 1 730, Sem 2 750), rules byte-identical, 19 quotes | `20261112T111300Z-year-check-9bb5` | ok |
| 11:25:21 | `deploy --preflight` on 447e2e6 (no D1 read) | `20261112T112521Z-deploy-preflight-9a52` | ok |
| 11:25:43 | `DEPLOY_FROM_ACTIONS=true` (repo variable) | — | the Actions deploy is on |
| 11:29:23 | First Actions deploy, run 43209550016, on 894bc1f: guard (the M-1 row-hash recompute: no drift in `modules` or `catalogue_only`), upload, startup gate, promote, tag `deploy/20261112T112951Z-b1ccf7db`, triggers | `20261112T112923Z-deploy-6b4d` (from the run's artifact) | live b1ccf7db; 21,338 D1 rows read |
| 11:30:26 | Smoke, expecting 894bc1f | `20261112T113026Z-smoke-19bb` | 5 of 5 |
| 11:30:56 | Drill: `rollback --to b0834844`; data check 4 of 4 | `20261112T113056Z-rollback-2708` | live b0834844, tag `rollback/20261112T113114Z-b0834844` |
| 11:31:20 | A second `rollback --to b0834844`, sent by the lead's mistake (a stray re-run in an inspection command) | `20261112T113120Z-rollback-a2fc` | refused before any read or deploy; nothing changed |
| 11:31:39 | Smoke, expecting a23601d | `20261112T113139Z-smoke-3fd0` | 5 of 5 |
| 11:32:00 | Drill: `rollback --to b1ccf7db`; data check 4 of 4 | `20261112T113200Z-rollback-9904` | live b1ccf7db, tag `rollback/20261112T113217Z-b1ccf7db`; 21,338 rows read |
| 11:32:26 | Smoke, expecting 894bc1f | `20261112T113226Z-smoke-a179` | 5 of 5 |

Rows read for the ship and the drill: about 64k (three 21.3k reads). The Vectorize standby was not
touched (DENSE_BACKEND stays in-Worker).

## 2026-11-12: the NUSMods refresh (#110, `docs/year-refresh/README.md` "A corpus-only refresh")

| Time | Step | Run record | Result |
|---|---|---|---|
| 11:33:24 | `corpus fetch`, `corpus publish --new-data-version` | `20261112T113329Z-corpus-publish-23b8` | `prod-2026-2027-20261112`, data version 7eb77cf0828b |
| 11:33:47 | `eval:embed` of the 254 new or edited texts (one pass today) | `20261112T113347Z-eval-embed-ef69` | ~48k tokens, ~89 neurons, 3 requests |
| 12:06:21 | The Actions deploy of 46c8d56 (#113's merge), run 43214893068 | (its artifact) | refused at the guard as designed: D1 still held d820d578cf81; nothing deployed |
| 12:06:29 | `deploy --preflight` on 46c8d56 | `20261112T120629Z-deploy-preflight-f036` | ok |
| 12:06:41 | `d1:bookmark` | `20261112T120641Z-d1-bookmark-7db2` | `0000004b-00000000-00005121-9700d9ffa113f4d2bc2388418b0cd7be` |
| 12:06:45 | `remote -- ingest --d1-only` | `20261112T120645Z-remote-4077`, `…120654Z-ingest-ec2c` | 174 rows written, 15 deleted; `catalogue_only` 25 written, 49 deleted; 1,118 rows written as D1 reports them (2,273 charged to the 40k budget) |
| 12:07:12 | `remote -- verify --pre-deploy` | `20261112T120712Z-remote-46da`, `…120724Z-verify-ee2e` | D1, the manifest and the bundle agree; row_hash drift 0; 21,223 rows read |
| 12:07:42 | `npm run deploy` from the Mac | `20261112T120742Z-deploy-e9bb` | live 85b401bc, tag `deploy/20261112T120816Z-85b401bc`; guard read 21,353 rows |
| 12:08:32 | Smoke | `20261112T120832Z-smoke-6b7a` | 5 of 5 |
| 12:09:00 | `remote -- vectors standby` | `20261112T120900Z-remote-3f72`, `…120912Z-vectors-standby-c954` | failed before any write: a list-vectors cursor starting with `-h` made wrangler print its help (fixed in 5e06c41) |
| 12:18:10 | `remote -- vectors standby` again | `20261112T121810Z-remote-2249` | 6,818 upserted, 15 deleted; D1 and Vectorize agree (6,818 rows read) |

The standby's own verify covers runbook step 8's `remote -- verify`, so it wasn't run twice.
