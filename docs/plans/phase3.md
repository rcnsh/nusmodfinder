# Phase 3 plan: search that understands students (draft r3, final)

Goal (exit): **SC4** and **SC5** are met, and **SC7** (carried over from Phase 1) passes on a
re-measurement under the same pre-registered rule.
- SC4: search handles codes with spaces or partial codes (`cs 1010s`, `CS32`), GE pillars
  (`GEA`), typos (`machne learning`), level intent (`for beginners`) and no-exam / S/U / workload
  intents. Gibberish returns "no matches".
- SC5: on the held-out set, the shipped ranker beats the current one on nDCG@10 and P@5, with a
  paired bootstrap CI that excludes zero. Which set "held-out" means is Jacob's call, and he makes
  it before the first holdout look (§10, Q1).
- SC7: search p50 server time under 250 ms on a cache miss, from `Server-Timing` on the deployed
  Worker, with a keyword-only fallback.

Scope: S2–S8 and SC7. P1–P3 stay in Phases 4–5 and appear below only where they interact. This
plan changes no code. Every number marked *est.* is an estimate, not a measurement. Numbers
credited to a critic come from that critic's scripts on the pinned corpus. The step named beside
each one re-runs it and commits the script and its output before anything depends on it.

r3 applies every round-2 objection (§11) and the lead's round-2 dispositions. The structural
changes from r2:
- two preconditions run by the lead come first: P-0a (code-target rule grades, `qrels-v2`) and
  P-0b (gate and custody hardening). P-5b adds the gate code the plan's new rules need;
- 3H takes a holdout look outright. 3F takes none: it is gated like 3-0, by identity. The look
  count stays at 7 and the reserve is 5 (sealed) or 4 (holdout) for certain;
- the mapping pastes leave Phase 3: the 200-character limit rejects them;
- the 3-0 runbook splits verify in two, moves every Vectorize write to step 7, and reaches the
  admin routes only through `wrangler dev --remote`;
- the cache key uses the deploy's version id instead of hand-bumped versions, and the TTFB
  guard is gone;
- every bundle is pooled as its own run, w_c is fixed at 1, and each change SC4 needs has a
  pre-registered fallback;
- the code parser gets a fixed resolution order, a guarded spaced-code join and a pre-retrieval
  GE mask.

## 1. Facts gathered
- **Dev baseline: to be measured.** groups-v1 merged (PR #28, `87107a1`), so the eval is
  group-aware. The gating baseline is the **dev baseline under `qrels-dev-v2` and groups-v1, to
  be measured at P-4** (§3). r3 quotes no baseline number. The qrels-v1 figures and the
  groups-v1 table on `docs/phase2-baseline` are both superseded by P-0a.
- **Duplicate groups, groups-v1** (`eval/lib/groups.mjs`, `eval/groups.json`). Over the 6,771
  offered modules of the pinned corpus:
  - a *variant family* is codes with the same prefix letters and four digits that differ only in
    suffix letters, with the same normalised title;
  - a *cross-listing* is different codes with an identical normalised title and description,
    where the placeholder `Not Available` or an empty description never counts;
  - groups are transitive, and singletons are dropped.

  Result: 509 groups, 1,562 members, largest 38. TR3202I/N/S/T, CS1010/A/E/HS/R/S/X and
  MNO1706A–F/X are each one group. GEA1000 and GEA1000N are one group. MA2101 and MA2101S stay
  apart because their titles differ.
- **Dev shape counts** (`eval/dev/queries.json`, 98 queries): topical 25, mapping 12, level 7,
  ge 6, typo 6, abbreviation 6, code-exact 5, code-space 3, code-partial 3, noanswer 5,
  constraint 5 (a feature-gap block, outside the primary metric). Dev has no `code-nonexistent`
  query. The SC4 shapes have 3–7 dev queries each, too few to show SC4 on their own. Hence the
  acceptance suite in §4.
- **The 15 dev queries with no grade-≥1 document under `qrels-dev-v1`:**
  - 5 are tagged `noanswer`. Only d-012 and d-025 have no plausible answer.
  - 5 are answerable code queries that no pooled run retrieved: d-087 `cn 2109`, d-089
    `is 4246`, d-090 `MUL21`, d-091 `DAO17`, d-092 `GEC`. The Phase 2 exit red-team found them.
    P-0a grades their targets by rule from the corpus.
  - 4 are mapping pastes of 340–452 characters (d-005, d-017, d-032, d-042). `/search` rejects
    any query over `MAX_QUERY_CHARS` = 200 with a 400 (`src/search.js:25`, `:129–130`), and every
    eval mode goes through `/search` (`eval/runner/retrieval.eval.js:34`). No run can retrieve
    anything for them. Raising the limit is a public API change: Phase 4 work (P1), outside
    Phase 3. Every report gives their count outside both sets.
  - 1 is d-061 (`evo devo`).
- **Holdout**: 81 queries, 0 of 12 looks used (`eval/holdout-ledger.md`).
- **Gate code** (`eval/lib/gate.mjs`, `eval/cli.mjs`):
  - `gateFor` picks the rule from the set (`gate.mjs:224–228`). A holdout run always gets
    `holdoutGate`, which compares point estimates. `sc5Gate` runs only on the sealed test set.
  - `--change-kind` accepts only `general` or `cutoff` (`cli.mjs:68–72`). No kind expresses
    "answerable Δ ≥ −0.01" (3G) or "Δ ≥ 0" (3F, 3H's dev screen).
  - `answerable` is `!noAnswerByRule` and some grade ≥ 1 (`eval/lib/metrics.mjs:240`), so the
    no-answer set is "no relevant document found", not a tag.
- **SC7 FAIL** (`docs/evidence/phase1/sc7.md`): pooled p50 351 ms.
  - Warm SIN cache-miss spans (30 samples, `sc7-samples.jsonl`): p50 `vector` 232, `embed` 88,
    `fts` 19, `hydrate` 13, `cache` 8. `embed` p67 is 99.
  - `embed`→`vector` runs alongside `fts`, so `total` ≈ cache + max(embed + vector, fts) +
    hydrate.
  - With exact search in place of `vector` (~5 ms, *est.*), the per-sample projection
    cache + max(embed + 5, fts) + hydrate over those 30 samples has a p67 of **140 ms**
    (recomputed from `sc7-samples.jsonl`; critic B's figure). Summing the spans' separate p67s
    gives 128 and understates it.
  - With the APAC primary (ADR 0005), D1 is no longer the problem.
  - Only three searches are logged since the APAC switch (`docs/evidence/requests.tsv` rows
    72–74): two post-deploy smokes (embed 414 and 260 ms) and one after 12 minutes idle from MRS.
    None is a warm sample.
- **What sets the pooled p50.** With 30 warm and 10 sparse samples (n = 40), the median is the
  mean of the 20th and 21st smallest. If every sparse sample is slower than every warm one, those
  are the 20th and 21st of 30 warm samples, about the warm **p67**. With 33 warm + 12 sparse, the
  23rd of 33 warm is about p69. So the warm p67, not the warm p50, decides SC7.
- **Fidelity** (`fidelity.md`, `fidelity-2.md`): the replica's lexical half is exact. The dense
  half differs on every query by 1–2 items in the top 10 (mean overlap@10 8.40, against a modelled
  8.47 or more). The two candidate causes are the ANN index and corpus vectors that differ from the
  eval's `emb-bge-small-v0`. Workers AI is not bit-deterministic across batches: the same text
  embedded in separate calls or batches has cosine 0.9797–0.9998 (`eval/README.md`).
- **Code**:
  - `src/search.js`:
    - fusion: RRF k = 60 with equal weights and a hash tiebreak (`fuse`), at depth
      min(3 × topK, 50);
    - pin: only when the whole query matches `MODULE_CODE_RE`;
    - dense: Vectorize is asked for ids only, so its cosine scores are thrown away;
    - cache: the key holds `q` and `DATA_VERSION` only (`canonicalCacheKey`), with a TTL of
      3600 s, so a ranker-only deploy serves old rankings for up to an hour;
    - timing: workerd's clock advances only across I/O, so a CPU-only span such as an in-Worker
      dot product reads ~0.
  - `src/index.js:93` sets `x-app-version` on every response from `CF_VERSION_METADATA`
    (`src/http.js:30–33`: the version tag, else its id).
  - Admin routes (`src/index.js:43–48`): `/admin/hashes` already exists (`src/ingest.js:128`).
    Every admin route returns 404 unless `INGEST_SECRET` is bound (`src/ingest.js:29–34`).
    Production binds none, by design; ingest and verify run against `wrangler dev --remote` with a
    local secret (README, `scripts/verify.mjs`).
  - `/admin/delete` clears the D1 hashes, calls Vectorize `deleteByIds`, then deletes the D1 rows
    (`src/ingest.js:285–305`).
  - Verify compares each sampled Vectorize vector's metadata, `textHash` included, against D1
    (`src/ingest.js:385–394`, `scripts/verify-core.mjs:51`). A Vectorize upsert replaces the whole
    record, so an upsert of `{id, values}` alone wipes the filter metadata
    (`storedVectorMetadata`, `src/rowhash.js:53–77`).
  - Embedding keys differ: the eval keys a vector by sha256(model + "\n" + text)
    (`eval/lib/embeddings.mjs:33–35`), production's `textHash` is
    sha256(JSON [model, `EMBEDDING_TEXT_VERSION`, text]) (`scripts/lib.mjs:231`). The pinned
    corpus has 5,920 distinct texts for 6,771 codes (critic B).
  - The SC7 collector's `clientMs` includes reading the body (`sc7-collect.mjs:77–80`), so it is
    not time to first byte.
  - `src/fts-query.js`: quoted tokens joined by OR, with a 27-word stopword list. 0006 built
    prefix indexes `'2 3 4'` but kept `code` UNINDEXED, because indexing it would change bm25
    lengths.
  - `scripts/lib.mjs` `embeddingText`: title, department, faculty, description; no code, no level
    (`EMBEDDING_TEXT_VERSION = 1`). The ingest Worker embeds in batches of 50. The query is
    embedded verbatim, with no bge instruction prefix. A changed `text_hash` changes `row_hash`,
    which changes the data version.
- **Corpus facts for 3B–3H** (critic C, pinned corpus; re-run and committed by step 3B-0 or
  3H-0):
  - Prefixes:
    - ART and LAW are not prefixes. Real collisions with words or abbreviations: AI 9 modules,
      IT 18, PR 79, JS 24, GE 62, MA 110, EE 123, CE 144, LL 386. IS, ME and AN are prefixes too.
    - GEA has 2 offered modules (one group), CS101 7 (one group), DAO17 2, MUL21 4. CS32 has 30.
    - `comp`, `math`, `econ` are not NUS prefixes.
    - 36 offered codes have the shape `XX N000` (GEA1000, GEA1000N, GEI1000, GEN2000, GESS1000,
      GEX1000, ES1000, ME3000, IS6000, BI3000, …), and 50 more are catalogue-only (GEQ1000).
    - "Every prefix that is a df > 0 token" would cover 93 of 304 prefixes, CS, GEN, GET and GEX
      among them.
  - GE inside longer queries: the pillar members left in r2's fused top 10 are d-078 2 (of 69
    eligible), d-079 5 (of 48), d-062 9, d-022 10.
  - Catalogue: 14,359 catalogue codes are not offered this year (e.g. GEQ1000, GEH1001, IS1103).
  - Prerequisites: 4,180 of 6,771 offered modules have no prerequisite field. All 5 relevant
    modules of d-011 (`intro accounting no prerequisites`) have one, several only a cohort
    restriction (ACC1701XA, ACC1701XC, ACC2706, FIN2704X, QF1100). `prerequisite IS NULL` loses
    3 of d-023's 17.
  - Workload: 259 modules have an all-zero workload array. 4,614 of 5,081 4-MC modules list 10
    h a week.
  - S/U and grading: `attributes.su` is set on 933 modules (levels 1–4). 648 are graded CS/CU
    (1 of them also `su`). `grsu` is set on 410 (levels 5–6).
  - Exams: 35 modules have an `examDate` in some offered semesters and not others.
  - Words: "final" has df 171 (Final Year Project).
  - Groups and credits: of the exact title+description groups, 37 mix credits (AR4421 8 MC,
    AR4421A 12 MC). 270 same-title groups have different descriptions.
  - 9 of the 98 dev queries carry a 3H phrase.
- **Cloudflare limits** (docs, 2026-11-04):
  - Worker size 64 MiB uncompressed (no compressed limit since 2026-09-04);
  - startup 1 s; 128 MB per isolate;
  - Paid CPU 30 s per request by default, 30M CPU-ms included a month;
  - static asset file and KV value 25 MiB each;
  - Vectorize queried dims = (queried + stored vectors) × dims.

## 2. Workstreams

The order is fixed by dependency:
1. The preconditions (§3, P-0a to P-7).
2. 3-0. Every later dense change then reaches production in a deploy instead of a re-ingest, and
   the replica and production search the same way.
3. 3A-1, then 3A-2.
4. 3B, then 3C, 3D, 3E and 3F.

3H's data migration is ranking-neutral and can land early; its query side follows 3D, whose
parser it shares. 3G comes after 3C (it reads the vocabulary) and 3-0 (it reads exact cosines).
Each workstream lists its approach, what it touches, and how it is measured: dev screen first,
then the holdout step planned in §3.

### 3-0 In-Worker exact vector search (SC7)
- **3-0.0 Embed-latency check (B-6, B2-3), before any 3-0 code.**
  - Inputs: Phase 1's 30 warm SIN spans, and one logged warm burst of at most 12 fresh queries
    (none from the eval sets, SC4 or earlier calls) on the current deployment, spaced ≥ 2 s
    apart. The burst's collector records time to response headers as well as `clientMs`, so it
    is also the pre-3-0 TTFB baseline. Non-SIN samples are reported and left out.
  - Projection, per sample: cache + max(embed + 5, fts, pin) + hydrate, then the p67 over the
    samples. Phase 1's set gives 140 ms; the burst gives the post-APAC figure.
  - If the burst's projected p67 is above ~200 ms, building 3-0 waits for Jacob (§10, Q3).
  - The step writes the samples and both projections to `docs/evidence/phase3/embed-latency.md`.
- **Approach.** Replace `env.VECTORIZE.query` in `denseSearch` with a brute-force dot product over
  L2-normalised corpus vectors held in the Worker.
  - Apply the filter mask first, keep the top `depth` with a bounded selection, and order by score
    desc then code asc, so ties are deterministic.
  - Cosine is the index metric (README: `--metric=cosine`), so on normalised vectors this is the
    same similarity.
  - Return the scores internally: 3B's masks and 3G need them.
- **Storage form: float32 in a `Data` module** (ArrayBuffer, zero-copy `Float32Array`).
  - Size: 6,778 × 384 × 4 = 10.4 MB, plus a ~12 B/row (*est.*) filter table: sem bits, level,
    credits, faculty id, NG and NG-semester bits, prefix id, group id (3F), and the 3H bits (exam
    semesters, S/U source, workload, both prereq semantics). That is ~16% of 64 MiB and ~8% of
    128 MB.
  - **int8** (2.6 MB) changes the ranking, so it needs its own gate. It is the fallback if
    startup or memory measure badly.
  - **Binary + rerank** still needs float32 rows to rerank, so at 6.8k rows it saves nothing.
- **Where the vectors live: bundled.**
  - No I/O per request or per isolate.
  - The vectors are atomic with the code version: the query prefix, embedding version and vectors
    deploy and roll back together.
  - Static assets (a fetch per cold isolate), KV (cold read, ~60 s eventual consistency) and R2
    (slower cold reads) each add a first-request penalty and a freshness question. They are
    fallbacks only if the bundle fails the startup gate.
- **Two bundles, one builder** (`scripts/vectors.mjs`, new; B-9, B2-4, B2-5).
  - For each code the builder recomputes `embeddingText`, looks the vector up in the eval's
    corpus asset by `embeddingKey(model, text)`, and copies a shared text's vector to every code
    that has it. It embeds any text the asset lacks (`scripts/embed.mjs`, REST, logged in
    `neurons.tsv`), and refuses a row with no `textHash` (A-N6).
  - It asserts that the row count equals its corpus: 6,771 for the **pinned** bundle, D1's count
    (6,778 today) for the **production** bundle.
  - Each bundle is a release asset `vec-<corpus>-<dataVersion>-<embVersion>`, recorded in the
    committed manifest `data/vectors.json`: data version, embedding version, count, the asset's
    sha256 and **`rowsKey`**, the sha256 of the sorted (code, `textHash`) pairs (B-2).
  - The import goes through a wrangler `alias` that defaults to a committed fixture module,
    `test/fixtures/vectors.bin`: the ~400 fixture modules' vectors from the fake embedder,
    400 × 384 × 4 ≈ 0.6 MB. A fresh checkout, `npm test` and the `check` job build against it.
  - The `full-corpus` CI job and the SC4 suite use the **pinned** bundle, so they search the
    same catalogue as the eval. Only a deploy uses the production bundle. `npm run deploy`
    refuses the fixture and the pinned bundle.
  - For every text that production and the pinned eval corpus share, production gets the **same
    bits** as the replica. This removes "cause 2" of the fidelity gap by construction. Nothing of
    10 MB enters git.
- **Startup gate (B-4).**
  1. `wrangler check startup` runs locally as a pre-check.
  2. `wrangler versions upload` creates the version. The script parses its reported
     `startup_time_ms` and refuses if it exceeds 200 ms (*est.* well under; the limit is 1 s).
  3. Only then does `wrangler versions deploy <id>@100%` promote it.

  `Server-Timing` `total` starts at fetch entry, so isolate startup is invisible to SC7. The
  startup gate is the control for it. The SC7 report also gives true TTFB − `total`, warm and
  sparse, beside the 3-0.0 baseline (B2-7). It has no pass threshold.
- **CPU per query (B-5, B2-8).**
  - Work: 6,778 × 384 ≈ 2.6M multiply-adds, *est.* 3–6 ms of scalar JS (fewer rows with a
    filter).
  - The `vector` span reads ~0, because the workerd clock does not advance during CPU work. It
    is kept for comparability but is not evidence.
  - Measurement: a workerd microbenchmark in Vitest measures it cold (first call in an isolate)
    and warm. Live, the 3-0 smoke reads each request's mean `CPUTimeMs` from Workers Logs. That
    figure covers the whole request (fts, JSON, hydrate), not only the dot product.
  - Allowance: at 5 ms a search, 30M CPU-ms a month covers 6.0M searches. Workers AI at
    ~0.05 neurons a search (3A-1) covers 10k × 30 / 0.05 = 6.0M. The two estimates tie, so the
    measured CPU decides. The README cost section names whichever is smaller.
- **Deploy guard (B-2, B2-2).**
  - `npm run deploy` downloads the production asset and checks its sha256.
  - It compares `rowsKey` with D1's current (code, `text_hash`) pairs, read from the existing
    `/admin/hashes` route (~6.8k rows read, logged). The deploy script reaches it through a
    local `wrangler dev --remote` session with a local secret. No production secret is ever
    bound, so the deployed Worker's admin routes stay 404.
  - It also requires the manifest's data version to equal `src/data-version.json`.
  - Any mismatch refuses the deploy.
  - Because `text_hash` → `row_hash` → data version, D1 must hold the new text hashes before the
    Worker that bundles their vectors deploys. Hence the order below.
- **Ingest and re-embed runbook (B-2, B-3, B-8, B-10, B2-1, B2-2, B2-10).** One order for every
  corpus change: a catalogue update, 3A-2's re-embedding, or 3H's row change. Every admin call
  goes through `wrangler dev --remote`.
  1. Build the production vectors asset (reuse by key, embed only missing texts). Publish it and
     write the manifest on a branch.
  2. Record a D1 Time Travel bookmark in `remote-ops.md`.
  3. Write D1 only. `/admin/ingest` writes text and row hashes, new rows and fields, with no
     Workers AI call and no Vectorize write: the vectors come from the asset in step 7.
     `/admin/delete` takes a
     D1-only mode: it deletes the rows and records their codes for step 7, with no
     `deleteByIds`.
  4. `npm run verify -- --pre-deploy`: D1's (code, `text_hash`) pairs equal the manifest's
     `rowsKey`, and the bundle's codes and filter table equal D1's fields. It reads no Vectorize.
  5. Commit the data version and manifest. Then the deploy guard, `versions upload`, the startup
     gate and `versions deploy`.
  6. Smoke (≤ 4 calls). If it fails, roll back (below) and stop.
  7. Bring the Vectorize standby level. `/admin/vectors` (new) upserts
     `{id, values, metadata: storedVectorMetadata(row)}` for every code whose `text_hash` **or**
     stored metadata changed, row-only changes included (B2-10). The metadata comes from the D1
     row, with the new `textHash`. The values come in the POST body, read by the script from the
     sha-checked asset, never from the dev session's bundle, which is the fixture by default.
     Then `deleteByIds` for step 3's deletions. Then `npm run verify` (today's check, Vectorize
     metadata against D1) and a `getByIds` sample against the asset's bits.
  - Every remote D1 operation is estimated and logged in `remote-ops.md`, **reads included**
    (B-10).
  - Between steps 3 and 5 (minutes), the live Worker runs its old bundle against the new D1. Old
    vectors can still return a code that changed. So after hydrate, `localMatchesFilters`,
    extended with the 3H fields, runs on every dense row against the fresh D1 row and drops
    rows that fail (B-3). A test covers this. Rows missing from D1 are dropped at hydrate, as
    stale Vectorize ids are today.
- **Vectorize stays, off the search path, as an identical cold standby (B-1).**
  - Cutover: ingest skips unchanged rows, and today's production vectors came from ingest batches
    of 50 that differ from the bundle. So at the 3-0 cutover, step 7 upserts all 6,778 bundle
    vectors with their full metadata: 0 D1 writes, 0 neurons, stored dims unchanged at ~2.6M of
    10M.
  - From then on, runbook step 7 keeps the standby equal to the bundle.
  - The flip: `DENSE_BACKEND=vectorize`, a var flipped by a deploy, restores today's path.
    Between steps 5 and 7 the standby holds the previous vectors, so the flip is not used in that
    window.
  - The brief forbids deleting or recreating the index. Keeping it costs nothing material.
  - When the bundle is missing or corrupt, or Workers AI fails, the fallback stays keyword-only
    (B6), with `degraded.source` `dense-index` or `workers-ai`. SC7's Vectorize-failure case
    becomes moot and is reported that way.
  - Vectorize queried dims drop to ~0 per search.
- **Response cache key (B-7, A-N5, B2-6).** `canonicalCacheKey` adds `v=<CF_VERSION_METADATA.id>`.
  Every deploy gets a new version id, whether it changes the ranker, the vectors or
  `DENSE_BACKEND`, so no hand-bumped constant can be forgotten. SC7 collection rejects any sample
  whose `x-app-version` differs from the frozen deploy's.
- **Rollback (B-8).**
  - Every deploy's version id goes into `remote-ops.md`.
  - Rollback is `wrangler rollback <id>` to the previous recorded version. The floor is the
    version built from `597c2b7`: older versions are bound to the deleted WEUR database
    (ADR 0005).
  - If D1 changed in runbook step 3, restore it to the step-2 bookmark (a logged remote D1
    operation). Vectorize needs nothing: step 7 has not run, and step 3 no longer touches it.
- **Eval fidelity (A-N6).**
  - The harness builds the pinned Data module from `emb-bge-small-vN`, so the replica runs the
    production code path. Only `eval-v0` keeps the fake Vectorize, which is the same exact cosine
    with an id tiebreak (`test/fakes.js:209–210`).
  - Proof without a look: `head` with the bundle and `head` with the fake Vectorize give the same
    **result lists** on dev and the fixture. The run files' `treeHash` differs by construction,
    so the comparison is on results. Adjacent items whose float32 scores differ by less than 1e-6
    may swap; every such swap is listed.
  - So 3-0 **uses no holdout look**.
  - In production it replaces ANN with exact search, moving production towards the replica. A
    third fidelity check needs a new pin first: production runs the 2026-11-04 catalogue, the
    eval the 2026-09-04 one.
- **Embed latency remains, with no query-embedding cache in Phase 3.** SC7 is measured on
  distinct queries, so such a cache cannot move it. Phase 7 decides on one from real hit rates,
  which the log can count.
- **Neurons (B-11).** The 3A-1 prefix adds tokens: *est.* ~0.05 neurons a query, so the 10k/day
  Workers AI allowance covers ~200k searches a day. 3C-2's second embed doubles that.
- **Expected latency** (*est.*). The warm p67 sets the pooled p50 (§1). Phase 1's spans project
  to 140 ms warm; 3-0.0 adds the post-APAC figure. Sparse, with the APAC primary: cache 25 +
  embed 227 + 5 + hydrate ~40 ≈ 300 ms.
- **SC7 re-measurement (A-N7).** The rule is unchanged (Phase 1 Final §2): pool every SIN-colo
  cache-miss sample, ≥ 30 distinct queries spaced ≥ 2 s apart plus ≥ 10 sparse samples ≥ 10 min
  apart. **Pass iff the point-estimate p50 of `total` < 250 ms.** The report gives the bootstrap
  CI and the warm and sparse p50s separately. If SIN can't be had, use the nearest APAC colo and
  say so.
  - **One counted run, at the freeze.** After 3-0 ships, latency is read from the deploy's smoke
    calls and Workers Logs only. That is not an SC7 run.
  - **Re-run conditions, declared before the run:** a single re-run, with 45 new fresh queries
    and the same rule, only if the counted run ends with fewer than 30 warm or 10 sparse SIN
    samples because of colo assignment. No other reason allows a re-run.
  - The method is committed in `docs/evidence/phase3/sc7.md` before any sample.
  - Calls: 45 fresh queries, `sc7-collect.mjs` (recording time to headers too) with
    `wrangler tail` running, then `sc7-analyse.mjs`. At most 45 calls per run.
  - VPN: §10, Q2.

### 3A Vector half setup (S3)
- **3A-1 query instruction prefix.** Prepend bge's retrieval instruction ("Represent this sentence
  for searching relevant passages: ") to the query text only. Corpus vectors are unchanged.
  - New query embeddings are needed for dev, holdout, the SC4 suite and the gibberish set: ~300
    texts, *est.* < 15 neurons.
  - It touches `src/search.js` (`denseSearch`) and the eval embedding caches.
  - In production it is a code deploy, because the corpus vectors do not change.
- **3A-2 embedding text v2** (`EMBEDDING_TEXT_VERSION = 2`, `scripts/lib.mjs`,
  `eval/embeddings.json`). Three pre-registered variants (A-N3), each a pinned-corpus pass
  (`emb-bge-small-v1…v3`, ~2.4k neurons each), at most 2 passes a UTC day:
  - v1: `CODE. Title. Level N (introductory|intermediate|advanced|graduate). Description.
    Department. Faculty.`
  - v2: `CODE. Title. Level N (…). Description.` (department and faculty dropped)
  - v3: `Title. Level N (…). Description. Department. Faculty.` (no code)
  - The level labels: 1 introductory, 2–3 intermediate, 4 advanced, 5–6 graduate.
- **Measured** on dev as the dense-only run (`--mode vector`) and as hybrid. All three variants'
  top-10s are pooled in one round before one is selected (§3). One look each: L1 for 3A-1, L2 for
  3A-2's selected variant on top of L1's result.
- **Re-embedding order** (production never gets a text the eval has not passed):
  1. Branch: new `embeddingText`. Embed the pinned corpus offline into a new release asset. No
     production call.
  2. Dev screen, with judging and the cross-family grade (§3). Then the holdout look by the
     custodian. If it fails, stop here: production is untouched, and the asset stays only as a
     record.
  3. Merge. Then the runbook above, steps 1–7. Step 1 reuses the eval's vectors by key and
     embeds only the texts the pinned corpus lacks (*est.* ≤ 400 texts, ≤ 300 neurons). Step 3
     rewrites every `text_hash`: no Workers AI call, and no FTS writes, since title and
     description are unchanged. *est.* ~35k rows written (5.2 per module, Phase 1 small batch).
     Step 7 upserts the new vectors in place, with no parallel index.
- A 768-d model would fit Paid's 10M stored dims, but it doubles the bundle and adds embed time.
  Not planned.

### 3B Codes, GE pillars, keyword brittleness (S5, S4)
- **3B-0 corpus data**, committed with the script that builds it:
  - the prefix list: letter parts of offered codes, with counts;
  - the **collision list** (C-2, C2-7): a committed list of English words and common
    abbreviations that are also prefixes, starting from AI, IT, PR, JS, GE, MA, EE, CE, LL, IS,
    ME, AN. It is a written list, not "every prefix with df > 0". Pillar prefixes are exempt, so
    a bare `GEX` routes to its pillar;
  - the catalogue-only code list (C-7);
  - the GE pillar table: pillar names → {GEA, GEC, GEH, GEI, GEN, GEQ, GES, GESS, GET, GEX},
    with the NUS GE page URL in the file.

  The step re-runs critic C's counts and commits them as evidence.
- **Canonicalisation (C-14, C2-2)** before any matching, on the canonical q:
  - letters + space + 4 digits joins when the letters are a known prefix (`cs 1010s` →
    `cs1010s`; `is 4246` still pins);
  - letters + space + 1–3 digits joins only when the letters are a known prefix **and** are not
    on the collision list or the stopword list (`cs 32` → `cs32`, `cs 101` → `cs101`). So
    `give me 2 easy electives` never becomes `me2`, and `how many units is 3 US credits` never
    becomes `is3`. Critic B's arithmetic shows why the guard matters: at w_c = 2, k = 20, a code
    list's rank 1 scores 2/21, the same as rank 1 in both other lists;
  - code + space + 1–2 suffix letters joins (`cs1010 s` → `cs1010s`).
- **Code parser** (`src/query-intent.js`, new; pure, Node-testable):
  - Only a **known corpus prefix** makes a token code-shaped (C-7). `comp 1010`, `math 1001` and
    `econ 1101` are topical queries.
  - **Resolution order for a code-shaped token (C2-1)**, first match wins:
    1. it names an offered module → pinned, in query order, up to 3, still subject to the
       filters (`GEA1000`, `ES1000`);
    2. it names a catalogue-only code → as a whole query, `count: 0`, `results: []`,
       `noMatch: { reason: "not-offered", code, title, related: [codes] }` (`GEQ1000`).
       `related` holds the top 5 dense neighbours of the catalogue text (title + description),
       embedded at request time. The text comes from a new D1 table `catalogue_only` (migration
       `0008_catalogue.sql`, loaded by ingest). Neighbours ride in `noMatch`, never in
       `results`, so the eval scores the response as empty;
    3. it has the shape `XX N000` → a level intent (3D) (`cs 3000`, `lvl 3000`); when `XX` is a
       known prefix, the prefix route also applies;
    4. otherwise, as a whole query → `count: 0`, `noMatch: { reason: "unknown-code" }`. The eval
       scores non-existent codes as correct-empty.
- **Partial codes and GE pillars (C-1, C-2, C2-3, C2-9)**:
  - **Whole-query partial code** (`[a-z]{2,4}\d{0,3}`, known prefix, the whole query, e.g.
    `CS32`, `GEA`, `cs101`): a **hard candidate mask**. A PK range scan `code >= ? AND code < ?`
    reads ≈ the rows it returns. The members are ordered by exact dense score (3-0). Lexical and
    RRF play no part. In `mode=lexical` and in the keyword-only fallback the members are in code
    order (C2-9), with a test.
  - **A code token inside a longer query** (`cs32 machine learning`): the prefix members become a
    **third RRF list** with weight w_c = 1 (fixed at P-6, A2-8).
  - **Letter-only tokens:**
    - A letter-only token never prefix-routes inside a multi-token query.
    - As a whole query, it routes only when it is a known prefix and is not on the collision
      list. So `AI`, `js` and `pr` are topical queries.
  - **GE intent**: `ge`, `gen ed`, `general education`, and the pillar names from the table:
    - maps to the pillar prefixes only, never `GE\d` (Geography);
    - a whole query → the pillar mask ordered by dense score;
    - inside a longer query (d-079 `GE module about technology and society`) → a
      **pre-retrieval candidate mask** (C2-3): the dense search scores only pillar rows (filter
      table prefix id), and the FTS query carries the code-prefix ranges in SQL. The page then
      fills from pillar modules instead of keeping the few that survive fusion;
    - echoed as `interpreted.ge` and undoable with `ignore=ge`.
- **Keyword brittleness**: add `modules`, `module`, `course(s)`, `class`, `teach`, `something`,
  `nus` to the stopwords.
  - `intro`/`introductory` go to the 3D intent parser, not the stopword list.
  - `code` stays UNINDEXED in FTS (0006 rationale); the routes above replace it.
  - **The stopword change is screened alone under the general CI rule (A-4)**, as its own
    candidate `stopwords-v2`. It joins L3 only if it passes dev alone, and is dropped otherwise.
- **Touches** `src/query-intent.js`, `src/search.js` (`runSearch`), `src/fts-query.js`,
  `src/modules.js`, `src/ingest.js` (catalogue_only), `migrations/0008_catalogue.sql`, and data
  files under `data/`.
- **Measured.**
  - Dev targets: `code-space`, `code-partial`, `ge`, `abbreviation`, with the exact-code check.
  - A-5: 3B's pool is judged first. Any target that still has 0 answerable dev queries after that
    round is dropped from the declared targets, by that stated rule, before the screen runs, and
    the drop is logged in the PR. P-0a makes d-087 to d-092 answerable, so fewer drops are
    expected.
  - The targeted route still needs ≥ 3 distinct answerable target queries.
  - Pooled runs: 3B, `stopwords-v2` alone, and the bundle 3B + `stopwords-v2` (A2-6).
  - Fallback (A2-7): 3B without `stopwords-v2`. One look (L3).

### 3C Typos and prefixes (S4)
- **Order per token with df 0** (pre-correction tokens):
  1. **Prefix (C-9).** A token of ≥ 4 letters becomes an FTS prefix term `"progr"*`, served by
     0006's prefix index. `psych` matches `psychology` without being edited to `psyche`.
  2. **Edit distance.** Only if the prefix term also matches nothing, and only for tokens of
     **≥ 5 letters** (C-3): correct to the nearest vocabulary term by **OSA distance** (C2-5), so
     a transposition such as `desgin` or `fiannce` costs 1. The distance is ≤ 1 for 5–7 letters
     and ≤ 2 for 8+, with ties going to the higher df. Shorter tokens (`asdf`, `lol`, `idk`,
     `foo`, `hgb`) are never corrected.
  3. The original token stays in the OR, so nothing is lost.
- **Intents are parsed after correction (C2-4)**, so `intro accunting no prerqeuisites` (d-099)
  sets `prereq=none` and `introducttory economics` (d-096) sets the beginner intent. 3G's
  vocabulary test still reads the pre-correction tokens.
- The vocabulary (surface tokens by `queryTokens` with df, *est.* ~25k terms, ~300 KB) is built
  from the same corpus as the vectors bundle and ships beside it, versioned the same way.
- **Variants** (finite, pre-registered):
  - 3C-1 changes the lexical half only.
  - 3C-2 also embeds the corrected text. The second embed is a separate single-text call run in
    parallel with the first (B-11), so neither embedding depends on batching, and the latency
    is max(), not sum. It needs new query embeddings, capped at 500 neurons per run.
  - **Only a variant that passes the SC4 typo rule (§4) is eligible (C2-4).** Critic C's
    overlaps under keyword-only correction (d-093 5, d-094 10, d-095 5, d-096 4, d-097 9, d-099
    5) suggest 3C-1 may not.
  - Both variants' top-10s are pooled in one round before selection. The fallback is the other
    eligible variant.
- **Measured.**
  - Dev target `typo` (6).
  - A dev-only diagnostic adds noise-model variants of clean dev queries. They live in a
    **separate set directory with their own qrels** (`--set-dir eval/diag/typo`, A-N8;
    manifest-checked after P-0b), so the locked dev file never changes. It is reported and never
    gated.
  - One look (L4).

### 3D Level intent and graduate flooding (S6)
- **Intent rules, per direction (C-6, C-13, C2-6)**, from the parser in `src/query-intent.js`.
  The phrase lists are pre-registered. **The longest matching phrase wins**; a phrase inside a
  longer match is not read on its own.

  | intent | phrases (examples) | effect |
  |---|---|---|
  | beginner | `intro`, `introductory`, `beginner(s)`, `for beginners`, `no background`, `first year`, `1st year` | **hard exclusion of level ≥ 5**; soft prior α favours levels 1–2 over 3–4 |
  | graduate | `graduate`, `postgraduate`, `masters`, `phd` | hard filter level ≥ 5 |
  | level N | `level N000`, `N000 level`, `N000-level`, `Nk`, `Nnd/Nrd/Nth year` and `second`–`fourth year`, `year N`, `XX N000` (after the code order in 3B) | hard filter level = N (as the `level` param) |
  | none | `advanced` alone (`advanced calculus` keeps MA2311), any phrase negated by `not`/`non`/`except`/`beyond` within the two preceding tokens (`not first year basics`) | no level intent; the phrase stays in the query text |

  - `level 1000`, `1000 level` and `1k` are level N = 1, not beginner: r2 listed them under both.
    Level = 1 already excludes level ≥ 5.
  - Matched phrases are stripped from the lexical query only. The dense query stays raw.
  - The intent is echoed as `interpreted.level` (direction and the exclusion applied), so the UI
    (Phase 5) can show it. `ignore=level` undoes it.
  - `no background` also sets `prereq=none` (3H). Both are echoed, and each is undoable on its
    own.
- **Ranking**, in two parts screened separately (A-4):
  - **α**, the beginner soft prior after fusion: score × (1 − α·p), where p is 0 for levels
    1–2, 0.5 for 3 and 1 for 4. Grid α ∈ {0, 0.1, 0.2, 0.35}, each with the hard rules (A2-6:
    α = 0 is "rules alone"). Screened on the targeted route, with target `level`.
  - **β**, a default penalty on level ≥ 5 when no level intent is parsed. S6: 46% of the corpus
    is level 5+. Grid β ∈ {0.1, 0.2, 0.35}, against 0. It touches every query, so it is screened
    **alone under the general CI rule**. It joins L5 only if it passes dev alone.
- P2 interaction: Phase 4 adds the study-level input and the hard rule for exchange mode. The
  priors stay soft and only order what that rule allows.
- **Measured**: dev target `level` (7) for the rules + α. The overall dev CI rule applies to β.
  Pooled in one round: the 4 α points, the 3 β points, and the bundle rules + α* + β* as one
  extra run (A2-6). Fallback (A2-7): the rules with α = 0 and no β. One look (L5).

### 3E RRF weighting (S2)
- Weighted RRF in `fuse()`: w_v/(k + r_v) + w_l/(k + r_l) (+ w_c/(k + r_c) for the 3B code
  list). The hash tiebreak becomes: best single-list rank, then dense rank, then code.
- Pre-declared grid:
  - w_v/w_l ∈ {1, 1.25, 1.5, 2} (w_l = 1);
  - k ∈ {20, 60};
  - **w_c = 1, fixed at P-6** (A2-8). Dev has no multi-word query with a known-prefix code token
    except d-025, so dev cannot tune it. The SC4 mixed-query rule (§4) checks it instead.

  That is 8 points, one of them the shipped (1, 60), tuned **after** 3A and 3D, which shift the
  lists' relative quality. All 8 are pooled in one round before selection.
- S2's cases (`intro to psych`, `learn korean`) join the SC4 guards. One look (L6).

### 3F Near-duplicate crowding (S8)
- **The grouping rule is the eval's groups-v1 rule (A-2, C-8).** One rule serves eval and product,
  pre-registered by its version string:
  - variant family: same normalised title and the same code stem (letters + 4 digits);
  - cross-listing: identical title and description, never on `Not Available`.

  Mechanics:
  - The pure `buildGroups` moves from `eval/lib/groups.mjs` to `src/groups.js`, and the eval
    imports it.
  - Ingest computes group ids over the live offered modules. They ride in the filter table, and
    the manifest records `groups-v1`.
  - This groups TR3202I/N/S/T, so `test/findings/search.test.js:97` turns green (C-8).
- **Collapse.** After filters (so an unavailable member never stands in) and fusion, only a
  group's first member stays. The others ride along as **`variants: [{ code, credits }]`**, since
  credits differ inside 37 groups (C-8). The page fills with the next distinct results. This is a
  response shape change.
- **Gate: identity, no look (A2-4).** The eval already scores the first member of each group
  only, so a holdout look could not fail it. 3F passes iff:
  - on dev and the fixture, the collapsed result list equals the **group-first projection** of
    the uncollapsed one: walk the uncollapsed list (fetched deep enough to fill the page), keep
    each group's first member, drop the rest;
  - dev primary ΔnDCG@10 ≥ 0 (change kind `no-loss`, P-5b);
  - the S8 finding test is green.

### 3G Gibberish and "no matches" (S8)
- **Trigger** (C-3): return `count: 0` with `noMatch: { reason: "no-signal" }` iff:
  - no code, prefix or GE route fired;
  - no **pre-correction** token has df > 0, and no pre-correction token of **≥ 4 letters** has
    an FTS prefix match (C2-10); and
  - the top exact dense cosine (from 3-0) is below τ.

  3C's correction runs after this test, so `asdf` → `aidf` cannot rescue gibberish.
- **τ (A2-9, C2-10).**
  - The rule that maps 3G-1's distribution to candidates is fixed at P-6. Step 3G-1 measures the
    top-1 cosine on the gibberish set and on the dev queries **not tagged** no-answer; it reads
    tags, never relevance labels.
  - Candidates: the gibberish set's top-1 cosine at its 90th and 95th percentiles and at its
    maximum (+1e-6), as distinct values.
  - **Selection: the largest candidate that passes every dev condition below.** The candidates
    are distinct, so the rule has no ties.
  - Fallback (A2-7): the next smaller candidate that passes on dev.
- **Gate, no holdout look** (A-1, C-3, A2-9; ADR 0003 amendment, §9). 3G passes iff all hold:
  - the SC4 gibberish, non-existent-code and guard rules pass;
  - ≥ 90% of the **pre-registered gibberish set** returns `count: 0` (threshold fixed at P-6).
    The set is `eval/dev/gibberish.json`, ≥ 20 strings written before any 3G code: keyboard mash,
    filler, out-of-vocabulary slang, and mixed tokens like d-025. It is disjoint from SC4;
  - dev answerable ΔnDCG@10 ≥ −0.01, with the no-answer set fixed by tag (change kind
    `answerable-floor`, P-5b);
  - the **custodian's count** of holdout queries not tagged no-answer that the selected τ
    empties is 0. The custodian stores the candidate with `--holdout --store-only`, and a
    custodian-only script prints that one number. The count is logged in the ledger as a count,
    not a look. The fallback gets one count of its own.

### 3H No-exam, S/U, workload and prerequisite intents (S7)
- **Data (3H-0, 3H-1).**
  - Migration `0007_intents.sql` adds:
    - `exam_semesters` (JSON: the semesters with an `examDate`) and generated `exam_sem1..4`;
    - `su` (from `attributes.su`) and `grading_basis`;
    - `workload_hours`: the sum of the workload array, NULL when unparseable **or all zero**
      (259 modules, C-11);
    - `prereq_none` (prerequisite IS NULL, C-5) and `prereq_cohort_only` (A2-12): the
      prerequisite text is only a cohort or programme restriction, by a committed pattern list.
      3H-0 commits the list, its matches and the count.
  - `normalise()` keeps them, and `NORMALISER_VERSION` is bumped, so every `row_hash` changes.
  - That makes a row-only re-ingest through the runbook: no re-embedding, no FTS writes, *est.*
    ~35–50k rows written, after the headroom check and a bookmark (ADR 0004). Step 7 then
    rewrites the standby's metadata (B2-10). It is ranking-neutral, so it can land early.
  - 3H-0 re-runs critic C's field counts and commits them.
  - **The fixture is rebuilt** after the bump (C-15). It gains examples of each intent: mixed
    per-semester exams, CS/CU grading, zero workload, no prerequisite, cohort-only prerequisite.
- **Query side.** The intent parser maps phrases to new explicit params, longest phrase first:

  | phrases | param | constraint |
  |---|---|---|
  | `no exam(s)`, `no final(s)`, `no final exam(s)`, `without (final )?exam(s)`, `without final(s)` | `exam=0` | no `examDate` in the selected semester, or in any offered one when none is set |
  | `s/u`, `su-able`, `s/u-able`, `pass/fail` | `su=1` | `su` **or** grading basis CS/CU (C-12); `interpreted.su` says which matched |
  | `light workload`, `low workload` | `hoursBelow=10` | `workload_hours < 10`; NULL excluded |
  | `under N hours`, `less than N hours`, `< N hours` | `hoursBelow=N` | `workload_hours < N`; NULL excluded |
  | `no prereq(s)`, `no prerequisite(s)`, `no background` | `prereq=none` | semantics (i) or (ii), below |

  - **"light" is a fixed 10 hours** (pre-registered). 10 h a week is the standard 4-MC load,
    and 4,614 of 5,081 4-MC modules list exactly that. So "light" means below the standard load.
    A fixed number means the same thing to every student, and 2-MC modules (5 h) qualify, as
    they should. 3H-1 measures how many modules match and reports the count.
  - **`prereq=none` has two pre-registered semantics (A2-12):** (i) prerequisite IS NULL;
    (ii) NULL or cohort-only. Both are pooled. **Selection:** mean ΔnDCG@10 over the dev queries
    with a parsed prereq intent; (i) wins ties to 3 decimals, as the literal reading.
    `interpreted.prereq` names the semantics applied.
  - The constraints are hard filters in SQL and in the in-Worker filter table.
  - **Matched phrases are stripped from the keyword query (C-4)**, so `final` no longer boosts
    Final Year Projects and `s/u` no longer becomes `s`. With the longest-phrase rule,
    `without final exam` strips `exam` too (C2-6, TME2101).
  - For the dense query, raw vs stripped is a **pre-registered dev diagnostic on the constraint
    block**. Stripped wins unless raw's constraint-block mean nDCG@10 is higher by ≥ 0.05 and
    raw's overall dev Δ ≥ 0 (margin fixed at P-6). Both are pooled.
  - The response echoes `interpreted`, so the UI (Phase 5) can show it, and `ignore=<intent>`
    undoes it.
  - Copy:
    - no `examDate` means "no final exam listed", not certified;
    - NULL workload reads "workload not listed";
    - Phase 3 copy makes no claim about whether exchange students may S/U. The registrar question
      goes to Phase 4 as an open question (C-12).
  - `grsu` (graduate S/U) is left to Phase 4.
- **Measured: one look, L7, under the holdout rule (A2-3).** 9 of the 98 dev queries carry a 3H
  phrase, so 3H moves the relevance metric and needs a look. Judges never see exam, S/U,
  workload or prerequisite fields (`JUDGING.md`), so compliance itself is measured by the SC4
  suite. The dev screen passes iff:
  - the SC4 intent rules pass;
  - dev primary ΔnDCG@10 ≥ 0 (change kind `no-loss`, P-5b; constraint block reported);
  - on dev, every query with no parsed intent keeps its top 10 unchanged.

  Pooled runs: (i) and (ii), each stripped and raw: 4. Fallback (A2-7): the dev runner-up.

## 3. Measurement and the holdout look plan
- **Before L1.** All of these are done before the first holdout look. The order matters where
  stated.
  - **P-0a. Code-target rule grades** (lead, in progress). Judge rule 4 in `eval/JUDGING.md`
    grades a code query's target modules from the corpus, mechanically. It produces
    `qrels-dev-v2` and `qrels-holdout-v2`, and makes d-087, d-089, d-090, d-091 and d-092
    answerable. P-4 follows it.
  - **P-0b. Gate and custody hardening** (lead, in progress):
    - a cutoff must truncate the baseline;
    - the ledger records the rule applied;
    - the baseline ranker's sha is checked;
    - `--store-only` cannot overwrite a stored run;
    - `--set-dir` is checked against its manifest.
  - **P-1. groups-v1: done** (PR #28, `87107a1`). `eval/groups.json` is the duplicate-group source
    for every set.
  - **P-2. Step 3-0.0**, the embed-latency check. Q3 goes to Jacob only if it triggers.
  - **P-3. 3-0** is built, proven identical on dev and the fixture, and deployed. Runbook step 7
    upserts the standby. No look.
  - **P-4. The dev baseline** is measured under `qrels-dev-v2` and groups-v1, after P-0a. It
    replaces the "to be measured" in §1. r2's deep pool of the four mapping pastes is dropped
    (A2-1).
  - **P-5. The ADR 0003 and 0004 amendments** merge (§9).
  - **P-5b. Gate code for the new rules (A2-2)**, on top of P-0b, each with tests:
    - an SC5 gate selectable on the holdout (`--gate sc5`), accepted only for the L12 look under
      the holdout reading and recorded in the ledger. Without it, L12 would run the per-change
      point-estimate rule and write a pass;
    - change kinds `no-loss` (Δ ≥ 0 point estimate, for 3F and 3H's dev screen) and
      `answerable-floor` (answerable ΔnDCG@10 ≥ −0.01, for 3G);
    - the no-answer set defined by tag (`noanswer`, `code-nonexistent`, `noAnswerByRule`) in
      `eval/lib/metrics.mjs`. An untagged query with no grade-≥1 document is unscored, in
      neither set;
    - reports list unscored query ids on dev only, and give counts only on the holdout and test
      sets (A2-11).
  - **P-6. The pre-registration commit** (A-N3, A-6). It fixes:
    - every grid and finite candidate set: 3A-2 v1–v3, 3C-1/3C-2, α ∈ {0, 0.1, 0.2, 0.35}, β,
      the 8-point 3E grid, w_c = 1, the two prereq semantics, raw/stripped;
    - the selection statistic, the tie-break, and each SC4-required change's fallback;
    - the stopword list, OSA thresholds, intent phrase lists and precedence, GE table and
      collision list;
    - "light" = 10 h, the raw/stripped margin, the gibberish set and its 90% threshold, and the
      τ candidate rule;
    - the SC4 suite, with its typo threshold T and mixed-query count.
  - **P-7. Jacob answers Q1** (SC5 reading), batched with Q2 (VPN) (§10).
- **Dev is open.** Every candidate runs `npm run eval -- --variant <v> --baseline <shipped>`
  (with `--target-shapes` or `--change-kind` where declared) and must pass the dev screen before
  its look. Every comparison scores both runs under the same, latest qrels version.
- **One pooling round per workstream, before selection (A-6, A2-6).** `eval:pool --runs
  <shipped>,<every candidate> --unjudged` pools the union of every candidate's top-10. Every
  bundle that could go to a look is pooled as one extra run in the same round.
  - Judge A (`claude-opus-5-5`, single-judge protocol, ADR 0004) grades the round, with a 5%
    drift sample, and it merges to the next qrels version.
  - Only then is a candidate selected. judged@10 must be 100% for every run compared.
  - The pool step's output gives the actual new-pair count, which §6 bounds.
- **Selection statistic (pre-registered).**
  - Ranking:
    - general change: dev primary mean ΔnDCG@10 vs the shipped ranker;
    - targeted change: mean ΔnDCG@10 over the declared targets' answerable queries, among
      points with overall Δ ≥ 0.
  - Ties (equal to 3 decimals) go to the point nearest the shipped configuration: fewest changed
    parameters, then the smallest change, then grid order. 3G (§2) and 3H's prereq semantics
    have their own stated rules.
  - **Named retry.** Written into the PR before the change's look (A-N3). For a change SC4 needs
    (3B, 3C, 3D, 3G, 3H) it is the pre-registered fallback, which must itself pass SC4 on dev
    (A2-7). For any other change with a grid it is the second-ranked point. 3A-1 has none.
  - **Dropping a change SC4 needs** goes to Jacob (§10, Q4). That covers a change whose retry
    also fails, and one whose fallback equals the candidate that failed (3B, when L3 carried it
    without `stopwords-v2`).
- **Cross-family check per round (A-N2; ADR 0004 amendment).**
  - Scope: 3A-2, 3D and 3E on dev, and the SC5 test pool.
  - Pairs: every pair in the symmetric difference of the selected point's and the shipped
    ranker's top-10s.
  - Grading: `gemini-3.8-flash-high` grades them blind to judge A, through a T3 `delegate_task`
    thread. A fresh Claude Sonnet verifier checks every Gemini grade, also blind to A.
  - Report: the verified grades' agreement with A, and the dev ΔnDCG@10 sign recomputed with
    verified grades on those pairs.
  - On dev, if that sign is opposite to judge A's, the change does not go to its look until the
    lead records a decision with a reason.
- **Holdout, custodian only.** Tuning agents never get the key and never decrypt; they see only
  the verdict lines. For each look the lead (custodian):
  1. stores the candidate (`--holdout --store-only`, no look);
  2. pools it encrypted (`--custodian --unjudged`);
  3. judges it with in-process subagents and merges;
  4. only then runs the verdict, so no look is spent `unjudged`.

  The ledger is committed after each look. Retries are the named ones only, so the custodian
  directs no rework after seeing a verdict (A-N3).
- **Look plan** (≤ 12; every look compares against the ranker shipped at the time):

  | look | candidate | rule |
  |---|---|---|
  | — | 3-0 exact search | identity on dev + fixture; no look |
  | L1 | 3A-1 query prefix | general |
  | L2 | 3A-2 selected text variant (on top of L1's result) | general |
  | L3 | 3B codes + GE (+ `stopwords-v2` only if it passed dev alone under the CI rule) | general (targets after the A-5 drop) |
  | L4 | 3C selected variant (3C-1 or 3C-2), with the prefix step | general |
  | L5 | 3D level rules + α (+ β only if it passed dev alone under the CI rule) | general |
  | L6 | 3E fusion weights + tiebreak | general |
  | — | 3F groups-v1 collapse | identity vs the group-first projection + dev `no-loss`; no look |
  | — | 3G no-match | SC4 + gibberish set + dev `answerable-floor` + custodian count = 0; no look |
  | L7 | 3H intents | general |
  | L8–L12 | reserve, **sealed reading** (5 slots) | as the original change |
  | L8–L11 | reserve, **holdout reading** (4 slots) | as the original change |
  | L12 | **holdout reading only**: frozen ranker vs `eval-v0`, the SC5 look | SC5 rule via `--gate sc5` (BCa lower bounds of ΔnDCG@10 and ΔP@5 > 0) |

  **Arithmetic.**
  - Change looks: 3A-1, 3A-2, 3B, 3C, 3D, 3E, 3H = **7** (L1–L7).
  - No-look changes: 3-0 and 3F (identity), 3G (SC4, gibberish set, answerable floor, count) = 0.
  - Bundled candidates: `stopwords-v2` rides L3 and β rides L5, each only after passing dev
    alone = 0.
  - SC5: sealed reading 0 (the test set has its own single look, and the holdout is not read
    for SC5); holdout reading 1 (L12).
  - Reserve = 12 − 7 − 0 = **5** (sealed) or 12 − 7 − 1 = **4** (holdout).
  - Against r2: 3F leaves (−1) and 3H enters (+1), so change looks stay at 7. r2's reserve was
    5 or 4 only if 3H's count stayed below 3. Critic A puts the chance of that at 1.7%
    (P(count ≤ 2 of 81)), so r2's likely reserve was 4 or 3. r3's 5 or 4 is certain.
  - Retries: 6 changes have a named retry (3A-2, 3B, 3C, 3D, 3E, 3H). The reserve funds at most
    one per failed change, in order of failure. When one slot is left and more than one change
    is waiting, the waiting changes are bundled into that look, never a 13th. A change that fails
    with no retry left is dropped, and a dropped SC4-required change goes to Q4.

## 4. SC4 acceptance suite (pre-registered)
- **Written by the lead** before any 3B–3H code merges, from the SC4 wording. Committed as
  `test/sc4/queries.json` at P-6, with rules, counts and thresholds fixed in the same commit.
  Implementers may not edit it; a change goes through the lead with the reason logged.
  - Dev is open, so named dev texts may appear, and each is listed: d-024 as an intent rule,
    d-079 and d-022 as GE rules.
- **Custody (A-N1).**
  - No holdout text enters the suite. The custodian runs the v2.1 code-overlap rule and the
    query-embedding cosine ≥ 0.9 check of every suite query against the holdout. The tool prints
    only the hit count and the hitting suite ids, and those suite queries are replaced.
  - The suite's texts and code targets join the test-set exclusion list and the test-set leak
    filter (§5).
- **Runs** the real Worker over the **pinned bundle** and pinned corpus in the `full-corpus` CI
  job (B2-4). Query embeddings are committed (*est.* ~100 texts with the gibberish set, < 5
  neurons).
- **Every query has an exact expected `interpreted` JSON**, with `null` for every intent it must
  not set. Any difference fails (C-10).
- **Thresholds fixed at P-6:**
  - **T, the typo overlap** (C2-4). The lead writes the clean form of each of the 6 dev typo
    queries and runs an oracle variant: the lexical half on the clean form, the dense half on the
    typo form, the best a keyword-only corrector can do. T is the smallest oracle overlap@10 over
    the 6 pairs, capped at 7.
  - **M, the mixed-query count** (A2-8): ≥ 3 prefix members in the top 10 (proposed). CS32 has
    30 offered modules, so the rule is satisfiable.
- **Items, fixed counts, rules** (C-10, C-1, C-6, round 2). "Groups" are groups-v1 groups, with a
  singleton counting as its own group (A2-5).

  | item | n | rule |
  |---|---|---|
  | space code (`cs 1010s`, `ma 1521`, `cs1010 s`, `is 4246`) | 5 | that code at rank 1 |
  | code vs level (`GEA1000`, `ES1000`, `cs 3000`) | 3 | offered code at rank 1 with `interpreted.level` null; `cs 3000` → level 3 with the CS prefix route |
  | partial code or pillar (`CS32`, `cs101`, `cs 32`, `GEA`, `gec`, `GEX`) | 6 | count > 0; the top min(10, G) results are all members, G = distinct groups in the set ∩ filters; every member appears as a result or a variant |
  | code inside a longer query (`cs32 machine learning`, one more written at P-6) | 2 | ≥ M prefix members in the top 10 |
  | GE inside a longer query (d-079, d-022) | 2 | every result is a pillar member, and count ≥ min(10, \|pillar members ∩ filters\|) |
  | typo | 5 | top-10 overlap with its clean form ≥ T, and the clean form's `interpreted` |
  | level: beginner | 4 | no level ≥ 5 in the top 10, and a named level-1/2 answer in the top 3 (e.g. CS2109S, EE2211) |
  | level: graduate | 2 | every top-10 result level ≥ 5 |
  | level: N / year (`4000 level`, `level 3000`, `3rd year`, `2nd year`, `third year`) | 5 | every top-10 result at level N |
  | no-exam (d-024's text, `without final exam`) | 3 | 100% of results satisfy the constraint, and top-10 overlap ≥ 7 with (clean query + explicit param) |
  | S/U | 3 | as no-exam |
  | workload | 3 | as no-exam |
  | no prerequisite | 3 | as no-exam, under the selected semantics |
  | gibberish | 5 | `count: 0`, `noMatch.reason` `no-signal` |
  | non-existent code | 3 | `count: 0`, `noMatch.reason` `unknown-code` |
  | not-offered code (`GEQ1000`, one more) | 2 | `count: 0`, `noMatch.reason` `not-offered`, `noMatch.title` equals the catalogue title |
  | guards | 26 | count > 0 and no prefix route fired; for a collision-list token, the exact `interpreted` JSON as well and no count rule (C2-8); for any other letter-only token, ≤ 2 of the top 10 have a code whose letter part equals it |
  | **total** | **82** | |

  The guards include `art history`, `law and society`, `intro to psych`, `learn korean`, `AI`,
  `ai ethics`, `js`, `pr`, `comp 1010`, `math 1001`, `econ 1101`, `advanced calculus` (MA2311 in
  the top 10, no level intent), `not first year basics`, `give me 2 easy electives` and
  `how many units is 3 US credits` (no code join, C2-2). The AI guard has no count rule: all 9
  AI* modules are about AI, so a correct answer may hold several.
- **SC4 passes** iff the suite is fully green at the frozen ranker, and a live confirmation of
  ≤ 20 calls on the deployed Worker agrees on every rule it samples.
  - The live queries are **fresh texts written at the freeze**, not the suite's.
  - Code rules are sampled only on codes present in both the pinned 2026-09-04 catalogue and the
    live 2026-11-04 one.

## 5. SC5 (decided once)
- **Order.**
  1. **Before L1** (P-7), Jacob decides the reading (§10, Q1), so it isn't chosen after any
     holdout verdict (A-3).
  2. Freeze: tag `phase3-final` after the last accepted change.
  3. Then one branch, by the reading:
     - **Sealed reading:** the **lead (custodian) writes the test set**.
       - Fresh persona-writer subagents use the pre-registered prompts, personas and shape
         procedure from ADR 0003, with a new recorded seed. Code queries come from a secret
         custody seed.
       - Exclusions: dev, holdout, the SC4 suite and the gibberish set.
       - The leak filter drops any query with cosine ≥ 0.9 to, or a shared source with, any of
         them.
       - Writing continues until ≥ 160 answerable queries, at most 2 extra rounds. The stopping
         rule reads only a **count-only tool** (`eval:count --set test`, A-N9). It prints the
         answerable count and nothing else, and is not a look.
       - Pool v0 + final top-10, judge A in-process (with rule 4 grades), then run the
         cross-family check on the differing pairs (reported).
       - Then **one look** on the test set: BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0,
         final vs `eval-v0` on the pinned corpus. The holdout is not read for SC5.
     - **Holdout reading:** L12 is the SC5 look, final vs `eval-v0` on the holdout under the SC5
       rule (`--gate sc5`, P-5b). It is reported with the holdout's look count and the
       adaptive-reuse caveat from ADR 0003. No sealed test set is written.
- **Labelling.** Results are labelled "offline replica". After 3-0, production's dense search is
  exact too, so the replica-vs-production caveat in ADR 0003 narrows to the corpus pin.

## 6. Cost and quota plan

Allowances (ADR 0004): D1 25B rows read and 50M written a month; Vectorize 50M queried dims a
month; Workers AI 10k neurons a day; Workers CPU 30M ms a month; live traffic ≤ 60 `/search`
calls per agent per session.

Deploys (B2-9): 3-0, 3A-1, 3A-2, 3B, 3C, 3D, 3E, 3F, 3G, 3H data, 3H query = **11 planned**,
budgeted at 13 to cover a failed smoke and its redeploy.

| item | D1 read | D1 written | Vectorize queried dims | neurons | live `/search` |
|---|---|---|---|---|---|
| 3-0.0 warm burst | ~5k (12 × 406 mean) | 0 | ~4.6k (12 × 384) | < 1 | ≤ 12, one session |
| 3-0 cutover: guard read + step-7 upsert of 6,778 with metadata | ~6.8k | 0 | 0 (upserts; stored 2.6M of 10M) | ≤ 300 (missing texts, *est.*) | ≤ 4 smoke |
| deploys (≤ 13): guard read via `/admin/hashes` + smoke (≤ 4 each) | ~88k (6.8k × 13) + ~21k (52 × 406) | 0 | 0 after 3-0 | ~3 | ≤ 52, ≤ 4 per session |
| SC7 counted run at the freeze | ~18k (45 × 406) | 0 | 0 | ~2 (45 × 0.05) | 45, one session |
| SC7 declared re-run (colo shortfall only) | ~18k | 0 | 0 | ~2 | 45, another session |
| 3A-1 query prefix, all sets | 0 | 0 | 0 | < 15 | 0 |
| 3A-2 text variants (3 eval passes) | 0 | 0 | 0 | ≤ 7.2k, ≤ 2 passes a day | 0 |
| 3A-2 production (runbook) | ~30k | ~35k *est.* | 0 | ≤ 300 | in deploys |
| 3B `0008_catalogue` + load of ~14.4k catalogue-only rows | ~15k | ≤ 30k *est.* (rows + PK index) | 0 | 0 | in deploys |
| 3H migration 0007 + row-only ingest | ~30k | ~35–50k *est.* | 0 | 0 | in deploys |
| 3C-2 / rewrites (embed-missing cap) | 0 | 0 | 0 | ≤ 500 per run | 0 |
| verify after each corpus change (×4: pre-deploy + post-step-7) | ~55k | 0 | `getByIds` sample only | 0 | 0 |
| SC4 suite + gibberish embeddings + live confirmation | ~8k | 0 | 0 | < 5 | ≤ 20 |
| **Phase 3 total** | **< 0.35M of 25B** | **< 0.15M of 50M** | **~2.6M (stored term) of 50M** | **≤ 5k on any one day** | **≤ 60 per agent session** |

The stored term, (6,778 stored) × 384 ≈ 2.6M, counts once a month. Every search before
3-0 queries 384 dims; after 3-0, none does.

CPU: the 3-0 smoke reads mean `CPUTimeMs` per request (B2-8). At the 5 ms *est.*, Phase 3's live
calls (< 200) cost < 1k CPU-ms.

**Judging (agent time, no Cloudflare cost).** Upper bounds: dev has 98 queries × 10 = 980 top-10
slots per run, and most slots repeat already-judged pairs. Each round's pool step prints the
actual new-pair count before packets are prepared. "Cross-family pairs ≤" is 20 per query (the
symmetric difference of two top-10s) × 98.

| round | runs pooled (besides the shipped one) | new pairs ≤ | cross-family pairs ≤ |
|---|---|---|---|
| 3A-1 | 1 | 980 | — |
| 3A-2 (v1–v3, dense-only + hybrid) | 6 | 5,880 | 1,960 |
| 3B (3B, `stopwords-v2` alone, bundle) | 3 | 2,940 | — |
| 3C (3C-1, 3C-2) + diagnostic set (own qrels) | 2 + 2 | 1,960 + diag | — |
| 3D (α × 4 with rules, β × 3, bundle) | 8 | 7,840 | 1,960 |
| 3E (7 new points) | 7 | 6,860 | 1,960 |
| 3F | 1 | 980 | — |
| 3H ((i), (ii) × stripped, raw) | 4 | 3,920 | — |
| holdout, per look (custodian) | 1 | 810 | — |
| SC5 test pool (sealed reading) | 2 (v0, final) | ~20 per query | ~20 per query |

Other rules:
- The ingest and a corpus eval pass never run on the same UTC day.
- Every remote D1 operation, reads included, is estimated and logged in `remote-ops.md`.
- Every write first gets the ADR 0004 headroom check: estimate × 1.5 must fit the remaining
  allowance.
- Every neuron spend goes into `neurons.tsv`.

## 7. Risks
- **Bundle size and startup**: 10.4 MB could slow cold isolates outside `total`. The mitigations
  are the `versions upload` startup gate, the reported TTFB, and int8 or a static asset as
  fallbacks.
- **Deploy-coupled freshness**: no deploy after an ingest leaves the dense half stale. The deploy
  guard refuses a manifest whose `rowsKey` or data version differs from D1's. The pre-deploy
  verify and `/health` compare the bundle's data version. The dense rows are re-filtered against
  fresh D1 rows.
- **Admin routes**: production never binds `INGEST_SECRET`, so every admin route there stays 404.
  The runbook and the guard reach them only through `wrangler dev --remote`. `/admin/vectors`
  takes its values from the sha-checked asset, so the dev session's fixture bundle cannot leak
  into the standby.
- **Embed latency** (sparse 227 ms, post-switch smokes 260–414 ms) is outside our control, and
  the warm p67 sets SC7. Step 3-0.0 measures it before 3-0 is built, and Q3 goes to Jacob if it
  threatens SC7. If the counted run fails, it fails. The plan does not change the rule.
- **Dev overfitting**: 98 queries, SC4 shapes of 3–7. Mitigations:
  - grids are finite and pre-registered, and w_c is fixed rather than tuned;
  - selection happens after full judging of every point and bundle;
  - retries are named in advance;
  - the holdout screens each change, and the SC5 set decides.
- **Look exhaustion**: 7 planned looks and 4–5 reserve against 6 possible retries. The fallback
  is to bundle rather than take a 13th.
- **An SC4-required change fails its look.** Its fallback is the retry. If that fails too, SC4
  cannot pass on that item, and Jacob decides (Q4).
- **Intent parser false positives**: the collision list, the guarded spaced join and the "known
  prefix only" rule stop `AI`, `js`, `comp 1010` and `give me 2 …` from routing. Hard level and
  intent filters are echoed and undoable. The SC4 guards and exact `interpreted` JSON pin each
  case down.
- **Hard beginner exclusion** removes level ≥ 5 even where a student might accept one. It is
  echoed so the UI can undo it.
- **Exam data semantics**: a missing `examDate` is not a certified "no exam". The mitigations are
  the UI copy and the echoed interpretation.
- **No-match hides real long-tail answers**: three signals must all agree. Dev answerable loss is
  capped at 0.01, the holdout count of emptied untagged queries must be 0, and the SC4 guards
  must stay non-empty.
- **Single same-family judge** (ADR 0004) grades every new pair. The per-round cross-family check
  on the differing pairs is the mitigation. Its verifiers are Claude, so the risk is lowered,
  not removed.
- **SC7 collection conditions**: last time the VPN gave 3 SIN sparse samples of the 10 needed. Q2
  asks Jacob, and the declared re-run covers one more colo shortfall.
- **Response shape changes** (`variants`, `noMatch`, `interpreted`, `ignore`, new params) are
  public API changes: branch and PR, consumed by Phase 5.
- **Long mapping pastes** stay unsearchable in Phase 3 (the 200-character limit). Phase 4 owns
  it (P1).

## 8. Exit criteria
- SC7: the counted re-measurement at the frozen ranker passes the pre-registered rule, with
  evidence in `docs/evidence/phase3/sc7.md`. The B6 fallback tests pass, and the startup gate
  passed on every deploy.
- SC4: the acceptance suite is green in CI at `phase3-final`, and the live confirmation agrees.
- SC5: one SC5 look passes, under the reading Jacob chose before L1.
- FINDINGS S2–S8 are `fixed` (or `rejected` with a reason). README's cost section names the new
  binding limit: Workers CPU or Workers AI neurons, whichever measures smaller. ADR 0006 records
  the in-Worker dense search, the vectors artifact and deploy guard, and Vectorize's standby
  role.

## 9. ADR amendments needed
| ADR | amendment | objections | when |
|---|---|---|---|
| 0003, `JUDGING.md` | **Judge rule 4**: code queries' targets graded by rule from the corpus; `qrels-dev-v2`, `qrels-holdout-v2`. | Phase 2 exit red-team | P-0a (lead, in progress) |
| 0003 | **Gate and custody hardening**: cutoff truncates the baseline; the ledger records the rule; baseline sha checked; `--store-only` cannot overwrite; `--set-dir` manifest-checked. | Phase 2 exit red-team | P-0b (lead, in progress) |
| 0003 | **No-answer set fixed by tag** for any change: `noanswer`, `code-nonexistent` or `noAnswerByRule`. Emptying any other query is answerable loss. An untagged query with no grade-≥1 document is unscored; reports list its id on dev only and give counts on the holdout and test sets. | A-1, C-3, A2-2, A2-11 | P-5; code at P-5b |
| 0003 | **Change kinds** `no-loss` (Δ ≥ 0) and `answerable-floor` (answerable ΔnDCG@10 ≥ −0.01). | A2-2 | P-5; code at P-5b |
| 0003 | **3G gated without a look**: SC4 + the gibberish set (≥ 90%) + `answerable-floor` on dev + the custodian's count of emptied untagged holdout queries = 0, which is logged as a count, not a look. | A-1, C-3, A2-9 | P-5 |
| 0003 | **3F gated without a look**: identity with the group-first projection on dev and the fixture + `no-loss` on dev. | A2-4 | P-5 |
| 0003 | **SC5 reading** recorded as Jacob decides it, with L12 per reading (sealed: none; holdout: the SC5 look via `--gate sc5`, ledger-recorded). | A-3, A2-2, A2-10 | P-7; code at P-5b |
| 0003 | **groups-v1** named as the duplicate-group rule for dev, holdout, test and the product, with the `eval/groups.json` hash in the locks. | A-2, C-8 | P-5 (groups-v1 merged at P-1) |
| 0003 | **SC4 custody and test-set exclusions**: the count-only overlap check against the holdout; SC4 and gibberish texts join the test-set exclusion and leak filter; the count-only test answerable tool is not a look. | A-N1, A-N9 | P-5 |
| 0004 | **Per-round cross-family check** (Gemini + Sonnet verifier, blind to A) on differing pairs for 3A-2, 3D, 3E and the SC5 test pool. It replaces the calibration Δ-sign report, and an opposite sign on dev stops the change before its look. | A-N2 | P-5 |
| 0006 (new) | In-Worker exact dense search; two bundles from one keyed builder; manifest `rowsKey`; deploy guard via `wrangler dev --remote` and the `versions upload` startup gate; split verify and the runbook order with every Vectorize write in step 7; cache key `v=<version id>`; Vectorize as an identical standby; rollback floor `597c2b7`; no production `INGEST_SECRET`. | B-1…B-11, A-N5, B2-1…B2-10 | with 3-0's PR |

r2's amendment "3H gated without a look" is withdrawn: 3H takes L7.

## 10. Gate questions for Jacob
Q1 and Q2 go together, before the first holdout look. Q3 is asked only if step 3-0.0 triggers
it. Q4 is a standing rule that comes up only if a change fails.

- **Q1. Which set decides SC5?** We need the answer before the first holdout look, so it can't be
  chosen after seeing results.
  - **Sealed test set** (the default): after the freeze, the lead writes a fresh test set and we
    look at it once. 5 holdout looks stay spare for retries.
  - **Holdout**: the 12th holdout look is the SC5 test, and no test set is written. 4 looks stay
    spare. By then the holdout has guided up to 11 decisions, so the result carries a reuse
    caveat.
- **Q2. Can the VPN be off for the counted SC7 run?** The run takes about 2 hours: 33 calls a few
  seconds apart, then 12 calls about 10 minutes apart. Last time the Mullvad exit sent 3 of 6
  spaced calls to Tokyo or Marseille, which left 3 Singapore samples of the 10 needed. If the VPN
  stays on, we fall back to the nearest Asia-Pacific location and the one allowed re-run, and the
  sample may still fall short.
- **Q3 (only if triggered). Should 3-0 go ahead if embed time alone threatens SC7?** Before
  building 3-0 we send up to 12 test searches and project how fast search would be with exact
  vector search in place. If that projection (the 67th percentile, which decides SC7) is above
  about 200 ms, removing Vectorize alone may not get SC7 under 250 ms. The options:
  - build 3-0 anyway: it still removes ~230 ms of Vectorize time, but SC7 may fail on embed time;
  - pause 3-0 while the lead plans an embed-side change.
- **Q4 (standing rule). If a change SC4 needs fails, who decides?** You do. The changes SC4 needs
  are 3B (codes and GE), 3C (typos), 3D (levels), 3G (no matches) and 3H (exam, S/U, workload,
  prerequisite). Each gets one pre-registered fallback. If the fallback also fails, or there is
  none, the lead brings you the result and the options: drop the change, so SC4 fails on that
  item, or have the lead write a new variant that spends a spare holdout look, if one is left.

Not a Phase 3 gate: whether exchange students may S/U at all (C-12) needs a registrar source and
goes to Phase 4 as an open question.

## 11. Objection log
Each round, three independent critics reviewed the draft: A on eval discipline, B on vectors,
ingest, deploy and cost, C on SC4 and student queries. The lead's default was to accept each
objection with its proposed fix, with the choices recorded in the dispositions. "Applied" means
the critic's fix is in the plan as proposed. Locations are r3 sections.

### Round 1 (r1, PR #27 head 40c5ec0)

| # | Objection (short) | Disposition | Where |
|---|---|---|---|
| A-1 | 3G cutoff can't pass: dev no-answer is mostly pool misses | Applied: no-answer set fixed by tag (ADR 0003 amendment); 3G gated without a look | §1, 3G, §3, §9 |
| A-2 | Eval not group-aware; groups-v1 uses another rule than 3F | Applied: 3F uses groups-v1; merged before L1 (P-1, done) | §1, 3F, §3, §9 |
| A-3 | SC5 sign-off after the freeze is too late | Applied: sign-off before L1 (Q1); L12 defined per reading | §5, §3, §10 Q1 |
| A-4 | Stopwords (L3) and β (L5) ride the targeted route | Applied: each screened alone under the CI rule | 3B, 3D, §3 |
| A-5 | L3 dev screen fails by construction | Applied: 3B pool judged first; targets with 0 answerable queries dropped by a stated rule | 3B |
| A-6 | Grid selection on incomplete judgments | Applied: one pooling round per workstream; statistic and tie-break pre-registered; pair counts (round 2: bundles pooled, w_c fixed) | §3, 3E, §6 |
| A-N1 | SC4 custody weak | Applied: custodian count-only overlap check; SC4 texts in test-set exclusion and leak filter; fresh live queries | §4, §5, §9 |
| A-N2 | Calibration Δ-sign check uninformative | Applied: per-round blind Gemini grade + Sonnet verifier (ADR 0004 amendment) | §3, §6, §9 |
| A-N3 | Pre-registration gaps; retries directed by the custodian | Applied: P-6 fixes every finite set; retries named in advance | §3 |
| A-N4 | No look slack | Applied: L12 dropped under the sealed reading. Superseded for 3H by A2-3: 3H takes L7 | §3 |
| A-N5 | Response cache key ignores the ranker | Applied; round 2 replaces `ev`/`rv` with the version id (B2-6) | 3-0 cache key |
| A-N6 | 3-0 identity harness gaps | Applied | 3-0 builder, eval fidelity |
| A-N7 | SC7 run count and conditions | Applied: one counted run; one declared re-run. The TTFB guard is withdrawn by B2-7 | 3-0 SC7 |
| A-N8 | 3C diagnostic would break the dev lock | Applied: separate `--set-dir` with its own qrels | 3C |
| A-N9 | No count-only tool for the test answerable count | Applied: `eval:count --set test` | §5, §9 |
| B-1 | Vectorize not an identical standby at cutover | Applied: step 7 upserts the 6,778 bundle vectors (round 2: with full metadata) | 3-0 standby |
| B-2 | 3A-2 order fails the deploy guard | Applied: manifest `rowsKey` vs `/admin/hashes`; D1 before deploy | 3-0 guard, runbook |
| B-3 | Stale filter table between ingest and deploy | Applied: `localMatchesFilters` on hydrated dense rows, plus a test | 3-0 runbook |
| B-4 | Startup gate can't use `--dry-run` | Applied: `versions upload` → `startup_time_ms` ≤ 200 → `versions deploy` | 3-0 startup gate |
| B-5 | `vector` span ~0 | Applied: CPU time from Workers Logs; microbenchmark | 3-0 CPU |
| B-6 | Estimate should use warm p67; embed risk | Applied; round 2 rebuilds step 3-0.0 (B2-3) | §1, 3-0.0, §10 Q3 |
| B-7 | Cache key lacks the embedding/bundle version | Applied; superseded by B2-6 | 3-0 cache key |
| B-8 | Rollback recipe | Applied in part (dissent 1) | 3-0 rollback, runbook |
| B-9 | Gitignored vectors break CI and fresh checkouts | Applied: fixture alias; `full-corpus` downloads and sha-checks (round 2: the pinned bundle) | 3-0 bundles |
| B-10 | Log every remote D1 op, reads included | Applied | 3-0 runbook, §6 |
| B-11 | Neurons with prefix; 3C-2 second embed | Applied | 3-0 neurons, 3C, §6 |
| C-1 | Partial-code/pillar rule unmeetable | Applied: hard mask by dense score; third RRF list only inside longer queries (round 2: w_c fixed at 1, groups counted) | 3B, 3E, §4 |
| C-2 | Prefix-collision guard wrong; GE → Geography | Applied: committed collision list; GE → pillar prefixes only | 3B, §4 |
| C-3 | 3G almost never fires | Applied: pre-correction vocabulary test; correction ≥ 5 letters; gibberish set. The mapping pastes are out of Phase 3 (A2-1) | 3C, 3G, §1 |
| C-4 | Intent phrases stay in the keyword query | Applied: stripped; dense raw vs stripped pre-registered; d-024 in SC4 | 3H, §4 |
| C-5 | S7 prerequisite part missing | Applied: `prereq=none` (round 2: two semantics) | 3H, §4 |
| C-6 | Level rule contradicts the soft prior | Applied: per-direction rules; beginner hard-excludes level ≥ 5 | 3D, §4 |
| C-7 | Unknown-code rule empties ordinary queries | Applied: known prefix only; `not-offered` route (round 2: resolution order, C2-1) | 3B |
| C-8 | 3F doesn't fix S8 | Applied with A-2; variants carry credits | 3F |
| C-9 | No prefix matching for S4 | Applied | 3C |
| C-10 | SC4 suite not pass/fail | Applied: fixed counts, exact `interpreted` JSON, guard and intent rules | §4 |
| C-11 | Workload: zero arrays, "light" undefined | Applied: zero → NULL; light = 10 h | 3H |
| C-12 | S/U semantics | Applied; registrar question to Phase 4 | 3H, §10 |
| C-13 | Level phrase patterns and negation | Applied | 3D, §4 |
| C-14 | Spaced and partial codes | Applied (round 2: guarded join, C2-2) | 3B |
| C-15 | Fixture lacks the 3H fields | Applied | 3H |

### Round 2 (r2, PR #27 head 52fb808)

| # | Objection (short) | Disposition | Where |
|---|---|---|---|
| A2-1 | Mapping pastes exceed the 200-char limit; can't be pooled | Applied: out of Phase 3 (Phase 4, P1); deep pool and its 400 pairs dropped; reported as a count outside both sets | §1, P-4, §6, §7 |
| A2-2 | New gate rules exist only in prose | Applied: P-5b adds `--gate sc5` on the holdout, kinds `no-loss` and `answerable-floor`, and the no-answer set by tag. 3H takes a look, so its kind serves the dev screen only | §1, §3 P-5b, §9 |
| A2-3 | 3H will almost surely take a reserve look | Applied (lead's choice of A2-3's options): 3H takes L7 outright; the count trigger and custodian count are dropped | 3H, §3, §9 |
| A2-4 | L7 (3F) can't fail the holdout rule | Applied: identity with the group-first projection + dev `no-loss`; no look | 3F, §3, §9 |
| A2-5 | Partial-code rule vs 3F collapse | Applied: counted in distinct groups; variants cover the rest | §4 |
| A2-6 | Bundles never pooled; 3D grid lacks α = 0 with rules | Applied: each bundle pooled as one extra run; α = 0 added | §3, 3B, 3D, §6 |
| A2-7 | No fallback if 3B fails | Applied in part (dissent 2): a fallback per SC4-required change; dropping one goes to Jacob | §3, 3B–3H, §10 Q4 |
| A2-8 | w_c untunable on dev | Applied: w_c = 1 at P-6; 8-point grid; SC4 mixed-query rule | 3B, 3E, §4 |
| A2-9 | τ fixed late with holdout exposure; tie rule contradictory | Applied: candidate rule fixed at P-6; population by tag; custodian count = 0; one selection rule | 3G, §9 |
| A2-10 | "Holdout reported as secondary" is an unbudgeted look | Applied: dropped from Q1 and §5 | §5, §10 Q1 |
| A2-11 | Listing unscored queries prints holdout ids | Applied: ids on dev only; counts elsewhere | §3 P-5b, §9 |
| A2-12 | `prereq=none` empties d-011 | Applied: two semantics, both pooled, stated selection rule | 3H, §4 |
| A2-13 | Stale: PR #28 merged; group-aware baseline exists | Applied in part (dissent 3): P-1 done; branch rebased; baseline cited as "under qrels-v2, to be measured" | §1, §3 |
| B2-1 | Runbook verify always fails; delete and upsert wipe the standby | Applied: verify split; D1-only delete in step 3, `deleteByIds` in step 7; full `storedVectorMetadata` | 3-0 runbook |
| B2-2 | `/admin/hashes` exists and 404s in prod; fixture leak via dev | Applied: guard and admin calls via `wrangler dev --remote`; values from the asset in the POST body; no prod secret; "new" struck | 3-0 guard, runbook, §7 |
| B2-3 | Step 3-0.0 can't produce a warm p67; formula omits fts | Applied: Phase 1 spans + ≤ 12-query burst; per-sample projection with max(); Q3 conditional | §1, 3-0.0, §6, §10 Q3 |
| B2-4 | CI and SC4 mix catalogues | Applied: pinned bundle for CI and SC4, production bundle for deploys only | 3-0 bundles, §4 |
| B2-5 | Eval and production key vectors differently | Applied: keyed builder with shared-text expansion and a row-count assertion | 3-0 bundles |
| B2-6 | Hand-bumped `rv`; `DENSE_BACKEND` flip unkeyed | Applied: key on `CF_VERSION_METADATA.id`; SC7 checks `x-app-version` | 3-0 cache key |
| B2-7 | TTFB guard measures connection setup | Applied (lead's choice): rely on the startup gate; report true TTFB against the 3-0.0 baseline; no threshold | 3-0 startup gate, 3-0.0, §8 |
| B2-8 | Binding limit becomes CPU | Applied: measure `CPUTimeMs` on the 3-0 smoke; README names the smaller | 3-0 CPU, §6, §8 |
| B2-9 | §6 undercounts deploys | Applied: 11 planned, budgeted at 13 | §6 |
| B2-10 | Row ingest doesn't reach Vectorize metadata | Applied: step 7 upserts on row-only changes too | 3-0 runbook, 3H |
| C2-1 | `XX N000` collides with 36 offered codes | Applied: resolution order; GEA1000 and GEQ1000 in SC4 | 3B, §4 |
| C2-2 | Spaced-code join turns words into codes | Applied: 1–3-digit join guarded by collision and stopword lists; both texts as guards | 3B, §4 |
| C2-3 | GE restriction after fusion leaves short pages | Applied: pre-retrieval pillar mask; SC4 count rule | 3B, §4 |
| C2-4 | SC4 typo rule likely fails under 3C-1; parse order undefined | Applied: only SC4-passing variants eligible; intents after correction; T fixed at P-6 | 3C, §4 |
| C2-5 | Transpositions cost 2 | Applied: OSA distance | 3C |
| C2-6 | Phrase gaps and overlaps | Applied: longest phrase wins; new patterns; `level 1000` resolved to level N | 3D, 3H, §4 |
| C2-7 | Collision list by df covers 93/304 prefixes | Applied: committed word list; pillar prefixes exempt | 3B |
| C2-8 | AI guard penalises correct answers | Applied: collision tokens guarded by no route + `interpreted` only | §4 |
| C2-9 | Partial-code route needs dense order | Applied: code order in lexical mode and fallback, with a test | 3B |
| C2-10 | τ rule contradicts itself | Applied with A2-9; prefix test only for ≥ 4 letters | 3G |

### Dissent and partial application
1. **B-8, "delay step 5 until smoke passes"** (round 1, applied in part). B-2's guard needs D1's
   text hashes to match the manifest *before* the deploy, so the D1 write cannot wait for the
   smoke. It runs before the deploy, behind a Time Travel bookmark, and is restored from it if
   the smoke fails. Every Vectorize write waits for the smoke, as B-8 asks, and since B2-1 that
   includes deletions. B-8's intent, that a bad deploy can be undone with nothing lost, holds.
2. **A2-7, a fallback per SC4-required change** (applied in part). Every one has a
   pre-registered fallback, but in some cases it coincides with the candidate or does not exist:
   - 3B's is "without `stopwords-v2`". When `stopwords-v2` already failed dev, L3 carries 3B
     alone and the fallback is the same change;
   - 3C's is the other variant, which may fail the SC4 typo rule and so be ineligible;
   - 3D's is the rules with α = 0 and no β, the same change if that point was selected;
   - 3G's is the next τ candidate, which may not pass on dev.

   In each case a failure goes straight to Jacob (Q4). Writing extra variants now would add
   designs no critic has reviewed.
3. **A2-13, the group-aware baseline on `docs/phase2-baseline`** (applied in part). r3 does not
   cite that table: it is scored under `qrels-dev-v1`, which scores d-087 to d-092 as no-answer.
   P-0a supersedes it, and P-4 measures the baseline r3 gates on.

### Decisions beyond a critic's text
Recorded so they can be challenged:
- **3H drops the custodian count entirely** (A2-3). With a full look, the holdout rule reads 3H's
  effect directly. The property the count (b) guarded, that queries with no intent keep their
  top 10, moves to dev, where no custody is needed.
- **3F's identity is defined** as the collapsed list equals the group-first projection of the
  uncollapsed list, fetched deep enough to fill the page (A2-4 names the check, not its depth).
- **τ candidates** are the gibberish set's 90th and 95th percentiles and its maximum. A2-9 names
  quantiles, not which.
- **T, the typo threshold**, is the smallest oracle overlap over the 6 dev typo pairs, capped at
  7 (C2-4 says "from dev typo pairs", not how).
- **M = 3** for the mixed-query rule (A2-8 leaves N open). Proposed; fixed at P-6.
- **Prereq selection** is mean ΔnDCG@10 over dev queries with a parsed prereq intent, ties to
  (i) (A2-12 asks for a stated rule).
- **`level 1000`, `1000 level`, `1k`** read as level N = 1, not beginner (C2-6 asks for a
  precedence, not which).
- From round 1, still standing: `no background` sets both the beginner intent and
  `prereq=none`, each echoed and undoable; "light" = 10 h; the raw-vs-stripped margin 0.05; the
  gibberish threshold 90%. Each is fixed at P-6.
