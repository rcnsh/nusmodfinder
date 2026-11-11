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

## 2026-11-11: the page ship (5B–5E, 5C-api, 5G pre-ship; code-only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 06:23:10 | Live version check: one `/health` (`requests.tsv` 115): version `b9f7e0e4` (tag `f798542`) | 1 call | 1 call |
| 06:23:17–06:23:52 | `npm run deploy` of `fdec96f` (the guard read ~6.8k rows through its own dev session; no D1 write, no migration, data version unchanged `d820d578cf81`; static assets uploaded from `public/`) | ~6.8k rows read | version **`810c903b-60fd-4a24-b824-e33906a9007a`** (tag `fdec96f`) at 100% |
| 06:23:57–06:24:15 | Smoke, ≥ 4 s apart (`requests.tsv` 116): `/health` (tag `fdec96f`), `/` (the page, "unofficial" in the title), `machine learning` (20, EE2211 first, `hiddenPins` and `examDates` present), `/module/ACC1701XB` (`prereqCohortOnly: true`) | 4 calls | 4 × 200 |
| 06:24:25–06:30:59 | `node scripts/p5-live.mjs` (`requests.tsv` 117, `p5-live.jsonl`): `/health` traces the commit; axe every rule (but AAA contrast) on the first screen, an open detail and a hidden code, light and dark; SC2 on 20 stratified codes (seed 5); 3 hidden codes and 1 partial code; the 390×664 fold in Chromium and WebKit iPhone 13 | ~100 calls | 99 sent ≥ 4 s apart, all 200; **32 of 32 checks pass** |

Headroom: about 7k rows read and about 100 requests; the rule holds by orders of magnitude.

Rollback, if needed: `npx wrangler rollback b9f7e0e4-d4e9-4517-bc40-765c5c4773e8` (the 5A version).
Code-only, so D1 needs no restore.

## 2026-11-11: the semester representative (code-only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 07:54:04 | `/health` (`requests.tsv` 119): version `810c903b` (tag `fdec96f`) | 1 call | 1 call |
| 07:54:06–07:54:40 | `npm run deploy` of `c645e85` (guard read ~6.8k rows; no D1 write) | ~6.8k rows read | version **`91c09381-36d8-4bde-a34d-d18e08995a55`** (tag `c645e85`), startup 2 ms |
| 07:54:40–07:54:57 | Smoke (`requests.tsv` 120): `/health` (tag `c645e85`); `intro accounting` Sem 1, 2nd year: ACC1701XA first with XB and XC as variants; `machine learning`: EE2211 first | 3 calls | 3 × 200 |

Rollback: `npx wrangler rollback 810c903b-60fd-4a24-b824-e33906a9007a` (code-only).

## 2026-11-11: parsed phrases ship (code-only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 08:30:18 | `/health` (`requests.tsv` 121): version `91c09381` (tag `c645e85`) | 1 call | 1 call |
| 08:30:23–08:31:01 | `npm run deploy` of `75ca23c` (guard read ~6.8k rows; no D1 write) | ~6.8k rows read | version **`78a2672a-fc36-403a-b090-9ca266f905d4`** (tag `75ca23c`) at 100% |
| 08:31:07–08:31:26 | Smoke, ≥ 5 s apart (`requests.tsv` 121): `/health` (tag `75ca23c`); `history no final exam` reads `exam: 0` (HY3226 first); the same with `ignore=exam` reads none; `machine learning`: EE2211 first | 4 calls | 4 × 200 |

Rollback: `npx wrangler rollback 91c09381-36d8-4bde-a34d-d18e08995a55` (code-only).

## 2026-11-11: the red-team fixes (code-only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 09:43:41 | `/health` (`requests.tsv` 122): version `78a2672a` (tag `75ca23c`) | 1 call | 1 call |
| 09:43:47–09:44:27 | `npm run deploy` of `8a86bf6` (guard read 6,778 D1 rows; no D1 write) | ~6.8k rows read | version **`0b81c82e-4c45-47fe-9efc-a1b93afd71db`** (tag `8a86bf6`), startup 2 ms |
| 09:44:34–09:44:46 | Smoke, ≥ 5 s apart (`requests.tsv` 122): `/health` (tag `8a86bf6`); `HEAD /` (the CSP, `X-Frame-Options: DENY`, `nosniff`); `machine learning`: EE2211 first | 3 calls | 3 × 200 |
| 09:45:19–09:45:55 | Live re-check of R3, PD1, PD2, S1, S2 (`requests.tsv` 122): 5 page loads in Chromium, ≥ 6 s apart | ~120 calls (page files included) | 119 calls; every check as fixed (`redteam.md`) |
| 09:46:09–09:52:50 | `node scripts/p5-live.mjs` (`requests.tsv` 123, `p5-live.jsonl`) | ~100 calls | 100 sent ≥ 4 s apart; **32 of 32 checks pass** |

Rollback: `npx wrangler rollback 78a2672a-fc36-403a-b090-9ca266f905d4` (code-only).

## 2026-11-11: NUS Mod Finder on nusmodfinder.rcn.sh (ADR 0009)

| Time (UTC) | Step | Estimate | Actual |
|---|---|---|---|
| 12:34–12:37 | `npm run deploy` of `a7b90f4` | ~6.8k rows read | refused at the guard: `wrangler dev --remote` never answered (Cloudflare `code 10021`, "binding DB of type d1 failed to generate"); nothing uploaded. The config before this change failed the same way |
| 12:40 | `npx wrangler triggers deploy` | 0 rows | Custom Domain `nusmodfinder.rcn.sh` attached to the live version `0b81c82e`; workers.dev kept |
| 12:45–13:10 | `wrangler dev --remote` retried every ~2.5 min | 0 rows | `code 10021` on 8 tries, then answered |
| 13:11 | `npm run deploy` of `a7b90f4` (guard read 6,778 D1 rows; no D1 write) | ~6.8k rows read | version **`a6103634-25a3-45bd-8a79-fa15ef5be8dd`** (tag `a7b90f4`), startup 4 ms; triggers applied |
| 13:12–13:16 | `node scripts/p5-live.mjs` | ~100 calls | 25 of 32: 3 SC2 loads hit `ECONNRESET` from the dev Mac, 4 fold checks still wanted "unofficial, for NUS" (script fixed) |
| 13:26–13:33 | `node scripts/p5-live.mjs`, after the fix | ~100 calls | 99 sent ≥ 4 s apart; **32 of 32 checks pass** |

Both `https://nusmodfinder.rcn.sh` and the workers.dev URL answer `/health` with tag `a7b90f4`.

Rollback: `npx wrangler rollback 0b81c82e-4c45-47fe-9efc-a1b93afd71db` (code-only; the Custom Domain stays).
