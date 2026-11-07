# Phase 3 remote operations log

Every remote operation, reads included (plan §6, B-10), with its estimate and actual. Times are
UTC. Headroom rule: ADR 0004 (`estimate × 1.5 <` the month's remaining included allowance).

## 2026-11-06: 3-0 cutover (runbook, README "Runbook")

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 07:56–07:57 | Step 3-0.0 burst: 3 `/health` probes + 12 `/search` on version `ee96bbd0` (`embed-latency.md`, `requests.tsv` 75) | ~2k D1 rows read, ~0.4 neurons | as estimated; no D1 writes |
| 10:15 | Embedded the 169 production texts missing from `emb-bge-small-v0` (`npm run eval:embed`, REST, 2 requests) | 53.5 neurons | 53.5 neurons (`neurons.tsv`); account today before: 0.1 neurons |
| 10:16 | Uploaded release asset `vec-production-c1cf88518972-emb-bge-small-v0-xd4228f1d` (GitHub, not Cloudflare); pinned asset `vec-pinned-…` was uploaded the same day for CI | — | sha256 ef62a3fa… |
| 10:26 | Headroom (GraphQL): account today 710,038 D1 rows read / 1,008 written over 9 databases; 0.1 neurons | — | — |
| 10:28:00 | Step 3: D1 Time Travel bookmark `00000006-00000000-0000511b-3c1184d938c3e31f6ccf8ab23d3de39b`; live version `ee96bbd0-add9-4aa6-8f2f-78e219087817` (tag `597c2b7`) | 0 | recorded (rollback targets) |
| — | Step 4 (D1-only ingest): skipped. `vectors.mjs data-version --offline` = `c1cf88518972` = committed `src/data-version.json`, so D1 already held these rows | 0 writes | 0 writes |
| 10:28:16 | Step 5: `npm run verify -- --pre-deploy` (via `wrangler dev --remote`) | ~6.8k rows read | 6,778 rows read; rowsKey, data version, fields and row hashes agree |
| 10:28:22–10:28:51 | Step 6: `npm run deploy` (guard on its own dev session reads ~6.8k rows; startup gate; `versions upload`; `versions deploy`) | ~6.8k rows read | version **`343ea371-1da0-46b2-9299-4d74770acf5a`** (tag `e8a7124`) at 100% |
| 10:29 | Step 7 smoke: `/health` (corpus `production`, 6,778 rows) + 2 `/search` (SIN, 200, 20 results, not degraded; server total 198 and 138 ms) | ≤ 4 calls | 3 calls (`requests.tsv` 76) |
| 10:29:50–10:33:39 | Step 8 standby: 6,778 upserts with full metadata in batches of ≤ 1,000, 0 deletes, waited for mutation `23f113a1…`; verify with 100-row metadata and value samples | ~6.8k + ~6.8k rows read, 0 written; 0 queried dims | `D1 and Vectorize agree`; 0 missing, 0 extra, 0 drift; 13,556 rows read |
| 10:34:15–10:34:39 | Post-3-0 burst: 4 `/health` probes (NRT, HKG, HKG, SIN) + 12 `/search` on `343ea371` (`3-0-cutover.md`, `requests.tsv` 77) | ~2k rows read, ~0.3 neurons | as estimated |

Rollback, if needed: `npx wrangler rollback ee96bbd0-add9-4aa6-8f2f-78e219087817` (no D1 change was
made, so no Time Travel restore is needed).

## 2026-11-07: 3A-2 v1 ship (runbook, README "Runbook")

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 07:04 | Step 1: embedded the 194 production texts missing from `emb-bge-small-v1` (`npm run eval:embed`, REST, 2 requests; `requests.tsv` 84) | ≤ 300 neurons | 63.4 neurons (`neurons.tsv`); account today before: 1,993.3 neurons |
| 07:03–07:10 | Uploaded release assets `vec-pinned-b21292ab3713-emb-bge-small-v1` and `vec-production-32b590de51aa-emb-bge-small-v1-x4a990cd5` (GitHub, not Cloudflare) | — | sha256 be683eaa… and 8157593f… |
| 07:33:01 | Step 2: PR #41 merged as `45bd716`. Nothing deployed: the guard refuses it until D1 holds the new text hashes | — | — |
| 07:33:25 | Step 3: D1 Time Travel bookmark `00000009-00000000-0000511c-8cd06d7c774355f3610e6bc05a5c8e6f`; live version `343ea371-1da0-46b2-9299-4d74770acf5a` (tag `e8a7124`) | 0 | recorded (rollback targets) |
| 07:34:03–07:34:12 | Step 4: `npm run ingest -- --d1-only --offline` (via `wrangler dev --remote`): every `text_hash` and `row_hash` rewritten; no Workers AI or Vectorize call | ~35k rows written, ~6.8k read | 34,425 rows written (D1-reported; 37,310 charged with the FTS estimate), 6,778 read, 0 deleted; data version `32b590de51aa` = committed |
| 07:34:15 | Step 5: `npm run verify -- --pre-deploy` | ~6.8k rows read | 6,778 rows read; rowsKey `7c9b739622d9`, data version, fields and row hashes agree |
| 07:34:21–07:34:51 | Step 6: `npm run deploy` (guard reads ~6.8k rows on its own dev session; startup 1 ms against the 200 ms gate; `versions upload`; `versions deploy`) | ~6.8k rows read | version **`8d1b85be-edd1-4e6c-902d-ea1ece96a0d1`** (tag `45bd716`) at 100% |
| 07:35:03 | Step 7 smoke: `/health` (corpus `production`, 6,778 rows, data version `32b590de51aa`) + 2 `/search` (SIN, 200, 20 results, not degraded; server total 152 and 505 ms, the second with a 417 ms embed) | ≤ 4 calls | 3 calls (`requests.tsv` 85) |
| 07:35:12–07:45:05 | Step 8 standby: three runs of `vectors.mjs standby`, each upserting every code. Run 1 upserted, then failed on `wrangler vectorize list-vectors` (`fetch failed`). Run 2 failed on the same call. Run 3 upserted 6,778 with full metadata in 7 batches, 0 deletes, waited for mutation `635cc30b…`, then its verify failed paging the ids (Vectorize 40052, "cursor appears to be corrupted") | ~13.6k rows read per run, 0 written; 0 queried dims | ~34k rows read over the three runs (est.), 0 written |
| 07:45:20–07:45:44 | `npm run verify` and `npm run verify -- --values` | ~13.6k rows read | `D1 and Vectorize agree`: 6,778 and 6,778, 0 missing, 0 extra, 0 drift; 100-row metadata and value samples with 0 drift; 13,556 rows read |

Headroom: about 34k rows written and about 67k read today, against Paid's 50M writes and 25B reads included a month. The headroom rule (estimate × 1.5 < remaining) holds by orders of magnitude, so the account figures were not queried.

Rollback, if needed:
1. `npx wrangler rollback 343ea371-1da0-46b2-9299-4d74770acf5a`.
2. Restore D1 to the step-3 bookmark: `npx wrangler d1 time-travel restore nusmods-apac --bookmark=00000009-00000000-0000511c-8cd06d7c774355f3610e6bc05a5c8e6f`, a logged remote write.
3. Revert `45bd716` on `main`.

The standby then holds v1 vectors under v0's ranker. Run step 8 again from the reverted bundle before any `DENSE_BACKEND=vectorize` flip.

## 2026-11-07: 3B ship (migration 0008, catalogue_only, deploy)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 09:27:33 | PR #44 merged as `ad8e10c`. Data version and bundle unchanged (`32b590de51aa`) | — | — |
| 09:27:48 | D1 Time Travel bookmark `0000000c-00000000-0000511c-4c9c1073ff34eeeec0038177c539e584`; live version `8d1b85be-edd1-4e6c-902d-ea1ece96a0d1` (tag `45bd716`) | 0 | recorded (rollback targets) |
| 09:28:03–09:28:08 | `wrangler d1 migrations list`, then `apply nusmods-apac --remote`: `0008_catalogue.sql` (the `catalogue_only` table, additive) | ~0 rows | applied, 2 commands |
| 09:28:21–09:28:52 | `npm run ingest -- --d1-only --offline` (via `wrangler dev --remote`): 14,430 catalogue-only rows loaded; modules unchanged; no Workers AI or Vectorize call | ~30k rows written | 28,860 rows written (D1-reported), 0 module rows; data version `32b590de51aa` = committed |
| 09:28:58 | `npm run verify -- --pre-deploy` | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 09:28:59–09:29:28 | `npm run deploy` (guard reads 6,778 rows; startup 2 ms against the 200 ms gate) | ~6.8k rows read | version **`8e743876-6361-4db6-91a4-8bf951d76e7f`** (tag `ad8e10c`) at 100% |
| 09:29:35 | Smoke (all SIN, 200, not degraded; `requests.tsv` 86) | ≤ 4 calls | 4 calls |
| — | Step 8 standby: not run. The vectors and the module rows are unchanged, so Vectorize still matches the bundle and D1 (verified at 07:45) | 0 | 0 |

The smoke calls:
- `/health`: production bundle, 6,778 rows;
- `cs 1010s`: pins CS1010S;
- `GEQ1000`: `count: 0`, `noMatch` `not-offered`, title "Asking Questions", 5 related;
- `CS32`, topK 50: 30 results, `interpreted.prefix` `CS32`.

Rollback, if needed: `npx wrangler rollback 8d1b85be-edd1-4e6c-902d-ea1ece96a0d1`. The old version ignores `catalogue_only`, so D1 needs no restore. To remove the table, restore the bookmark above, a logged remote write.

## 2026-11-07: 3C ship (deploy only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 12:28:52 | PR #47 merged as `89cb10e`. Data version and bundle unchanged (`32b590de51aa`); no migration | — | — |
| 12:29:16 | D1 Time Travel bookmark `0000000f-00000000-0000511c-a70a75105750458747b014a8ce0291eb`; live version `8e743876-6361-4db6-91a4-8bf951d76e7f` (tag `ad8e10c`) | 0 | recorded (rollback targets) |
| — | Step 4 ingest: not run. The data version is unchanged and 3C writes nothing to D1 (the vocabulary is a committed Worker module) | 0 | 0 |
| 12:29:34–12:29:35 | `npm run verify -- --pre-deploy` (via `wrangler dev --remote`) | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 12:29:41–12:30:06 | `npm run deploy` (the guard passed) | ~6.8k rows read | version **`c402a75d-d165-4c69-b7c1-4f5d1df24fb9`** (tag `89cb10e`) at 100% |
| 12:30:13 | Smoke (all SIN, 200, not degraded; `requests.tsv` 89) | ≤ 4 calls | 4 calls |
| — | Step 8 standby: not run. Vectors and module rows are unchanged | 0 | 0 |

The smoke calls:
- `/health`: production bundle, 6,778 vectors;
- `fiannce` (typo): 20 results, FIN2704 and FIN3719 in the top 3;
- `intro to psych` (prefix): PL1101E (Introduction to Psychology) first;
- `machine learning`: 20 results, EE2211 first.

Corrections are internal; the response's `interpreted` does not report them.

Rollback, if needed: `npx wrangler rollback 8e743876-6361-4db6-91a4-8bf951d76e7f`. D1 is unchanged, so it needs no restore.

## 2026-11-07: 3F ship (deploy only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 15:08 | PR #52 merged as `2ce17c6`. Data version and bundle unchanged (`32b590de51aa`); `data/groups.json` is a committed Worker module built for it; no migration | — | — |
| 15:09:26 | D1 Time Travel bookmark `00000010-00000000-0000511c-95d7aa8b7e56f2eb6185958a2c7f53cb`; live version `c402a75d-d165-4c69-b7c1-4f5d1df24fb9` (tag `89cb10e`), checked by one `/health` (`requests.tsv` 90) | 0 | recorded (rollback targets) |
| — | Step 4 ingest: not run. 3F writes nothing to D1 | 0 | 0 |
| 15:10:00–15:10:02 | `npm run verify -- --pre-deploy` (via `wrangler dev --remote`, one-off secret; `.dev.vars` restored after) | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 15:10:11–15:10:41 | `npm run deploy` (the guard passed) | ~6.8k rows read | version **`6e832483-b508-4a0b-bd4f-bb79709b44c8`** (tag `2ce17c6`) at 100% |
| 15:10:46 | Smoke (200, not degraded; 2 SIN, 1 NRT; `requests.tsv` 91) | ≤ 4 calls | 4 calls |
| — | Step 8 standby: not run. Vectors and module rows are unchanged | 0 | 0 |

The smoke calls:
- `/health`: production bundle, 6,778 vectors, tag `2ce17c6`;
- `start-up internship` (S8): TR3202N first, with TR3202I/S/T as variants (12 credits each);
- `cs 1010s` (pin): CS1010S first, with CS1010, A, E, HS, R and X as variants;
- `machine learning`: 20 results, EE2211 first.

Rollback, if needed: `npx wrangler rollback c402a75d-d165-4c69-b7c1-4f5d1df24fb9`. D1 is unchanged, so it needs no restore.

## 2026-11-07: 3G ship (deploy only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 15:50 | PR #54 merged as `47838db`. Data version and bundle unchanged (`32b590de51aa`); τ is a committed constant; no migration | — | — |
| 15:51:23 | D1 Time Travel bookmark `00000011-00000000-0000511c-a24bb9cb2d42bc9f7dd1e78d156d9d95`; live version `6e832483-b508-4a0b-bd4f-bb79709b44c8` (tag `2ce17c6`), checked by one `/health` (`requests.tsv` 92) | 0 | recorded (rollback targets) |
| — | Step 4 ingest: not run. 3G writes nothing to D1 | 0 | 0 |
| 15:51:38–15:51:40 | `npm run verify -- --pre-deploy` (via `wrangler dev --remote`, one-off secret; `.dev.vars` restored after) | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 15:51:44–15:52:15 | `npm run deploy` (the guard passed) | ~6.8k rows read | version **`f638992b-8039-4d06-abf2-b7838bb91fcf`** (tag `47838db`) at 100% |
| 15:52:20 | Smoke (200, not degraded; 2 SIN, 1 NRT; `requests.tsv` 93) | ≤ 4 calls | 4 calls |
| — | Step 8 standby: not run. Vectors and module rows are unchanged | 0 | 0 |

The smoke calls:
- `/health`: production bundle, 6,778 vectors, tag `47838db`;
- `xqzvbnm flurble` (S8): `count: 0`, `noMatch: { reason: "no-signal" }`;
- `microbbiology bacteia` (d-095, the near-τ typo the plan names): 20 results, LSM3232 first;
- `machine learning`: 20 results, EE2211 first.

Rollback, if needed: `npx wrangler rollback 6e832483-b508-4a0b-bd4f-bb79709b44c8`. D1 is unchanged, so it needs no restore.

## 2026-11-07: 3H-0 ship (migration 0007, row-only re-ingest, deploy, standby)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 16:36 | PR #56 merged as `f004351`. Data version `32b590de51aa` → `4b6d12fab3d3` (NORMALISER_VERSION 2); the rowsKey is unchanged, so nothing was re-embedded. Release assets `vec-pinned-e73693e41f41-emb-bge-small-v1` and `vec-production-4b6d12fab3d3-emb-bge-small-v1-x4a990cd5` uploaded at 16:21 (GitHub, not Cloudflare) | — | sha256 45b787fb… and b58a9281… |
| 16:37:46 | D1 Time Travel bookmark `00000012-00000000-0000511c-71aba81fe61493b7814816f0dbba73e6`; live version `f638992b-8039-4d06-abf2-b7838bb91fcf` (tag `47838db`), checked by one `/health` (`requests.tsv` 94) | 0 | recorded (rollback targets) |
| 16:37:57–16:37:59 | `wrangler d1 migrations apply nusmods-apac --remote`: `0007_intents.sql` (additive columns) | ~0 rows | applied, 11 commands |
| 16:40:11 | First ingest attempt: port 8787 was held by another project's local dev stub, so `wrangler dev --remote` never started and ingest stopped at `GET /admin/hashes` → 404, a local call that never reached Cloudflare | 0 | 0 rows read or written |
| 16:40:49–16:41:00 | Step 4: `npm run ingest -- --d1-only --offline` (via `wrangler dev --remote` on port 8789): every row rewritten once; no Workers AI or Vectorize call | ~35–50k rows written | 34,425 rows written (D1-reported; 37,310 charged with the FTS estimate), 6,778 read, 0 deleted; data version `4b6d12fab3d3` = committed |
| 16:41:04–16:41:06 | `npm run verify -- --pre-deploy` (field drift includes the 3H fields) | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 16:41:13–16:41:43 | `npm run deploy` (the guard read 6,778 rows) | ~6.8k rows read | version **`0173bddf-b636-4eb7-b07b-0cfeabf869d9`** (tag `f004351`) at 100% |
| 16:41:47–16:41:55 | Smoke (all SIN, 200, not degraded; `requests.tsv` 95) | ≤ 4 calls | 4 calls |
| 16:42:07–16:44:03 | Step 8 standby: `vectors.mjs standby` upserted every code (bundle values, D1 metadata), 0 deletes, waited for the mutation, then verified: 6,778 vectors, 0 missing or extra, 100-sample metadata and value drift 0 | ~13.6k rows read, 6,778 upserts | 6,778 rows read by verify (plus the upsert pass), 6,778 upserted (stored dims within Paid's 10M) |

Headroom: about 35k rows written and about 35k read today, against Paid's 50M writes and 25B reads included a month. The rule (estimate × 1.5 < remaining) holds by orders of magnitude.

The smoke calls:
- `/health`: production bundle, 6,778 vectors, data version `4b6d12fab3d3`, tag `f004351`;
- `machine learning`: 20 results, EE2211 first (unchanged);
- `cs 1010s`: CS1010S pinned first (unchanged);
- `xqzvbnm flurble`: `count: 0`, `noMatch` `no-signal` (unchanged).

Rollback, if needed: `npx wrangler rollback f638992b-8039-4d06-abf2-b7838bb91fcf`. The old version reads none of the new columns, so D1 needs no restore. To remove them, restore the bookmark above, a logged remote write.

## 2026-11-08: 3H params ship (deploy only)

| Time | Step | Estimate | Actual |
|---|---|---|---|
| 18:08 | PR #58 merged as `646e8e9`: the explicit `exam`/`su`/`hoursBelow`/`prereq` params; phrases in `q` are not read. Data version and bundle unchanged (`4b6d12fab3d3`); no migration | — | — |
| 18:08:10 | D1 Time Travel bookmark `00000014-00000000-0000511c-d8ef1f5f03bad95f275780bb2a8acf82`; live version `0173bddf-b636-4eb7-b07b-0cfeabf869d9` (tag `f004351`), checked by one `/health` (`requests.tsv` 98) | 0 | recorded (rollback targets) |
| — | Step 4 ingest: not run. 3H writes nothing to D1 | 0 | 0 |
| 18:08:32–18:08:34 | `npm run verify -- --pre-deploy` (via `wrangler dev --remote` on 8789, one-off secret; `.dev.vars` restored after) | ~6.8k rows read | 6,778 rows read; D1, manifest and bundle agree |
| 18:08:46 | First `npm run deploy`: refused. Another project's dev stub held the guard's fixed port 8799 and answered `/health`; `/admin/hashes` gave 404. Nothing uploaded. Fixed by PR #60 (`238e721`: a free port, a busy one refused) | 0 | 0 |
| 18:24:04–18:24:38 | `npm run deploy` (the guard read ~6.8k rows) | ~6.8k rows read | version **`ea066ead-8e61-4b1a-b019-2cb85cc6766f`** (tag `238e721`) at 100% |
| 18:24:44 | Smoke (all SIN, 200, not degraded; `requests.tsv` 99) | ≤ 4 calls | 4 calls |
| — | Step 8 standby: not run. Vectors and module rows are unchanged | 0 | 0 |

The smoke calls:
- `/health`: production bundle, 6,778 vectors, data version `4b6d12fab3d3`, tag `238e721`;
- `machine learning`: 20 results, EE2211 first (unchanged);
- `sociology&exam=0&su=1`: 20 results, SC2205 first, `filters: { exam: 0, su: 1 }`;
- `sociology no exam`: 20 results, `filters: {}`, `interpreted.exam: null` (phrases are not read).

Rollback, if needed: `npx wrangler rollback 0173bddf-b636-4eb7-b07b-0cfeabf869d9`. D1 is unchanged, so it needs no restore.
