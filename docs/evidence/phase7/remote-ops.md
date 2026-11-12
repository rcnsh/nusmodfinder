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
