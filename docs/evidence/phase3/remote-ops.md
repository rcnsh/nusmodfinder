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
