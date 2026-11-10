# Phase 5 remote operations log

Every remote operation, reads included, with its estimate and actual. Times are UTC. Headroom
rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance).

## 2026-11-10: design-gate mockup data

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 17:24–17:25 | 3 exchange `/search` (introductory accounting, `ng=1&study=ug2`; `sem=1`, none, `sem=2`) and 1 `/module/ACC1701XB`, ≥ 4.5 s apart, on version `efd3dc25` (`requests.tsv` 112) | 4 calls | 4 × 200 |

## 2026-11-10: 5A ship (migration 0010, row-only re-ingest, deploy, standby)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| — | PR #68 merged as `f798542`. Data version `62e5a0011231` → `d820d578cf81` (`exam_dates` is in the row hash); the rowsKey is unchanged (`7c9b739622d9`), so nothing was re-embedded: the production bundle reuses the vectors and differs from the live one only in 18 header bytes. Release assets `vec-pinned-7ab2cb3ac32d-emb-bge-small-v1` and `vec-production-d820d578cf81-emb-bge-small-v1-x4a990cd5` uploaded before the merge (GitHub, not Cloudflare) | 0 | production sha256 706b69a4…, pinned 82159ab1… |
| 18:14:17 | Live version check: one `/health` (`requests.tsv` 113): version `efd3dc25-e572-432c-b244-670a0aceff4e` (tag `9d91605`), data version `62e5a0011231` | 1 call | 1 call |
| 18:14:24 | D1 Time Travel bookmark `00000029-00000000-0000511f-e2be53438f2c7c6933226c4925f5dc4e` | 0 | recorded (rollback target) |
| 18:14:29–18:14:34 | Migration `0010_exam_dates.sql` (one additive column, `exam_dates TEXT NOT NULL DEFAULT '[]'`): `remote-migration.mjs 0010_exam_dates` (local estimate: 0 rows), then `wrangler d1 execute nusmods-apac --remote --file /tmp/vnm-remote-0010_exam_dates.sql` (the body plus its `d1_migrations` row) | ~0 rows | 28 rows read, 4 written |
| 18:14:41 | `wrangler dev --remote --port 8791` with a one-off `INGEST_SECRET` (`.dev.vars` backed up first and restored at 18:20:59; port 8791 free afterwards) | 0 | — |
| 18:14:56–18:15:06 | Step 4: `npm run ingest -- --d1-only --offline --write-budget 55000`: every row rewritten once (new row hash); no Workers AI or Vectorize call. (A first attempt at 18:14:51 stopped before any call: `INGEST_SECRET` was not exported) | ~34–38k rows written (budget 55,000) | 33,890 rows written (D1-reported; 37,279 charged with the FTS estimate), 6,778 read, 0 deleted; data version `d820d578cf81` = committed; facets: 1,167 on the NG list |
| 18:15:10–18:15:11 | `npm run verify -- --pre-deploy`: rowsKey and data version agree across D1, manifest and bundle; 0 field, row-hash or reason-id drift | ~6.8k rows read | 6,778 rows read; 0 drift |
| 18:15:14–18:15:46 | `npm run deploy` (the guard read ~6.8k rows; only `DENSE_BACKEND` among the vars) | ~6.8k rows read | version **`b9f7e0e4-d4e9-4517-bc40-765c5c4773e8`** (tag `f798542`) at 100% |
| 18:15:53–18:16:11 | Smoke, ≥ 4 s apart (all 200, not degraded; `requests.tsv` 114) | ≤ 4 calls | 4 calls |
| 18:16:15–18:20:55 | Step 8 standby: `vectors.mjs standby` upserted every code (bundle values, D1 metadata), 0 deletes, waited for the mutation, then verified: 6,778 vectors, 0 missing or extra, 0 row-hash drift, 100-sample metadata and value drift 0 | ~13.6k rows read, 6,778 upserts | 6,778 rows read by verify (plus the upsert pass), 6,778 upserted; 0 queried dims |

Headroom: about 38k rows written and about 35k read, against Paid's 50M writes and 25B reads
included a month. The rule (estimate × 1.5 < remaining) holds by orders of magnitude.

The smoke calls:
- `/health`: production bundle, 6,778 vectors, data version `d820d578cf81`, tag `f798542`;
- `/module/ACC1701XB`: `examDates` `[{sem: 2, date: "2027-04-27T09:00:00.000Z", durationMins: 120}]`,
  workload total 10 (2-1-0-4-3), `nusmodsUrl` set, `cache-control: public, max-age=300`;
- `machine learning`: 20 results, EE2211 first (unchanged);
- `introductory accounting`, `ng=1&sem=1&study=ug2`: 20 results, ACC1701XA ACC2706 ZB2101 MA1301
  FIN3702B CS1010 first, the order the mockup data call (17:24) got on the old version.

Rollback, if needed: `npx wrangler rollback efd3dc25-e572-432c-b244-670a0aceff4e`. The old version
reads none of the new column, so D1 needs no restore. To remove it, restore the bookmark above, a
logged remote write; roll the Worker back first.
