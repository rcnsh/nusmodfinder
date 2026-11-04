# Phase 3 plan: search that understands students (draft r1)

Goal (exit): **SC4** and **SC5** are met, and **SC7** (carried over from Phase 1) passes on a
re-measurement under the same pre-registered rule.
- SC4: search handles codes with spaces or partial codes (`cs 1010s`, `CS32`), GE pillars
  (`GEA`), typos (`machne learning`), level intent (`for beginners`) and no-exam / S/U / workload
  intents. Gibberish returns "no matches".
- SC5: on the held-out set, the shipped ranker beats the current one on nDCG@10 and P@5, with a
  paired bootstrap CI that excludes zero. ADR 0003 reads "held-out" as the sealed test set; that
  reading still needs Jacob's sign-off (§5).
- SC7: search p50 server time under 250 ms on a cache miss, from `Server-Timing` on the deployed
  Worker, with a keyword-only fallback.

Scope: S2–S8 and SC7. P1–P3 stay in Phases 4–5 and appear below only where they interact. This
plan changes no code. Every number marked *est.* is an estimate, not a measurement.

## 1. Facts gathered
- **Dev baseline** (`qrels-dev-v1`, primary answerable n = 78, judged@10 100%): v0 hybrid nDCG@10
  0.762, P@5 0.631; lexical only 0.648; vector only 0.723. No-answer: 0 of 15 come back empty.
- **Dev shape counts** (`eval/dev/queries.json`, 98 queries): topical 25, mapping 12, level 7,
  ge 6, typo 6, abbreviation 6, code-exact 5, code-space 3, code-partial 3, noanswer 5,
  constraint 5 (a feature-gap block, outside the primary metric). The SC4 shapes have 3–7 dev
  queries each, too few to show SC4 on their own. Hence the acceptance suite in §4.
- **Holdout**: 81 queries, 0 of 12 looks used (`eval/holdout-ledger.md`).
- **SC7 FAIL** (`docs/evidence/phase1/sc7.md`): pooled p50 351 ms. Warm p50 spans: `vector` 232,
  `embed` 88, `fts` 19, `hydrate` 13, `cache` 8. `embed`→`vector` runs alongside `fts`, so
  `total` ≈ cache + max(embed + vector, fts) + hydrate. With the APAC primary (ADR 0005), D1 is
  no longer the problem. Post-switch smoke calls from SIN logged fts 45–269 and hydrate 16–43,
  but also embed 260–414 and vector 245–254 (`requests.tsv` 72–73).
- **Fidelity** (`fidelity.md`, `fidelity-2.md`): the replica's lexical half is exact. The dense
  half differs on every query by 1–2 items in the top 10 (mean overlap@10 8.40, against a modelled
  8.47 or more). The two candidate causes are the ANN index and corpus vectors that differ from the
  eval's `emb-bge-small-v0`. Workers AI is not bit-deterministic across batches: the same text
  embedded in separate calls or batches has cosine 0.9797–0.9998 (`eval/README.md`).
- **Code** (`src/search.js`): RRF k = 60 with equal weights and a hash tiebreak (`fuse`). Depth is
  min(3 × topK, 50). The pin applies only when the whole query matches `MODULE_CODE_RE`. Vectorize
  is asked for ids only, so the cosine scores are thrown away. `src/fts-query.js`: quoted tokens
  joined by OR, with a 27-word stopword list. 0006 built prefix indexes `'2 3 4'` but kept `code`
  UNINDEXED, because indexing it would change bm25 lengths. `scripts/lib.mjs` `embeddingText`:
  title, department, faculty, description; no code, no level (`EMBEDDING_TEXT_VERSION = 1`).
  The ingest Worker embeds in batches of 50 (`src/ingest.js`). The query is embedded verbatim,
  with no bge instruction prefix.
- **Cloudflare limits** (docs, 2026-11-04): Worker size 64 MiB uncompressed (no compressed limit
  since 2026-09-04); startup 1 s; 128 MB per isolate; Paid CPU 30 s per request by default; static
  asset file and KV value 25 MiB each. Vectorize queried dims = (queried + stored vectors) × dims.

## 2. Workstreams

The order is fixed by dependency: 3-0 first, because every later dense change then reaches
production in a deploy instead of a re-ingest, and the replica and production then search the
same way. Each workstream lists its approach, what it touches, and how it is measured (dev screen
first, then a holdout look as planned in §3).

### 3-0 In-Worker exact vector search (SC7)
- **Approach.** Replace `env.VECTORIZE.query` in `denseSearch` with a brute-force dot product over
  L2-normalised corpus vectors held in the Worker. Apply the filter mask first, keep the top
  `depth` with a bounded selection, and order by score desc then code asc (deterministic ties).
  Cosine is the index metric (README: `--metric=cosine`), so on normalised vectors this is the same
  similarity. Return the scores internally; 3G needs them.
- **Storage form: float32 in a `Data` module** (ArrayBuffer, zero-copy `Float32Array`): 6,778 ×
  384 × 4 = 10.4 MB plus a ~10 B/row filter table (sem bits, level, credits, faculty id, NG and
  NG-semester bits), ~16% of 64 MiB and ~8% of 128 MB. **int8** (2.6 MB) is a ranking change
  needing its own gate, kept as the fallback if startup or memory measure badly. **Binary +
  rerank** still needs float32 rows to rerank, so at 6.8k rows it saves nothing.
- **Where the vectors live: bundled.** No I/O per request or per isolate, and the vectors are
  atomic with the code version: query prefix, embedding version and vectors deploy and roll back
  together. Static assets (a fetch per cold isolate), KV (cold read, ~60 s eventual consistency)
  and R2 (slower cold reads) each add a first-request penalty and a freshness question; they are
  fallbacks only if the bundle fails the startup check.
- **Cold isolate.** A Data module is not parsed as JS. Startup gate: `startup_time_ms` reported by
  `wrangler deploy` ≤ 200 ms (*est.* well under; limit 1 s), checked with `wrangler deploy
  --dry-run --outdir` before any deploy.
  - `Server-Timing` `total` starts at fetch entry, so isolate startup is invisible to SC7. The
    SC7 report therefore also gives client TTFB on sparse samples, so a slower cold start cannot
    hide behind the metric.
- **CPU per query.** 6,778 × 384 ≈ 2.6M multiply-adds: *est.* 3–6 ms of scalar JS (fewer rows
  with a filter). Measured first by a workerd microbenchmark in Vitest, then live from the
  `vector` span (the name is kept for comparability). Against the 30M CPU-ms included each month,
  5 ms a search is ~6M searches.
- **Vectors become a content-addressed artifact** (`scripts/vectors.mjs`, new). Keyed by
  `textHash`, which covers model, text version and text. They are built from the eval's corpus
  asset plus embeddings of any texts it lacks (`scripts/embed.mjs`, REST, logged in
  `neurons.tsv`). Each build is published as a release asset `vec-<dataVersion>-<embVersion>`
  and recorded in a committed manifest `data/vectors.json` (data version, embedding version,
  count, sha256).
  - For every text that production and the pinned eval corpus share, production gets the **same
    bits** as the replica. This removes "cause 2" of the fidelity gap by construction.
  - `npm run deploy` downloads the asset, checks its sha256, and refuses to deploy if the
    manifest's data version differs from `src/data-version.json`.
  - Nothing of 10 MB enters git.
- **Ingest stays in sync** through the existing runbook (ingest → commit data version → deploy),
  plus one step: build the vectors asset. `/admin/ingest` accepts precomputed `values` and upserts
  them into Vectorize instead of embedding in the Worker (so it stops calling `getByIds` for reuse,
  whose billing is undocumented). `npm run verify` adds: bundle codes and filter table equal D1's;
  a `getByIds` sample equals the bundle. Between an ingest and its deploy (minutes), stale bundle
  rows are dropped at hydrate, as stale Vectorize ids are today.
- **Vectorize stays, off the search path.** The brief forbids deleting or recreating the index,
  and keeping it costs nothing material: 2.6M stored dims of 10M.
  - Ingest keeps it identical to the bundle, so it is a cold standby: `DENSE_BACKEND=vectorize`,
    a var flipped by a deploy, restores today's path.
  - The fallback when the bundle is missing or corrupt, or Workers AI fails, stays keyword-only
    (B6), with `degraded.source` `dense-index` or `workers-ai`. SC7's Vectorize-failure case
    becomes moot and is reported that way.
  - Vectorize queried dims drop to ~0 per search. The binding limit moves to Workers AI (~0.03
    neurons per query → ~330k searches a day).
- **Eval fidelity.** The harness builds the same Data module from `emb-bge-small-vN` and the
  pinned corpus, so the replica runs the production code path; only `eval-v0` keeps the fake
  Vectorize, which is the same exact cosine. Proof without a look: `head` with the bundle and
  `head` with the fake Vectorize give identical run files on dev and the fixture, up to documented
  exact ties, so 3-0 **uses no holdout look**. In production it replaces ANN with exact search,
  moving production towards the replica. A third fidelity check needs a new pin first (production
  runs the 2026-11-04 catalogue, the eval the 2026-09-04 one).
- **Embed latency (~88 ms warm, 227 ms sparse) remains, with no cache in Phase 3.** SC7 is
  measured on distinct queries, so a query-embedding cache cannot move it. A Cache API entry keyed
  by (model, prefix version, canonical q) would help users who toggle filters on one q (each toggle
  is a response-cache miss); Phase 7 decides from real hit rates, which the log can count.
- **Expected latency** (*est.*):
  - Warm: cache 8 + max(embed 88 + vector ~5, fts 20) + hydrate 13 ≈ **115 ms**.
  - Sparse, with the APAC primary: cache 25 + embed 227 + 5 + hydrate ~40 ≈ **300 ms**.
  - Pooled p50 under the rule (≥ 30 warm + ≥ 10 sparse) is set by the warm samples: *est.*
    ~120 ms, against 250.
- **SC7 re-measurement**, with the rule unchanged (Phase 1 Final §2): pool every SIN-colo
  cache-miss sample, ≥ 30 distinct queries spaced ≥ 2 s apart plus ≥ 10 sparse samples ≥ 10 min
  apart. **Pass iff the point-estimate p50 of `total` < 250 ms.** Report the bootstrap CI and the
  warm and sparse p50s separately. If SIN can't be had, use the nearest APAC colo and say so.
  Method committed in `docs/evidence/phase3/sc7.md` before any sample; 45 fresh queries (none
  from the eval sets or earlier calls), `sc7-collect.mjs` with `wrangler tail` running,
  `sc7-analyse.mjs`, at most 45 calls. The VPN question goes to Jacob first (§7). Run once after
  3-0 ships and again at the freeze; only the frozen ranker's run counts for the exit.

### 3A Vector half setup (S3)
- **3A-1 query instruction prefix.** Prepend bge's retrieval instruction ("Represent this sentence
  for searching relevant passages: ") to the query text only. Corpus vectors are unchanged, so
  there is no re-embedding. It needs new query embeddings for dev, holdout and the SC4 suite (~200
  texts, *est.* < 10 neurons). It touches `src/search.js` (`denseSearch`) and the eval embedding
  caches.
- **3A-2 embedding text v2** (`EMBEDDING_TEXT_VERSION = 2`, `scripts/lib.mjs`,
  `eval/embeddings.json`): `CODE. Title. Level N (introductory / advanced / graduate).
  Description`, department and faculty moved after the description or dropped (dev decides). Up
  to 3 variants, each a pinned-corpus pass (`emb-bge-small-v1…v3`, ~2.4k neurons), ≤ 2 a UTC day.
- **Measured** as the dense-only run (`--mode vector`, pool variant) and as hybrid on dev, with
  one look each (L1, L2).
- **Re-embedding order of operations** (production never gets a text the eval has not passed):
  1. Branch: new `embeddingText`. Embed the pinned corpus offline into a new release asset. No
     production call.
  2. Dev screen; judge any new top-10 pairs; holdout look by the custodian. If it fails, stop
     here: production is untouched and the asset stays only as a record.
  3. Merge. Build the production vectors asset for the current catalogue, reusing the eval's
     vectors by `textHash` and embedding only the texts the pinned corpus lacks (*est.* ≤ 400
     texts, ≤ 300 neurons).
  4. Deploy. Query side and corpus vectors switch together, because both are in the bundle.
  5. Then an ingest with the asset's values (every `text_hash` changes; no Workers AI call, no
     FTS writes since title and description are unchanged) upserts them into Vectorize in place,
     with no parallel index. *est.* ~35k rows written (5.2 per module, Phase 1 small batch).
     Verify must come back clean.
- A 768-d model would fit Paid's 10M stored dims, but it doubles the bundle and adds embed time.
  Not planned.

### 3B Codes, GE pillars, keyword brittleness (S5, S4)
- **Code parser** (`src/query-intent.js`, new; pure, Node-testable) over the canonical q:
  - `([a-z]{1,4})\s?(\d{4}[a-z0-9]{0,5})` anywhere in the query → candidate exact codes
    (`cs 1010s` → CS1010S). Up to 3 that exist are pinned in query order, still subject to the
    filters.
  - A whole query that is code-shaped but names no module → `count: 0`,
    `noMatch: { reason: "unknown-code" }`. The eval scores non-existent codes as correct-empty.
- **Partial codes and GE pillars**:
  - Trigger: a single token of the form `[a-z]{2,4}\d{0,3}` whose letters are a known subject
    prefix. The prefix list is generated from the corpus into a committed data file.
  - Route: a PK range scan `code >= ? AND code < ?` (rows read ≈ rows returned), ordered by code,
    fused as a **third RRF list** rather than pinned, so `GEA` shows GEA modules and the dense
    half can still order them.
  - Letter-only tokens that are also English words (computed list, e.g. `art`, `law` if they
    collide) take the prefix route only when the query is that single token. SC4 guard queries
    pin this down.
  - GE pillar names → prefixes come from a small committed table sourced from the NUS GE page
    (URL in the file). Optional; dev decides.
- **Keyword brittleness**: add `modules`, `module`, `course(s)`, `class`, `teach`, `something`,
  `nus` to the stopwords. `intro`/`introductory` go to the 3D intent parser, not the stopword
  list. `code` stays UNINDEXED in FTS (0006 rationale); the routes above replace it.
- Touches `src/search.js` (`runSearch`), `src/fts-query.js`, `src/modules.js`.
- **Measured**: dev targets `code-space`, `code-partial`, `ge`, `abbreviation` (≥ 3 answerable),
  with the exact-code check. One look (L3).

### 3C Typos (S4)
- Hybrid already carries `machne learning` through the dense half (FINDINGS S4). The fix is to the
  lexical half: a token with 0 document frequency is corrected to the nearest vocabulary term
  (edit distance 1, or 2 for tokens of 8+ letters, ties to the higher df). The original token stays
  in the OR, so nothing is lost.
- The vocabulary (surface tokens by `queryTokens` with df, *est.* ~25k terms, ~300 KB) is built
  from the same corpus as the vectors bundle and ships beside it, versioned the same way.
- Variant 3C-2 also embeds the corrected text. It needs new query embeddings, capped at 500
  neurons per run.
- **Measured**: dev target `typo` (6). A dev-only diagnostic adds noise-model variants of clean dev
  queries, which inherit their source's qrels with unjudged pairs judged. It is reported and never
  gated. One look (L4).

### 3D Level intent and graduate flooding (S6)
- The intent parser detects level phrases (`for beginners`, `intro(ductory)`, `no background`,
  `first year`, `advanced`, `graduate`, `level 3000`, `3k`) and strips them from the lexical query
  only. The dense query stays raw. The parsed intent is echoed as `interpreted.level`.
- **Ranking**: a soft level prior applied after fusion: score × (1 − α·penalty(level, intent)).
  With no graduate intent, levels ≥ 5 get a default penalty β (S6: 46% of the corpus is level 5+).
  Grid: α, β ∈ {0, 0.1, 0.2, 0.35}, chosen on dev.
- P2 interaction: Phase 4 adds the study-level input and the hard rule for exchange mode. The prior
  stays soft and only orders what that rule allows.
- **Measured**: dev target `level` (7), plus overall dev Δ (the β prior touches every query).
  One look (L5).

### 3E RRF weighting (S2)
- Weighted RRF in `fuse()`: w_v/(k + r_v) + w_l/(k + r_l) (+ w_c for the 3B code list); the hash
  tiebreak becomes (best single-list rank, then dense rank, then code). Pre-declared grid w_v/w_l ∈
  {1, 1.25, 1.5, 2}, k ∈ {20, 60}, tuned **after** 3A and 3D, which shift the lists' relative
  quality. S2's cases (`intro to psych`, `learn korean`) join the SC4 guards. One look (L6).

### 3F Near-duplicate crowding (S8)
- Duplicate group = identical (normalised title, description), computed by ingest and carried in
  the filter table. After filters (so an unavailable member never stands in) and fusion, only a
  group's first member stays; the others ride along as `variants: [codes]` and the page fills with
  the next distinct results. The eval is group-aware already, so this only frees slots. A response
  shape change. One look (L7).

### 3G Gibberish and "no matches" (S8)
- Return `count: 0` with `noMatch: { reason: "no-signal" }` iff no code route fired, no query
  token is in the vocabulary after 3C correction, **and** the top exact dense cosine (from 3-0) is
  below τ. τ is chosen on dev under the pre-registered cutoff rule (`--change-kind cutoff`:
  correct-empty gain ≥ 0.25, answerable ΔnDCG@10 ≥ −0.01, ≥ 3 no-answer queries); the holdout
  governs. One look (L8).

### 3H No-exam, S/U and workload intents (S7)
- **Data.** Migration `0007_intents.sql` adds `exam_semesters` (JSON; semesters with an
  `examDate`), generated `exam_sem1..4`, `su` (from `attributes.su`), `grading_basis`, and
  `workload_hours` (sum of the workload array; NULL when unparseable).
  `normalise()` keeps them and `NORMALISER_VERSION` is bumped, so every `row_hash` changes: a
  row-only re-ingest (no re-embedding, no FTS writes, *est.* ~35–50k rows written) after the
  headroom check and a Time Travel bookmark (ADR 0004). Ranking-neutral, so it can land early.
- **Query side.** The intent parser maps phrases (`no exam(s)`, `no finals`, `without final`,
  `s/u`, `su-able`, `pass/fail`, `light/low workload`, `< N hours`) to the same constraints as new
  explicit params `exam=0`, `su=1`, `maxHours=N`.
  Hard filters in SQL and in the in-Worker filter table (no `examDate` in the selected semester,
  or in any offered one when none is set). The response echoes `interpreted` so the UI (Phase 5)
  can show and undo it. No `examDate` means "no final exam listed", not certified; the copy says so.
- **Measured**: these intents are mechanical, and judges never see exam, S/U or workload fields
  (`JUDGING.md`). So compliance is measured by the SC4 suite. The relevance eval only checks
  "no regression" on primary (dev constraint block reported). One look (L9).

## 3. Measurement and the holdout look plan
- **Dev is open.** Every candidate runs `npm run eval -- --variant <v> --baseline <shipped>`
  (with `--target-shapes` where declared) and must pass the dev screen before any look. Grids are
  declared in the PR before they are run.
- **New judging before every gated run**: `eval:pool --runs <shipped>,<cand> --unjudged`, round
  rN by judge A (`claude-opus-5-5`, single-judge protocol, ADR 0004) with a 5% drift sample, merge
  to a new qrels version. judged@10 must be 100% for both runs. Each verdict reports the Δ sign
  on the 150 calibration pairs (ADR 0004).
- **Holdout, custodian only.** Tuning agents never get the key and never decrypt; they see only
  the verdict lines. Per look the lead stores the candidate (`--holdout --store-only`, no look),
  pools it encrypted (`--custodian --unjudged`), judges with in-process subagents, merges, and
  only then runs the verdict, so no look is spent `unjudged`. The ledger is committed after each.
- **Look plan** (≤ 12; every look compares against the ranker shipped at the time):

  | look | candidate | rule |
  |---|---|---|
  | — | 3-0 exact search | identity on dev + fixture; no look |
  | L1 | 3A-1 query prefix | general |
  | L2 | 3A-2 best text variant (on top of L1's winner) | general |
  | L3 | 3B codes + GE + stopwords | general (targets declared on dev) |
  | L4 | 3C typo correction (best of 3C-1/3C-2 on dev) | general |
  | L5 | 3D level prior | general |
  | L6 | 3E fusion weights + tiebreak | general |
  | L7 | 3F duplicate collapse | general |
  | L8 | 3G no-match cutoff | cutoff |
  | L9 | 3H intents | general |
  | L10–L11 | reserve: one retry each for two failed changes, after dev rework | as original |
  | L12 | frozen ranker vs `eval-v0` (SC5 secondary report) | report only |

  A change that fails its look and gets no retry is dropped. If the reserve runs out, remaining
  changes are bundled into one look, never a 13th.

## 4. SC4 acceptance suite (pre-registered)
- **Written** by the lead before any 3B–3H code merges, from the SC4 wording, not from the dev or
  holdout sets (checked by exact canonical match). Committed as `test/sc4/queries.json`, with
  rules and thresholds fixed in the same commit. Implementers may not edit it; a change goes
  through the lead with the reason logged.
- **Runs** the real Worker over the full pinned corpus and the bundle in the `full-corpus` CI job.
  Query embeddings are committed (*est.* ~80 texts, < 5 neurons).
- **Rules**, ~5 queries per item:
  - space code (`cs 1010s`, `ma 1521`) → that code at rank 1;
  - partial code or pillar (`CS32`, `cs101`, `GEA`, `gec`) → count > 0 and ≥ 8 of the top 10
    carry the prefix;
  - typo → top-10 overlap with its clean form ≥ 7;
  - level intent → no level ≥ 5 in the top 10, and median level ≤ 2;
  - no-exam / S/U / workload → 100% of results satisfy the parsed constraint, and `interpreted`
    echoes it;
  - gibberish and non-existent codes → `count: 0`.
- **Guards**: 20 ordinary queries (including `art history`, `law and society`, `intro to psych`,
  `learn korean`) must return count > 0 and no `interpreted` they don't contain.
- **SC4 passes** iff the suite is fully green at the frozen ranker, and a live confirmation of
  ≤ 20 calls on the deployed Worker agrees on every rule it samples.

## 5. SC5 (decided once)
- **Order.**
  1. Freeze: tag `phase3-final` after the last accepted change.
  2. Jacob signs off on the SC5 reading (the sealed test set governs; the holdout is secondary)
     before the test set is written, so the reading isn't chosen after seeing results.
  3. The **lead (custodian) writes the test set**: fresh persona-writer subagents, using the
     pre-registered prompts, personas and shape procedure from ADR 0003, a new recorded seed, and
     code queries from a secret custody seed. Then the leak filter (cosine ≥ 0.9 or shared
     source) runs; keep writing until ≥ 160 answerable queries, at most 2 extra rounds.
  4. Pool v0 + final top-10, judge A in-process, then **one look**: BCa 95% lower bounds of
    ΔnDCG@10 and ΔP@5 both > 0, final vs `eval-v0` on the pinned corpus.
- **Labelling.** Results are labelled "offline replica". After 3-0, production's dense search is
  exact too, so the replica-vs-production caveat in ADR 0003 narrows to the corpus pin.

## 6. Cost and quota plan

Allowances (ADR 0004): D1 25B rows read and 50M written a month; Vectorize 50M queried dims a
month; Workers AI 10k neurons a day; live traffic ≤ 60 `/search` calls per agent per session.

| item | D1 read | D1 written | Vectorize queried dims | neurons | live `/search` |
|---|---|---|---|---|---|
| 3-0 deploys (≤ 8 in Phase 3) + smoke (≤ 4 each) | ~13k | 0 | 0 after 3-0 | ~1 | ≤ 32, ≤ 4 per session |
| SC7 runs (×2) | ~37k (406/search mean) | 0 | 0 | ~3 | 45 per run, one session each |
| 3A-1 query prefix, all sets | 0 | 0 | 0 | < 10 | 0 |
| 3A-2 text variants (≤ 3 eval passes) | 0 | 0 | 0 | ≤ 7.2k, ≤ 2 passes a day | 0 |
| 3A-2 production (delta + row-only ingest) | ~30k | ~35k *est.* | 0 (upserts; stored 2.6M of 10M) | ≤ 300 | ≤ 4 smoke |
| 3H migration 0007 + row-only ingest | ~30k | ~35–50k *est.* | 0 | 0 | ≤ 4 smoke |
| 3C-2 / rewrites (embed-missing cap) | 0 | 0 | 0 | ≤ 500 per run | 0 |
| verify after each ingest (×3) | ~20k | 0 | `getByIds` sample only | 0 | 0 |
| SC4 suite + live confirmation | ~8k | 0 | 0 | < 5 | ≤ 20 |
| **Phase 3 total** | **< 0.2M of 25B** | **< 0.15M of 50M** | **~2.6M (stored term) of 50M** | **≤ 5k on any one day** | **≤ 60 per agent session** |

The ingest and a corpus eval pass never run on the same UTC day. Every remote D1 write gets the
ADR 0004 headroom check (estimate × 1.5 fits the remaining allowance) and is logged in
`remote-ops.md`. Every neuron spend goes into `neurons.tsv`.

## 7. Risks
- **Bundle size and startup**: 10.4 MB could slow cold isolates outside `total`. The
  `startup_time_ms` gate, sparse TTFB, and int8 or a static asset as fallbacks.
- **Deploy-coupled freshness**: no deploy after an ingest leaves the dense half stale. Deploy
  refuses a mismatched manifest; verify and `/health` compare the bundle's data version.
- **Dev overfitting**: 98 queries, SC4 shapes of 3–7. Small grids declared up front; the holdout
  screens each change; the sealed set decides SC5.
- **Look exhaustion**: nine planned looks, two retries, one report; bundle rather than a 13th.
- **Intent parser false positives**: `art`/`law` read as prefixes; stripping "intro" hurts lexical
  recall. SC4 guard queries and the dev tripwire.
- **Exam data semantics**: a missing `examDate` is not a certified "no exam". UI copy plus the
  echoed interpretation.
- **Cutoff hides real long-tail answers**: the cutoff rule caps the answerable loss at 0.01, and
  three signals must all agree.
- **Single same-family judge** (ADR 0004) grades every new pair. The calibration covers v0-era
  pairs only. Mitigation: a drift sample each round.
- **Embed latency** (sparse 227 ms, post-switch 260–414 ms) is outside our control. The pooled
  rule leans on warm samples. If a re-measure fails, it fails, and the plan does not change the
  rule.
- **SC7 collection conditions.** Last time the VPN's exits gave 3 SIN sparse samples against
  ≥ 10 (6 sparse calls: NRT, NRT, SIN, SIN, SIN, MRS). Open question for Jacob: VPN off, or keep it on and accept the nearest-APAC-colo clause.
- **Response shape changes** (`variants`, `noMatch`, `interpreted`, new params) are public API
  changes: branch and PR, consumed by Phase 5.

## 8. Exit criteria
- SC7: the re-measurement at the frozen ranker passes the pre-registered rule, with evidence in
  `docs/evidence/phase3/sc7.md`, and the B6 fallback tests pass.
- SC4: the acceptance suite is green in CI at `phase3-final`, and the live confirmation agrees.
- SC5: one sealed-test look passes, under the reading Jacob signed.
- FINDINGS S2–S8 are `fixed` (or `rejected` with a reason); README's cost section names the new
  binding limit; ADR 0006 records the in-Worker dense search and Vectorize's standby role.

## 9. Objection log (round 1)
| # | Critic | Objection | Resolution |
|---|---|---|---|
