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
