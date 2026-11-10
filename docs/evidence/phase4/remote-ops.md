# Phase 4 remote operations log

Every remote operation, reads included, with its estimate and actual. Times are UTC. Headroom
rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance).

## 2026-11-10: 4A/4C/4D ship (migration 0009, row-only re-ingest, deploy, standby)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| — | PR #66 merged as `9d91605`. Data version `4b6d12fab3d3` → `62e5a0011231` (the two new columns are in the row hash); the rowsKey is unchanged, so nothing was re-embedded. Release assets `vec-pinned-97ccb42deebe-emb-bge-small-v1` and `vec-production-62e5a0011231-emb-bge-small-v1-x286f04a3` uploaded before the merge (GitHub, not Cloudflare) | — | production sha256 98dbef03… |
| 13:11:40 | Live version check: one `/health` (`requests.tsv` 106): version `ea066ead-8e61-4b1a-b019-2cb85cc6766f` (tag `238e721`), data version `4b6d12fab3d3` | 1 call | 1 call |
| 13:11:47 | D1 Time Travel bookmark `00000023-00000000-0000511f-6bd8e0d4b66c8e54b9df94403569086e` | 0 | recorded (rollback target) |
| 13:11:53–13:11:57 | Migration `0009_exchange.sql` (two additive columns, `ng_allow INTEGER NOT NULL DEFAULT 0` and `ng_rules TEXT`): `remote-migration.mjs 0009_exchange`, then `wrangler d1 execute nusmods-apac --remote --file /tmp/vnm-remote-0009_exchange.sql` (the body plus its `d1_migrations` row) | ~0 rows | 55 rows read, 5 written |
| — | `ship-oracle.mjs` (local): the 6,778 production-normalised modules × 15 combinations, ingest's `ng_allow` against the independent oracle | 0 | 101,670 cases, 0 differences |
| 13:12:17 | `wrangler dev --remote --port 8791` with a one-off `INGEST_SECRET` (`.dev.vars` backed up first and restored at 13:18) | 0 | — |
| 13:12:21–13:12:48 | Step 4: `npm run ingest -- --d1-only --offline --write-budget 51575`: every row rewritten once (new row hash); no Workers AI or Vectorize call | ~35–50k rows written (budget 51,575) | 34,425 rows written (D1-reported; 37,310 charged with the FTS estimate), 6,778 read, 0 deleted; data version `62e5a0011231` = committed; facets: 1,167 on the NG list |
| 13:12:51–13:12:55 | `npm run verify -- --pre-deploy`, with `ng_allow` in the field compare and every stored rule id known to the shipped reason texts | ~6.8k rows read | 6,778 rows read; 0 drift; 0 unknown reason ids |
| 13:12:58–13:13:26 | `npm run deploy` (the guard read ~6.8k rows; only `DENSE_BACKEND` among the vars) | ~6.8k rows read | version **`efd3dc25-e572-432c-b244-670a0aceff4e`** (tag `9d91605`) at 100% |
| 13:13:32 | Smoke (all 200, not degraded; `requests.tsv` 107) | ≤ 4 calls | 4 calls |
| 13:13:43–13:13:51 | `sc1-live.mjs`, first run: 30 exchange searches, two per (semester, year of study) | 30 calls | 23 answered 200 and showed no closed course. 7 (calls 22–27 and 30) got 429 from the Worker's own `SEARCH_LIMIT` limiter (20 per 10 s per IP), which answers before any search runs |
| 13:14:06–13:14:30 | `sc1-live.mjs`, second run: the 7 rate-limited calls re-sent 4 s apart (the script now spaces every call and re-sends a 429) | 7 calls | 7 × 200, no closed course. All 30 checked, 0 leaks (`requests.tsv` 108, `sc1-live.jsonl`) |
| 13:15:56–13:18:31 | Step 8 standby: `vectors.mjs standby` upserted every code (bundle values, D1 metadata), 0 deletes, waited for mutation `b4349f42…`, then verified: 6,778 vectors, 0 missing or extra, 0 row-hash drift, 100-sample metadata and value drift 0 | ~13.6k rows read, 6,778 upserts | 6,778 rows read by verify (plus the upsert pass), 6,778 upserted; 0 queried dims |

Headroom: about 37k rows written and about 35k read today, against Paid's 50M writes and 25B
reads included a month. The rule (estimate × 1.5 < remaining) holds by orders of magnitude.

The smoke calls:
- `/health`: production bundle, 6,778 vectors, data version `62e5a0011231`, tag `9d91605`;
- `machine learning`: 20 results, EE2211 first (unchanged);
- `ng=1&sem=1` without `study`: 400 `study-required`;
- `ng=1&sem=1&study=ug3`: 20 results, PF3211 first, carrying its note.

The SC1 live check: for each of the 15 (semester, year of study) combinations, two fresh queries
with `ng=1`; every shown code, variants included, checked against the oracle over the committed
production-normalised modules. 30 of 30 answered 200 with 0 closed courses shown.

Rollback, if needed: `npx wrangler rollback ea066ead-8e61-4b1a-b019-2cb85cc6766f`. The old version
reads none of the new columns, so D1 needs no restore. To remove them, restore the bookmark
above, a logged remote write.
