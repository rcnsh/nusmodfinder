# Phase 3 plan: search that understands students (converged r3.1, 3 critic rounds)

Decision record: [ADR 0006](../decisions/0006-phase3-search-quality-plan.md). It is accepted,
pending Jacob's answers to Q1–Q4 (§10).

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

r3.1 is the final draft. It applies every round-3 objection (§11) and the lead's round-3
dispositions; no critic pass follows it. The changes from r3:
- P-5b builds a custodian-only `eval:count` and amends ADR 0003, so a count is not a look. 3G's
  dev gate gains two conditions, and its τ is derived and gated on separate halves of the
  gibberish set;
- each holdout look's baseline is stored and judged, and the verdict comes from `eval:report`;
- the 3-0 runbook merges the manifest and an offline data version before D1 is written, names
  the D1-only ingest mode, and has step 8 upsert every code and wait for the mutation;
- the cache key carries the new intent parameters and `ignore`;
- code joins need a real code or a non-colliding prefix, and 3H phrases match before any join;
- year phrases set a level window, N ≤ level ≤ 4;
- the SC4 partial-code items run at topK = 50, and the suite grows to 90 queries;
- 3H's dev screen exempts queries whose only relevant documents fail the parsed constraint.
- P-0a and P-4 are done (PR #30), so §1 cites the measured dev baseline.

## 1. Facts gathered
- **Dev baseline** (`EVAL.md`, PR #30, `846fac2`), under `qrels-dev-v2` and groups-v1: `eval-v0`
  hybrid nDCG@10 **0.712** [0.644, 0.770], P@5 0.571 [0.494, 0.641], MRR@10 0.820, over **83**
  primary answerable queries, with 10 no-answer and 5 feature-gap. The weakest shapes are
  `code-partial` 0.000 (n = 3), `code-space` 0.210 (n = 3) and `ge` 0.402. The qrels-v1 figures
  and the groups-v1 table on `docs/phase2-baseline` are superseded.
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
    P-0a graded their targets by rule from the corpus, so under `qrels-dev-v2` they are
    answerable and 10 dev queries remain no-answer.
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
  - The CLI has three commands: `run`, `report` and `pool` (`package.json`, `eval/cli.mjs`).
    No count-only tool exists yet.
  - The ledger counts every table row, and a row whose set cell names no known set counts against
    every set, the test set included (`eval/lib/ledger.mjs:7–9`). ADR 0003 defines a look as
    "any run or report that prints a verdict" (`0003:89`, `:177`).
  - `run` on an encrypted set reserves a look before retrieval, and the reserved row counts even
    if the run turns out unjudged. `report` records a look only once both runs are fully judged
    (`eval/cli.mjs:184–226`, `:246–257`). `judgedCheck` needs judged@10 = 100% for the baseline
    as well as the candidate (`eval/lib/gate.mjs:89–96`).
  - Only `eval-v0`'s run is stored on the holdout.
- **SC7 FAIL** (`docs/evidence/phase1/sc7.md`): pooled p50 351 ms.
  - Warm SIN cache-miss spans (30 samples, `sc7-samples.jsonl`): p50 `vector` 232, `embed` 88,
    `fts` 19, `hydrate` 13, `cache` 8. `embed` p67 is 99.
  - `embed`→`vector` runs alongside `fts`, so `total` ≈ cache + max(embed + vector, fts) +
    hydrate.
  - With exact search in place of `vector` (~5 ms, *est.*), the per-sample projection
    cache + max(embed + 5, fts) + hydrate over those 30 samples has a p67 of **138.7 ms** by
    linear interpolation, and a p69 of 148 ms (recomputed from `sc7-samples.jsonl`; critic B's
    figures, re-run by step 3-0.0). Summing the spans' separate p67s gives 128 and understates
    it.
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
    - `topK` defaults to 20 and is clamped to 50 (`DEFAULT_TOPK`, `MAX_TOPK`, `:29–30`);
    - pin: only when the whole query matches `MODULE_CODE_RE`;
    - dense: Vectorize is asked for ids only, so its cosine scores are thrown away;
    - cache: the key holds `q`, `DATA_VERSION` and the parsed `sem`, `level`, `credits`,
      `faculty`, `ng`, `mode` and `topK` (`canonicalCacheKey`, `:167–176`), with a TTL of
      3600 s (`:37`). So a ranker-only deploy serves old rankings for up to an hour.
      `parseSearch` ignores unknown parameters (`:115`), so a new parameter left out of the key
      shares the cache entry of the request without it;
    - timing: workerd's clock advances only across I/O, so a CPU-only span such as an in-Worker
      dot product reads ~0.
  - `src/index.js:93` sets `x-app-version` on every response from `CF_VERSION_METADATA`
    (`src/http.js:30–33`: the version tag, else its id).
  - Admin routes (`src/index.js:43–48`): `/admin/hashes` already exists (`src/ingest.js:128`).
    Every admin route returns 404 unless `INGEST_SECRET` is bound (`src/ingest.js:29–34`).
    Production binds none, by design; ingest and verify run against `wrangler dev --remote` with a
    local secret (README, `scripts/verify.mjs`).
  - `/health` touches no binding (`src/index.js:15`), so a probe of it costs no D1 read.
  - `/admin/ingest` always reads stored vectors (`getByIds`), embeds what it can't reuse
    (`AI.run`) and upserts to Vectorize, all before it writes D1 (`src/ingest.js:186–229`).
    `ingest-core` writes `src/data-version.json` only after it has waited for the last Vectorize
    mutation (`scripts/ingest-core.mjs:490–515`, `waitForMutation` at `:571`). So no D1-only
    ingest exists today.
  - `/admin/delete` clears the D1 hashes, calls Vectorize `deleteByIds`, then deletes the D1 rows
    (`src/ingest.js:285–305`).
  - The data version is the first 12 hex digits of sha256 over the sorted (code, `row_hash`)
    lines (`dataVersion`, `src/rowhash.js:146–149`), so it can be computed offline from the rows
    ingest will write.
  - `npm run deploy` refuses a dirty tree and a HEAD that is not on `origin/main`
    (`scripts/deploy.mjs:51–76`). Whatever a deploy needs must be merged first.
  - Verify compares each sampled Vectorize vector's metadata, `textHash` included, against D1
    (`src/ingest.js:385–394`, `scripts/verify-core.mjs:51`), and lists the index's ids, so it
    sees a deletion only after Vectorize has processed it. A Vectorize upsert replaces the whole
    record, so an upsert of `{id, values}` alone wipes the filter metadata
    (`storedVectorMetadata`, `src/rowhash.js:53–77`). That metadata holds semesters, level,
    credits, faculty, NG and `textHash` only (`vectorMetadata`, `:53–65`): no prefix, group or 3H
    field.
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
      IT 18, PR 79, JS 24, GE 62, MA 110, EE 123, CE 144, LL 386. IS 57, ME 106 and AN 17 are
      prefixes too. So are SE 28, PE 25 and LAB 5, and DSA has 55 modules (statistics, not
      CS2040's "data structures and algorithms").
    - GEA has 2 offered modules (one group), CS101 7 (one group), DAO17 2, MUL21 4. CS32 has 30
      members in 27 groups, GEC 36 in 35 and GEX 16 in 14. At the default topK of 20, a page
      cannot hold every CS32 or GEC group.
    - 90 pairs of prefixes have one as the start of the other (CS/CSA, SE/SEA, PH/PHS,
      LA/LAJ, …). A range
      `code >= 'CS' AND code < 'CT'` returns CSA6101 and CSA6770. Digits follow the letters in
      every code, so `code >= 'CS0' AND code < 'CS:'` returns CS codes only.
    - `comp`, `math`, `econ` are not NUS prefixes.
    - 36 offered codes have the shape `XX N000` (GEA1000, GEA1000N, GEI1000, GEN2000, GESS1000,
      GEX1000, ES1000, ME3000, IS6000, BI3000, …), and 50 more are catalogue-only (GEQ1000).
      ME3000 and IS6000 make `give me 3000 level electives` and `what is 6000 level` join into
      offered codes unless the join is guarded.
    - 22 codes exist both with and without a trailing S (CS1231 and CS1231S), so `cs1231 s/u`
      must not join into `cs1231s`. CS1231 is S/U-able.
    - CS4400 (d-016 `CS 4400 Operating Systems`) is neither offered nor in the catalogue.
    - "Every prefix that is a df > 0 token" would cover 93 of 304 prefixes, CS, GEN, GET and GEX
      among them.
  - GE inside longer queries: the pillar members left in r2's fused top 10 are d-078 2 (of 69
    eligible), d-079 5 (of 48), d-062 9, d-022 10.
  - Catalogue: 14,359 catalogue codes are not offered this year (e.g. GEQ1000, GEH1001, IS1103).
  - Prerequisites: 4,180 of 6,771 offered modules have no prerequisite field. All 5 relevant
    modules of d-011 (`intro accounting no prerequisites`) have one:
    - ACC1701XA and ACC1701XC carry only a cohort restriction;
    - ACC2706 and FIN2704X need EC2204 or ACC1701;
    - QF1100 needs A-level mathematics.

    So semantics (ii) (NULL or cohort-only) keeps 2 of d-011's 5, and semantics (i)
    (`prerequisite IS NULL`) keeps none: it excludes every level-1/2 accounting module but
    LC2018. d-099 (`intro accunting no prerqeuisites`) has one relevant module, QF1100, which
    fails both semantics, so 3H loses d-099 by construction. `prerequisite IS NULL` loses 3 of
    d-023's 17.
  - Workload: 259 modules have an all-zero workload array. 4,614 of 5,081 4-MC modules list 10
    h a week.
  - S/U and grading: `attributes.su` is set on 933 modules (levels 1–4). 648 are graded CS/CU
    (1 of them also `su`). `grsu` is set on 410 (levels 5–6).
  - Exams: 35 modules have an `examDate` in some offered semesters and not others.
  - Words: "final" has df 171 (Final Year Project).
  - Groups and credits: of the exact title+description groups, 37 mix credits (AR4421 8 MC,
    AR4421A 12 MC). 270 same-title groups have different descriptions.
  - 9 of the 98 dev queries carry a 3H phrase.
  - Year wording: d-064 (`biochemistry suitable for 3rd year students, not first year basics`)
    has grade-2 answers at level 4 (LSM4231, CM4236), so a hard level = 3 caps its nDCG@10 at
    0.189. d-045 asks for "third year level" and "3000-level equivalent" in one query.
  - Typos: d-095 (`microbbiology bacteia`) has two df-0 tokens with no prefix match, and three
    grade-1 answers (ESE3301, LSM2291, LSM3242).
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
    is also the pre-3-0 TTFB baseline.
  - **Colo rule (B3-2).** The collector first probes `/health` (no binding touched) on a
    keep-alive connection, at most 20 times, until `cf-ray` ends in `SIN`. It then sends the
    burst on that connection. Non-SIN samples are reported and left out.
  - Projection, per sample: cache + max(embed + 5, fts, pin) + hydrate, then the p67 over the
    samples, by linear interpolation. Phase 1's set gives 138.7 ms; the burst gives the
    post-APAC figure.
  - If the burst yields fewer than 8 SIN samples, it cannot answer Q3. The step records that,
    and the Phase 1 projection (138.7 ms) stands, so Q3 does not trigger.
  - With ≥ 8 SIN samples, if the burst's projected p67 is above ~200 ms, building 3-0 waits for
    Jacob (§10, Q3).
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
- **Deploy guard (B-2, B2-2, B3-4).**
  - `npm run deploy` downloads the production asset and checks its sha256.
  - It compares `rowsKey` with D1's current (code, `text_hash`) pairs, read from the existing
    `/admin/hashes` route (~6.8k rows read, logged). The deploy script reaches it through a
    local `wrangler dev --remote` session with a local secret. No production secret is ever
    bound, so the deployed Worker's admin routes stay 404.
  - It also requires the manifest's data version to equal `src/data-version.json`, and D1's
    data version, computed from its `row_hash`es, to equal both.
  - Any mismatch refuses the deploy.
  - Because `text_hash` → `row_hash` → data version, D1 must hold the new text hashes before the
    Worker that bundles their vectors deploys. `npm run deploy` deploys only merged commits
    (§1), so the manifest and data version merge first, and the guard refuses that commit until
    D1 has caught up. Hence the order below.
- **Ingest and re-embed runbook (B-2, B-3, B-8, B-10, B2-1, B2-2, B2-10, B3-3, B3-4, B3-5).**
  One order for every corpus change: a catalogue update, 3A-2's re-embedding, or 3H's row
  change. Every admin call goes through `wrangler dev --remote`.
  1. Build the production vectors asset (reuse by key, embed only missing texts) and publish it.
     Compute the data version **offline**: `normalise` → `rowHash` → `dataVersion` over the rows
     ingest will write, the same functions ingest uses. Write the manifest and
     `src/data-version.json` on a branch, with any code change the corpus change needs.
  2. Merge that PR. Nothing deploys: the guard refuses the merged commit while D1 still holds
     the old rows, so no deploy from `main` can go out until step 4 has run. Every deploy in the
     meantime waits.
  3. Record a D1 Time Travel bookmark in `remote-ops.md`.
  4. Write D1 only, with the **D1-only mode** that 3-0 adds (B3-5):
     - `/admin/ingest?d1Only=1` writes text and row hashes, new rows and fields. It makes no
       `getByIds`, `AI.run` or Vectorize call; the vectors come from the asset in step 8.
     - `ingest-core --d1-only` skips the mutation wait and checks the data version it computes
       against the committed `src/data-version.json` instead of writing it. A mismatch stops
       the run before step 5.
     - `/admin/delete?d1Only=1` deletes the rows and returns their codes for step 8, with no
       `deleteByIds`.
     - Tests: in D1-only mode neither route touches the AI or Vectorize fakes.
  5. `npm run verify -- --pre-deploy`: D1's (code, `text_hash`) pairs equal the manifest's
     `rowsKey`, D1's data version equals the committed one, and the bundle's codes and filter
     table equal D1's fields. It reads no Vectorize.
  6. The deploy guard, `versions upload`, the startup gate and `versions deploy`.
  7. Smoke (≤ 4 calls). If it fails, roll back (below) and stop.
  8. Bring the Vectorize standby level. `/admin/vectors` (new) upserts
     `{id, values, metadata: storedVectorMetadata(row)}` for **every code** in D1, in batches of
     at most 1,000, and returns each batch's `mutationId`. Nothing tracks which rows changed, so
     upserting all of them is the only complete rule, and it costs no D1 write and no neuron
     (B3-3). The metadata comes from the D1 row, with the new `textHash`. The values come in the
     POST body, read by the script from the sha-checked asset, never from the dev session's
     bundle, which is the fixture by default. Then `deleteByIds` for step 4's deletions. The
     script waits for the last mutation with ingest-core's `waitForMutation`, then runs
     `npm run verify` (today's check, Vectorize metadata against D1, and the id list) and a
     `getByIds` sample against the asset's bits.
  - Every remote D1 operation is estimated and logged in `remote-ops.md`, **reads included**
    (B-10).
  - Between steps 4 and 6 (minutes: the merge is already done), the live Worker runs its old
    bundle against the new D1. Old vectors can still return a code that changed. So after
    hydrate, `localMatchesFilters`, extended with the 3H fields, runs on every dense row against
    the fresh D1 row and drops rows that fail (B-3). A test covers this. Rows missing from D1
    are dropped at hydrate, as stale Vectorize ids are today.
- **Vectorize stays, off the search path, as an identical cold standby (B-1).**
  - Cutover: today's production vectors came from ingest batches of 50 that differ from the
    bundle. At the 3-0 cutover, step 8 upserts all 6,778 bundle vectors with their full metadata,
    as it does on every run: 0 D1 writes, 0 neurons, stored dims unchanged at ~2.6M of 10M.
  - From then on, runbook step 8 keeps the standby equal to the bundle.
  - The flip: `DENSE_BACKEND=vectorize`, a var flipped by a deploy, restores today's dense path.
    Between steps 6 and 8 the standby holds the previous vectors, so the flip is not used in that
    window.
  - **What the flip serves (B3-6).** It swaps only the dense retriever. The filter table and
    group ids still come from the bundle, so the 3F collapse works. Vectorize metadata has no
    prefix, group or 3H field, and an index allows at most 10 metadata indexes, so under the
    flip:
    - whole-query masks (partial code, pillar, `XX N000`) list their members in code order, as
      in `mode=lexical`;
    - the GE mask inside a longer query keeps its SQL prefix ranges on the FTS side, and the
      dense rows are filtered to pillar members after hydrate;
    - 3H's constraints run on every dense row after hydrate, through the extended
      `localMatchesFilters`.

    One test runs the masked routes and a 3H query under the flip. The flip is degraded service:
    SC4 is not claimed under it.
  - The brief forbids deleting or recreating the index. Keeping it costs nothing material.
  - When the bundle is missing or corrupt, or Workers AI fails, the fallback stays keyword-only
    (B6), with `degraded.source` `dense-index` or `workers-ai`. SC7's Vectorize-failure case
    becomes moot and is reported that way.
  - Vectorize queried dims drop to ~0 per search.
- **Response cache key (B-7, A-N5, B2-6, B3-1).** `canonicalCacheKey` adds
  `v=<CF_VERSION_METADATA.id>`. Every deploy gets a new version id, whether it changes the ranker,
  the vectors or `DENSE_BACKEND`, so no hand-bumped constant can be forgotten. SC7 collection
  rejects any sample whose `x-app-version` differs from the frozen deploy's.
  - Every new parameter joins the key in parsed form, in the PR that adds it: `exam`, `su`,
    `hoursBelow` and `prereq` (3H), and `ignore` as a sorted, de-duplicated, comma-joined list of
    intent names (3B, 3D, 3H). Otherwise `ignore=level` would serve the cached page with the
    level intent applied, for up to the 3600 s TTL.
  - Each parameter gets its own test beside the B7 key tests
    (`test/findings/backend.test.js:303–307`): a request with it has a different key from one
    without, and `ignore=su,level` and `ignore=level,su` share one key.
  - Intents parsed from `q` need no key entry: `q` is in the key.
- **Rollback (B-8).**
  - Every deploy's version id goes into `remote-ops.md`.
  - Rollback is `wrangler rollback <id>` to the previous recorded version. The floor is the
    version built from `597c2b7`: older versions are bound to the deleted WEUR database
    (ADR 0005).
  - If D1 changed in runbook step 4, restore it to the step-3 bookmark (a logged remote D1
    operation), and revert step 2's merge so `main` matches D1 again. Vectorize needs nothing:
    step 8 has not run, and step 4 does not touch it.
- **Touches** `src/search.js` (`denseSearch`, the cache key), `src/ingest.js` (D1-only modes,
  `/admin/vectors`), `scripts/ingest-core.mjs` (`--d1-only`), `scripts/vectors.mjs` (new),
  `scripts/verify.mjs` (`--pre-deploy`), `scripts/deploy.mjs` (guard, startup gate),
  `wrangler.jsonc` (alias, `DENSE_BACKEND`), `test/fixtures/vectors.bin` and `data/vectors.json`.
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
  to 138.7 ms warm (p67) and 148 ms (p69); 3-0.0 adds the post-APAC figure. Sparse, with the
  APAC primary: cache 25 + embed 227 + 5 + hydrate ~40 ≈ 300 ms.
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
  3. The runbook above, steps 1–8. Steps 1–2 merge the new `embeddingText`, the manifest and
     the offline data version in one PR. Step 1 reuses the eval's vectors by key and embeds only
     the texts the pinned corpus lacks (*est.* ≤ 400 texts, ≤ 300 neurons). Step 4 rewrites
     every `text_hash`: no Workers AI call, and no FTS writes, since title and description are
     unchanged. *est.* ~35k rows written (5.2 per module, Phase 1 small batch). Step 8 upserts
     the new vectors in place, with no parallel index.
- A 768-d model would fit Paid's 10M stored dims, but it doubles the bundle and adds embed time.
  Not planned.

### 3B Codes, GE pillars, keyword brittleness (S5, S4)
- **3B-0 corpus data**, committed with the script that builds it:
  - the prefix list: letter parts of offered codes, with counts;
  - the **collision list** (C-2, C2-7, C3-5): a committed list of English words and common
    abbreviations that are also prefixes, starting from AI, IT, PR, JS, GE, MA, EE, CE, LL, IS,
    ME, AN, and the NUS-ambiguous DSA, SE, PE and LAB. It is a written list, not "every prefix
    with df > 0". Pillar prefixes are exempt, so a bare `GEX` routes to its pillar;
  - the catalogue-only code list (C-7);
  - the GE pillar table: pillar names → {GEA, GEC, GEH, GEI, GEN, GEQ, GES, GESS, GET, GEX},
    with the NUS GE page URL in the file.

  The step re-runs critic C's counts and commits them as evidence.
- **Parse order** (one order for every query, in `src/query-intent.js`):
  1. canonical q (today's `canonicalQuery`);
  2. 3G's vocabulary test reads the pre-correction tokens (it decides only at the end);
  3. 3C's correction of df-0 letter-only tokens of ≥ 5 letters. Known prefixes have 2–4
     letters, so it never touches a code's letters;
  4. **3H phrases**, matched and stripped from the lexical query before any join (C3-1), so
     `s/u` can never feed a suffix join;
  5. the code joins below;
  6. code resolution;
  7. 3D's level phrases.
- **Code joins (C-14, C2-2, C3-1)**, on the canonical q with step 4's phrases removed; "the
  whole query" below means that remainder. A join is made only when its result is usable:
  - **Letters on the collision or stopword list** join only when letters + digits (+ suffix)
    are the whole query **and** the joined code is offered or catalogue-only (`is 4246` →
    IS4246, pinned; `me 3000` → ME3000). Inside a longer query they never join, and they never
    reach resolution step 3. So `give me 3000 level electives` stays a level-3 query and does not
    pin ME3000, `show me 4000 level courses` is level 4 with no ME route, and `what is 2000
    level` and `is it 3000 level` route nothing but their level.
  - **Other known prefixes**: letters + space + 4 digits join (`cs 1010s` → `cs1010s`, `cs 3000`
    → `cs3000`); letters + space + 1–3 digits join (`cs 32` → `cs32`, `cs 101` → `cs101`).
  - So `give me 2 easy electives` never becomes `me2`, and `how many units is 3 US credits` never
    becomes `is3`. Critic B's arithmetic shows why the guard matters: at w_c = 2, k = 20, a code
    list's rank 1 scores 2/21, the same as rank 1 in both other lists.
  - **Suffix join**: code + space + 1–2 letters joins only when the joined code is offered or
    catalogue-only, and never when `/` or `-` follows the letters (`cs1010 s` → `cs1010s`).
    `cs2040 or cs2030` keeps both codes, and `cs1231 s/u` pins CS1231 with `su=1`.
  - A cost the rule accepts: a collision-list code inside a longer query (`is 4246 workload`)
    is not pinned. It still reaches the lexical and dense halves as text.
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
    3. it has the shape `XX N000`, with `XX` a known prefix off the collision and stopword lists
       → level = N
       (3D) and the `XX` prefix route (`cs 3000`). As the whole query it is a hard mask, prefix
       ∩ level, ordered by exact dense score; inside a longer query the level is a filter and
       the prefix members form the third RRF list (C3-7). `lvl 3000` is a 3D phrase, not a code:
       `lvl` is no prefix;
    4. otherwise, as a whole query → `count: 0`, `noMatch: { reason: "unknown-code" }`. The eval
       scores non-existent codes as correct-empty.

    **Inside a longer query (C3-6)**, a catalogue-only or unknown code routes nothing: no pin,
    no prefix list, no `noMatch`. Its original tokens stay in the query text. So d-016
    (`CS 4400 Operating Systems`) is a topical query and can still return CS2106.
- **Partial codes and GE pillars (C-1, C-2, C2-3, C2-9)**:
  - **Whole-query partial code** (`[a-z]{2,4}\d{0,3}`, known prefix, the whole query, e.g.
    `CS32`, `GEA`, `cs101`): a **hard candidate mask**. A PK range scan reads ≈ the rows it
    returns. For a partial code P the range runs from P (P + `0` when P is letters only) up
    to, not including, P + `:`, where `:` is the character after `9`. Every code has
    digits after its letters, so a bare prefix never takes in a longer one (C3-4): `cs` →
    `code >= 'CS0' AND code < 'CS:'`, which excludes CSA6101; `cs32` → `code >= 'CS32' AND code
    < 'CS32:'`. A test checks that `cs` returns no CSA code and `ges` no GESS code. The members are ordered by exact dense score (3-0). Lexical and RRF
    play no part. In `mode=lexical` and in the keyword-only fallback the members are in code
    order (C2-9), with a test.
  - **A code token inside a longer query** (`cs32 machine learning`): the prefix members become a
    **third RRF list**, ordered by exact dense score (C3-7), with weight w_c = 1 (fixed at P-6,
    A2-8).
  - **Letter-only tokens:**
    - A letter-only token never prefix-routes inside a multi-token query.
    - As a whole query, it routes only when it is a known prefix and is not on the collision
      list. So `AI`, `js`, `pr` and `dsa` are topical queries.
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
- **Intent rules, per direction (C-6, C-13, C2-6, C3-2)**, from the parser in
  `src/query-intent.js`. The phrase lists are pre-registered. **The longest matching phrase
  wins**; a phrase inside a longer match is not read on its own.

  | intent | phrases (examples) | effect |
  |---|---|---|
  | beginner | `intro`, `introductory`, `beginner(s)`, `for beginners`, `no background`, `first year`, `1st year` | **hard exclusion of level ≥ 5** (the year window with N = 1); soft prior α favours levels 1–2 over 3–4 |
  | graduate | `graduate`, `postgraduate`, `masters`, `phd` | hard filter level ≥ 5 |
  | level N | `level N000`, `lvl N000`, `N000 level`, `N000-level`, `Nk`, `XX N000` (after the code order in 3B) | hard filter level = N (as the `level` param) |
  | year N | `2nd`/`3rd`/`4th year`, `second`–`fourth year`, `year N` | **hard window N ≤ level ≤ 4** |
  | none | `advanced` alone (`advanced calculus` keeps MA2311), any phrase negated by `not`/`non`/`except`/`beyond` within the two preceding tokens (`not first year basics`) | no level intent; the phrase stays in the query text |

  - **Year phrases are a window, not a level (C3-2).** A student in their third year takes
    level-3 and level-4 modules, and d-064's grade-2 answers are level 4. `level N000`,
    `N000 level` and `Nk` name a level, so they stay exact.
  - `level 1000`, `1000 level` and `1k` are level N = 1, not beginner: r2 listed them under both.
    Level = 1 already excludes level ≥ 5.
  - **Several level phrases in one query** take the union of their ranges, and α applies when
    beginner is among them. So d-045 (`third year level` and `3000-level`) gets levels 3–4.
  - The window is internal: it has no URL parameter. `interpreted.level` echoes it as
    `{ min, max, source }`.
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
  - Round 1 pools the 4 α points and the 3 β points (7 runs). α* and β* are selected from it.
  - The bundle rules + α* + β* exists only once both are known, so a second, dev-only round
    pools it as one run (A2-6, A3-5). It is pooled only if β* passed dev alone.
  - Fallback (A2-7): the rules with α = 0 and no β. One look (L5).

### 3E RRF weighting (S2)
- Weighted RRF in `fuse()`: w_v/(k + r_v) + w_l/(k + r_l) (+ w_c/(k + r_c) for the 3B code
  list). The hash tiebreak becomes: best single-list rank, then dense rank, then code.
- Pre-declared grid:
  - w_v/w_l ∈ {1, 1.25, 1.5, 2} (w_l = 1);
  - k ∈ {20, 60};
  - **w_c = 1, fixed at P-6** (A2-8). Dev has no multi-word query with a known-prefix code token
    except d-025, so dev cannot tune it. The SC4 mixed-query rule (§4) checks it instead.

  That is 8 points, tuned **after** 3A and 3D, which shift the lists' relative quality. The
  point (1, 60) uses the new tiebreak, so it is not the shipped ranker either (A3-5): all 8 are
  new runs, pooled in one round before selection.
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
- **The gibberish set** is `eval/dev/gibberish.json`: ≥ 40 strings written before any 3G code
  (keyboard mash, filler, out-of-vocabulary slang, and mixed tokens like d-025), disjoint from
  SC4. P-6 splits it, by a recorded seed, into a **derivation half** and a **gate half** of
  ≥ 20 each (A3-6). τ is derived on one half and gated on the other, so the gate cannot pass by
  construction.
- **τ (A2-9, C2-10, A3-6).**
  - The rule that maps 3G-1's distribution to candidates is fixed at P-6. Step 3G-1 measures the
    top-1 cosine on both halves and on the dev queries **not tagged** no-answer; it reads tags,
    never relevance labels.
  - Candidates: the derivation half's top-1 cosine at its 90th and 95th percentiles by
    **nearest rank** (the ⌈p·n⌉-th smallest value) and its maximum, each + 1e-6, as distinct
    values.
  - **Selection: the largest candidate that passes every dev condition below.** The candidates
    are distinct, so the rule has no ties.
  - Fallback (A2-7): the next smaller candidate that passes on dev.
- **Gate, no holdout look** (A-1, C-3, A2-9, A3-1, A3-2; ADR 0003 amendment, §9). 3G passes iff
  all hold:
  - **the SC4 suite is green** with 3G in place, typo items included. Items owned by a
    workstream that has not merged yet, or that Jacob dropped (Q4), are listed and skipped;
    the typo, gibberish, non-existent-code and guard items are never skipped (A3-2);
  - ≥ 90% of the **gate half** returns `count: 0` (threshold fixed at P-6);
  - **no dev query outside the no-answer tags returns `noMatch.reason` `no-signal`** (A3-2).
    The report lists any such id; dev is open. This stops 3G emptying an answerable typo query
    such as d-095, which the −0.01 floor alone would allow: dev has 83 primary answerable queries,
    so the floor tolerates a summed nDCG@10 loss of 0.83;
  - dev answerable ΔnDCG@10 ≥ −0.01, with the no-answer set fixed by tag (change kind
    `answerable-floor`, P-5b);
  - the **custodian's count** of holdout queries not tagged no-answer that the selected τ
    empties is 0. The custodian stores the candidate with `--holdout --store-only` and runs
    `npm run eval:count -- --holdout --emptied-untagged --run <candidate>` (P-5b). It prints one
    integer and logs the call in `eval/count-log.md`, not in the ledger, so it is not a look
    (A3-1). The fallback gets one count of its own.

### 3H No-exam, S/U, workload and prerequisite intents (S7)
- **Data (3H-0, 3H-1).**
  - Migration `0007_intents.sql` adds:
    - `exam_semesters` (JSON: the semesters with an `examDate`) and generated `exam_sem1..4`;
    - `su` (from `attributes.su`) and `grading_basis`;
    - `workload_hours`: the sum of the workload array, NULL when unparseable **or all zero**
      (259 modules, C-11);
    - `prereq_none` (prerequisite IS NULL, C-5) and `prereq_cohort_only` (A2-12): the
      prerequisite text is only a cohort or programme restriction, by a pattern list that P-6
      fixes (A3-7). 3H-0 commits its matches and the count.
  - `normalise()` keeps them, and `NORMALISER_VERSION` is bumped, so every `row_hash` changes.
  - That makes a row-only re-ingest through the runbook: no re-embedding, no FTS writes, *est.*
    ~35–50k rows written, after the headroom check and a bookmark (ADR 0004). Step 1 computes the
    new data version offline under the bumped normaliser. Step 8 re-upserts every code as on
    every run (B3-3). The stored metadata has no 3H field (`vectorMetadata`,
    `src/rowhash.js:53–65`), so the standby gains nothing from 3H, and under the flip the 3H
    constraints run after hydrate (B3-6). It is ranking-neutral, so it can land early.
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
    `interpreted.prereq` names the semantics applied. On d-011, (ii) keeps 2 of its 5 relevant
    modules (ACC1701XA, ACC1701XC) and (i) keeps none; d-099's only relevant module fails both
    (§1).
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
  suite. The primary set holds the prereq queries; the exam queries sit in the constraint block,
  outside it. So L7 measures the prereq intent only, and exam, S/U and workload are checked by
  the SC4 suite alone (A3-7). The dev screen passes iff:
  - the SC4 intent rules pass;
  - dev primary ΔnDCG@10 ≥ 0 (change kind `no-loss`, P-5b; constraint block reported), **over
    the primary set less the constraint-exempt queries** (C3-8, lead decision, §11);
  - on dev, every query with no parsed intent keeps its top 10 unchanged.
- **Constraint-exempt queries (C3-8).** A dev query is exempt iff it parses a 3H intent and
  every one of its grade-≥1 documents fails that constraint under the candidate's semantics.
  The student asked for the constraint, so emptying those answers is the requested behaviour,
  not a loss. The rule is pre-registered at P-6. A committed script computes the list per
  candidate from the qrels version in use, and the dev report prints the exempt ids with their
  Δ. Under both semantics d-099 is exempt, and under (i) d-011 is too. The exemption applies to
  the dev screen only: L7 runs the unchanged holdout rule, where such queries count as loss.
- Pooled runs: (i) and (ii), each stripped and raw: 4. **Fallback (A2-7, A3-7):** the other
  prereq semantics with the same raw/stripped choice, fixed at P-6.

## 3. Measurement and the holdout look plan
- **Before L1.** All of these are done before the first holdout look. The order matters where
  stated.
  - **P-0a. Code-target rule grades: done** (PR #30, `846fac2`). Judge rule 4 in
    `eval/JUDGING.md` grades a code query's target modules from the corpus, mechanically
    (`eval/lib/code-rule.mjs`). It produced `qrels-dev-v2` (56 rule pairs over 11 queries) and
    `qrels-holdout-v2` (15 rule pairs over 4 queries, counts only, no look), and made d-087,
    d-089, d-090, d-091 and d-092 answerable.
  - **P-0b. Gate and custody hardening: done** (PR #32, `66b5cb7`):
    - a cutoff must truncate the baseline;
    - the ledger records the rule applied;
    - the baseline ranker's sha is checked;
    - `--store-only` cannot overwrite a stored run;
    - `--set-dir` is checked against its manifest.
  - **P-1. groups-v1: done** (PR #28, `87107a1`). `eval/groups.json` is the duplicate-group source
    for every set.
  - **P-2. Step 3-0.0: done** (2026-11-06, `docs/evidence/phase3/embed-latency.md`). The
    projected warm p67 is 160.6 ms over 12 SIN samples, so Q3 does not trigger.
  - **P-3. 3-0: done** (PRs #35, #36; live as version `343ea371`, 2026-11-06,
    `docs/evidence/phase3/3-0-cutover.md`). The standby agrees with D1. The shipped-ranker pin
    moves to `e8a7124`. No look.
  - **P-4. The dev baseline: done** (PR #30, `EVAL.md`), under `qrels-dev-v2` and groups-v1
    (§1). r2's deep pool of the four mapping pastes is dropped (A2-1).
  - **P-5. The ADR 0003 and 0004 amendments** merge (§9).
  - **P-5b. Gate code for the new rules (A2-2, A3-1)**, on top of P-0b, each with tests:
    - an SC5 gate selectable on the holdout (`eval:report --gate sc5`), accepted only for the
      L12 look under the holdout reading and recorded in the ledger. Without it, L12 would run
      the per-change point-estimate rule and write a pass;
    - change kinds `no-loss` (Δ ≥ 0 point estimate, for 3F and 3H's dev screen) and
      `answerable-floor` (answerable ΔnDCG@10 ≥ −0.01, for 3G). `no-loss` takes an optional
      `--exempt <file>` of dev ids, refused on encrypted sets; the report prints each exempt id
      and its Δ (3H, C3-8);
    - the no-answer set defined by tag (`noanswer`, `code-nonexistent`, `noAnswerByRule`) in
      `eval/lib/metrics.mjs`. An untagged query with no grade-≥1 document is unscored, in
      neither set;
    - reports list unscored query ids on dev only, and give counts only on the holdout and test
      sets (A2-11);
    - **`eval:count`** (A3-1, A-N9), custodian-only, refused without `--custodian`. It prints
      one integer and nothing else:
      - `--set test --answerable`: the test set's answerable count (§5's stopping rule);
      - `--holdout --emptied-untagged --run <variant>`: how many holdout queries not tagged
        no-answer the stored run returns empty (3G).

      Each call appends a row to `eval/count-log.md` (date, set, kind, run, count), a separate
      committed file the ledger never reads, so a count can never count as a look. Tests: the
      output is a single integer; the tool refuses without `--custodian`, on dev, and with any
      flag that would print ids or metrics; a count-log row cannot be placed in the ledger;
      the ledger's look count is unchanged after a count. **ADR 0003's look definition is
      amended in the same commit**: a count from `eval:count` prints no verdict and is not a
      look, even when a pre-registered gate reads it.
  - **P-6. The pre-registration commit: done** (PR #38, `docs/plans/phase3-prereg.md`; A-N3,
    A-6). It fixes:
    - every grid and finite candidate set: 3A-2 v1–v3, 3C-1/3C-2, α ∈ {0, 0.1, 0.2, 0.35}, β,
      the 8-point 3E grid, w_c = 1, the two prereq semantics, raw/stripped;
    - the selection statistic, the tie-break, and each SC4-required change's fallback, 3H's
      included (the other semantics, same raw/stripped);
    - the stopword list, OSA thresholds, the parse order, the join rules, intent phrase lists and
      precedence (the year window and the union rule included), GE table and collision list;
    - the cohort-only prerequisite pattern list (A3-7) and 3H's constraint-exempt rule (C3-8);
    - "light" = 10 h, the raw/stripped margin, the gibberish set, its seeded split into
      derivation and gate halves, the 90% threshold, and the τ candidate rule with its
      nearest-rank percentile method;
    - the SC4 suite, with its typo threshold T and mixed-query count.
  - **P-7. Jacob answers Q1** (SC5 reading), batched with Q2 (VPN) (§10): **done** (2026-11-06,
    the sealed test set; the VPN is off).
- **Dev is open.** Every candidate runs `npm run eval -- --variant <v> --baseline <shipped>`
  (with `--target-shapes` or `--change-kind` where declared) and must pass the dev screen before
  its look. Every comparison scores both runs under the same, latest qrels version.
- **One pooling round per workstream, before selection (A-6, A2-6).** `eval:pool --runs
  <shipped>,<every candidate> --unjudged` pools the union of every candidate's top-10. Every
  bundle that could go to a look is pooled as one extra run in the same round, except 3D's,
  whose parts are selected first: it gets a second, dev-only round of one run (A3-5).
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
  1. stores the candidate (`--holdout --store-only`, no look), and **the baseline too** unless it
     is already stored and fully judged (A3-4). Only `eval-v0` is stored today, so L1's baseline
     (the 3-0 head) is new. So is L7's: 3F and 3G ship between L6 and L7 without a holdout run.
     After that, a look's baseline is usually the previous look's accepted candidate, already
     stored and judged;
  2. pools every run stored in step 1 encrypted (`eval:pool --holdout --custodian --unjudged`);
  3. judges the pool with in-process subagents and merges. `judgedCheck` needs 100% for both
     runs;
  4. only then runs the verdict with `npm run eval:report -- --holdout --run <candidate>
     --baseline <shipped>`, on the stored runs. `report` writes the ledger row only for a fully
     judged pair, and runs no retrieval, so no look is spent `unjudged` (A3-4). `npm run eval --
     --holdout` is not used for looks: it reserves a row before retrieval.

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
  | — | 3G no-match | SC4 suite + gibberish gate half + no untagged dev query emptied + dev `answerable-floor` + custodian count = 0; no look |
  | L7 | 3H intents | general |
  | L8–L12 | reserve, **sealed reading** (5 slots) | as the original change |
  | L8–L11 | reserve, **holdout reading** (4 slots) | as the original change |
  | L12 | **holdout reading only**: frozen ranker vs `eval-v0`, the SC5 look | SC5 rule via `--gate sc5` (BCa lower bounds of ΔnDCG@10 and ΔP@5 > 0) |

  **Arithmetic.**
  - Change looks: 3A-1, 3A-2, 3B, 3C, 3D, 3E, 3H = **7** (L1–L7).
  - No-look changes: 3-0 and 3F (identity), 3G (SC4, gibberish set, answerable floor, count) = 0.
  - Counts: 3G's `eval:count` calls (the selected τ, and its fallback if needed: ≤ 2) and the
    sealed test set's answerable counts go to `eval/count-log.md`, never the ledger = 0
    (A3-1).
  - Bundled candidates: `stopwords-v2` rides L3 and β rides L5, each only after passing dev
    alone = 0.
  - SC5: sealed reading 0 (the test set has its own single look, and the holdout is not read
    for SC5); holdout reading 1 (L12).
  - Reserve = 12 − 7 − 0 = **5** (sealed) or 12 − 7 − 1 = **4** (holdout).
  - The reserve is certain: no planned change's look depends on a count. r3.1 leaves the look
    table's counts as r3 had them.
  - Retries: 6 changes have a named retry (3A-2, 3B, 3C, 3D, 3E, 3H). The reserve funds at most
    one per failed change, in order of failure. When one slot is left and more than one change
    is waiting, the waiting changes are bundled into that look, never a 13th. A change that fails
    with no retry left is dropped, and a dropped SC4-required change goes to Q4.

## 4. SC4 acceptance suite (pre-registered)
- **Written by the lead** before any 3B–3H code merges, from the SC4 wording. Committed as
  `test/sc4/queries.json` at P-6, with rules, counts and thresholds fixed in the same commit.
  Implementers may not edit it; a change goes through the lead with the reason logged.
  - Dev is open, so named dev texts may appear, and each is listed: d-024 as an intent rule,
    d-079 and d-022 as GE rules, d-016 as an unknown code inside a longer query.
- **Custody (A-N1).**
  - No holdout text enters the suite. The custodian runs the v2.1 code-overlap rule and the
    query-embedding cosine ≥ 0.9 check of every suite query against the holdout. The tool prints
    only the hit count and the hitting suite ids, and those suite queries are replaced.
  - The suite's texts and code targets join the test-set exclusion list and the test-set leak
    filter (§5).
- **Runs** the real Worker over the **pinned bundle** and pinned corpus in the `full-corpus` CI
  job (B2-4). Query embeddings are committed (*est.* ~130 texts with the gibberish set, < 10
  neurons).
- **topK.** Every item runs at the default topK of 20, except the partial-code and pillar items,
  which run at topK = 50 (`MAX_TOPK`, A3-3, C3-3). At 20 a page cannot hold CS32's 27 groups or
  GEC's 35. P-6 asserts that G ≤ 50 for every such item.
- **Every query has an exact expected `interpreted` JSON**, with `null` for every intent it must
  not set. Any difference fails (C-10).
- **Thresholds fixed at P-6:**
  - **T, the typo overlap** (C2-4). The lead writes the clean form of each of the 6 dev typo
    queries and runs an oracle variant: the lexical half on the clean form, the dense half on the
    typo form, the best a keyword-only corrector can do. T is the smallest oracle overlap@10 over
    the 6 pairs, capped at 7.
  - **M, the mixed-query count** (A2-8): ≥ 3 prefix members in the top 10 (proposed). CS32 has
    30 offered modules, so the rule is satisfiable.
- **Items, fixed counts, rules** (C-10, C-1, C-6, rounds 2 and 3). "Groups" are groups-v1
  groups, with a singleton counting as its own group (A2-5).

  | item | n | rule |
  |---|---|---|
  | space code (`cs 1010s`, `ma 1521`, `cs1010 s`, `is 4246`) | 5 | that code at rank 1 |
  | code vs level (`GEA1000`, `ES1000`, `cs 3000`) | 3 | offered code at rank 1 with `interpreted.level` null; `cs 3000` → level 3 with the CS prefix route, every result a level-3 CS module |
  | code joins (`cs2040 or cs2030`, `cs1231 s/u`) | 2 | `cs2040 or cs2030`: CS2040 and CS2030 at ranks 1 and 2; `cs1231 s/u`: CS1231 at rank 1, `interpreted.su` set, and every result satisfies `su=1` (C3-1) |
  | partial code or pillar (`CS32`, `cs101`, `cs 32`, `GEA`, `gec`, `GEX`), at topK = 50 | 6 | every result is a member; count = G, the distinct groups among the members ∩ filters; every member appears as a result or as a variant of one (A3-3) |
  | code inside a longer query (`cs32 machine learning`, one more written at P-6) | 2 | ≥ M prefix members in the top 10 |
  | unknown or not-offered code inside a longer query (d-016 `CS 4400 Operating Systems`, one more with a catalogue-only code written at P-6) | 2 | count > 0, no pin, no prefix route, no `noMatch` (C3-6) |
  | GE inside a longer query (d-079, d-022) | 2 | every result is a pillar member, and count ≥ min(10, distinct groups among pillar members ∩ filters) |
  | typo | 5 | top-10 overlap with its clean form ≥ T, and the clean form's `interpreted` |
  | level: beginner | 4 | no level ≥ 5 in the top 10, and a named level-1/2 answer in the top 3 (e.g. CS2109S, EE2211) |
  | level: graduate | 2 | every top-10 result level ≥ 5 |
  | level: N (`4000 level`, `level 3000`, `lvl 3000`) | 3 | every top-10 result at level N |
  | level: year (`3rd year`, `2nd year`, `third year`, each inside a topical query) | 3 | every top-10 result at a level from N to 4 (C3-2) |
  | no-exam (d-024's text, `without final exam`) | 3 | 100% of results satisfy the constraint, and top-10 overlap ≥ 7 with (clean query + explicit param) |
  | S/U | 3 | as no-exam |
  | workload | 3 | as no-exam |
  | no prerequisite | 3 | as no-exam, under the selected semantics |
  | gibberish | 5 | `count: 0`, `noMatch.reason` `no-signal` |
  | non-existent code | 3 | `count: 0`, `noMatch.reason` `unknown-code` |
  | not-offered code (`GEQ1000`, one more) | 2 | `count: 0`, `noMatch.reason` `not-offered`, `noMatch.title` equals the catalogue title |
  | guards | 29 | count > 0 and no prefix route fired; for a collision-list token, the exact `interpreted` JSON as well and no count rule (C2-8); for any other letter-only token, ≤ 2 of the top 10 have a code whose letter part equals it |
  | **total** | **90** | |

  The guards include `art history`, `law and society`, `intro to psych`, `learn korean`, `AI`,
  `ai ethics`, `js`, `pr`, `dsa` (C3-5), `comp 1010`, `math 1001`, `econ 1101`,
  `advanced calculus` (MA2311 in the top 10, no level intent), `not first year basics`,
  `give me 2 easy electives` and `how many units is 3 US credits` (no code join, C2-2),
  `show me 4000 level courses` (level 4, no ME route) and `give me 3000 level electives`
  (level 3, ME3000 not pinned) (C3-1). The AI guard has no count rule: all 9 AI* modules are
  about AI, so a correct answer may hold several.
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
         rule reads only the **count-only tool** built at P-5b (`eval:count --set test
         --answerable`, A-N9, A3-1). It prints one integer, logs the call in
         `eval/count-log.md`, and is not a look under the amended ADR 0003.
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
| 3-0.0 warm burst (after ≤ 20 `/health` probes, which read nothing) | ~5k (12 × 406 mean) | 0 | ~4.6k (12 × 384) | < 1 | ≤ 12, one session |
| 3-0 cutover: guard read | ~6.8k | 0 | 0 | ≤ 300 (missing texts, *est.*) | ≤ 4 smoke |
| runbook step 8 (×3: cutover, 3A-2, 3H): read every row, upsert 6,778 with metadata in ≤ 1,000-vector batches | ~20k (3 × 6.8k) | 0 | 0 (upserts; stored 2.6M of 10M) | 0 | 0 |
| deploys (≤ 13): guard read via `/admin/hashes` + smoke (≤ 4 each) | ~88k (6.8k × 13) + ~21k (52 × 406) | 0 | 0 after 3-0 | ~3 | ≤ 52, ≤ 4 per session |
| SC7 counted run at the freeze | ~18k (45 × 406) | 0 | 0 | ~2 (45 × 0.05) | 45, one session |
| SC7 declared re-run (colo shortfall only) | ~18k | 0 | 0 | ~2 | 45, another session |
| 3A-1 query prefix, all sets | 0 | 0 | 0 | < 15 | 0 |
| 3A-2 text variants (3 eval passes) | 0 | 0 | 0 | ≤ 7.2k, ≤ 2 passes a day | 0 |
| 3A-2 production (runbook) | ~30k | ~35k *est.* | 0 | ≤ 300 | in deploys |
| 3B `0008_catalogue` + load of ~14.4k catalogue-only rows | ~15k | ≤ 30k *est.* (rows + PK index) | 0 | 0 | in deploys |
| 3H migration 0007 + row-only ingest | ~30k | ~35–50k *est.* | 0 | 0 | in deploys |
| 3C-2 / rewrites (embed-missing cap) | 0 | 0 | 0 | ≤ 500 per run | 0 |
| verify after each corpus change (×4: pre-deploy + post-step-8) | ~55k | 0 | `getByIds` sample only | 0 | 0 |
| SC4 suite (90) + gibberish set (≥ 40) embeddings + live confirmation | ~8k | 0 | 0 | < 10 | ≤ 20 |
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
| 3D round 1 (α × 4 with rules, β × 3) | 7 | 6,860 | 1,960 |
| 3D round 2, dev only (bundle rules + α* + β*) | 1 | 980 | — |
| 3E (8 new points) | 8 | 7,840 | 1,960 |
| 3F | 1 | 980 | — |
| 3H ((i), (ii) × stripped, raw) | 4 | 3,920 | — |
| holdout, per look (custodian: candidate, and the baseline when it is new) | 1–2 | 1,620 | — |
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
- **Merge before D1**: from runbook step 2 to step 4, `main` holds a data version D1 does not, so
  the guard refuses every deploy from `main`. The runbook keeps that window short, and a failed
  step 4 is undone by restoring the bookmark and reverting the merge.
- **The Vectorize flip** serves masks in code order and applies 3H after hydrate. It is degraded
  service, SC4 is not claimed under it, and one test covers it.
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
- **Intent parser false positives**: the collision list, the guarded joins and the "known prefix
  only" rule stop `AI`, `js`, `dsa`, `comp 1010`, `give me 2 …` and `give me 3000 level …` from
  routing. Hard level and intent filters are echoed and undoable. The SC4 guards and exact
  `interpreted` JSON pin each case down. The cost: a collision-list code inside a longer query
  (`is 4246 workload`) is not pinned.
- **Hard beginner exclusion and the year window** remove level ≥ 5 (and, for `3rd year`, levels
  1–2) even where a student might accept one. Both are echoed so the UI can undo them.
- **3H's constraints cost relevant answers by design.** d-099's only relevant module fails both
  prereq semantics, and (i) removes all 5 of d-011's. The dev screen exempts such queries
  (C3-8), but L7 does not, so a holdout query of that shape counts as loss there.
- **Exam data semantics**: a missing `examDate` is not a certified "no exam". The mitigations are
  the UI copy and the echoed interpretation.
- **No-match hides real long-tail answers**: three signals must all agree before 3G fires, and
  four checks gate it. No untagged dev query may return `no-signal`, dev answerable loss is
  capped at 0.01, the holdout count of emptied untagged queries must be 0, and the SC4 suite,
  typo items and guards included, must stay green.
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
  binding limit: Workers CPU or Workers AI neurons, whichever measures smaller. ADR 0006 carries
  the measured bundle size, startup time and CPU per query from 3-0's PR.

## 9. ADR amendments needed
| ADR | amendment | objections | when |
|---|---|---|---|
| 0003, `JUDGING.md` | **Judge rule 4**: code queries' targets graded by rule from the corpus; `qrels-dev-v2`, `qrels-holdout-v2`. | Phase 2 exit red-team | P-0a (done, PR #30) |
| 0003 | **Gate and custody hardening**: cutoff truncates the baseline; the ledger records the rule; baseline sha checked; `--store-only` cannot overwrite; `--set-dir` manifest-checked. | Phase 2 exit red-team | P-0b (lead, in progress) |
| 0003 | **No-answer set fixed by tag** for any change: `noanswer`, `code-nonexistent` or `noAnswerByRule`. Emptying any other query is answerable loss. An untagged query with no grade-≥1 document is unscored; reports list its id on dev only and give counts on the holdout and test sets. | A-1, C-3, A2-2, A2-11 | P-5; code at P-5b |
| 0003 | **Change kinds** `no-loss` (Δ ≥ 0, with an optional dev-only exemption list, for 3H's constraint-exempt queries) and `answerable-floor` (answerable ΔnDCG@10 ≥ −0.01). | A2-2, C3-8 | P-5; code at P-5b |
| 0003 | **Look definition: counts are not looks.** `eval:count` prints one integer, is custodian-only, and logs to `eval/count-log.md`, which the ledger never reads. A count is not a verdict, even when a pre-registered gate reads it. | A3-1, A-N9 | in P-5b's commit, with the tool |
| 0003 | **3G gated without a look**: the SC4 suite + the gibberish gate half (≥ 90%) + no untagged dev query returning `no-signal` + `answerable-floor` on dev + the custodian's `eval:count` of emptied untagged holdout queries = 0. | A-1, C-3, A2-9, A3-1, A3-2, A3-6 | P-5 |
| 0003 | **Look procedure**: the custodian stores and pools each look's baseline when it is new, and takes the verdict with `eval:report` on stored, fully judged runs. | A3-4 | P-5 |
| 0003 | **3F gated without a look**: identity with the group-first projection on dev and the fixture + `no-loss` on dev. | A2-4 | P-5 |
| 0003 | **SC5 reading** recorded as Jacob decides it, with L12 per reading (sealed: none; holdout: the SC5 look via `--gate sc5`, ledger-recorded). | A-3, A2-2, A2-10 | P-7; code at P-5b |
| 0003 | **groups-v1** named as the duplicate-group rule for dev, holdout, test and the product, with the `eval/groups.json` hash in the locks. | A-2, C-8 | P-5 (groups-v1 merged at P-1) |
| 0003 | **SC4 custody and test-set exclusions**: the count-only overlap check against the holdout; SC4 and gibberish texts join the test-set exclusion and leak filter. | A-N1 | P-5 |
| 0004 | **Per-round cross-family check** (Gemini + Sonnet verifier, blind to A) on differing pairs for 3A-2, 3D, 3E and the SC5 test pool. It replaces the calibration Δ-sign report, and an opposite sign on dev stops the change before its look. | A-N2 | P-5 |
| 0006 (new) | [Written with this plan](../decisions/0006-phase3-search-quality-plan.md): the key Phase 3 decisions and the dissent from all three rounds. 3-0's PR adds the measured bundle size, startup time and CPU per query. | all three rounds | r3.1 (this PR); 3-0's PR |

## 10. Gate questions for Jacob
**Answered (Jacob, 2026-11-06):**
- **Q1:** the sealed test set decides SC5. L12 is unused, and 5 holdout looks stay spare.
- **Q2:** the VPN is off. Before the counted SC7 run, the lead confirms it is still off.
- **Q3:** not triggered. Step 3-0.0 projected a warm p67 of 160.6 ms
  (`docs/evidence/phase3/embed-latency.md`).
- **Q4:** the standing rule stands as written.

The questions as they were asked:

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
  building 3-0 we send up to 12 test searches through Singapore and project how fast search would
  be with exact vector search in place. If at least 8 of them reach Singapore and that projection
  (the 67th percentile, which decides SC7) is above about 200 ms, removing Vectorize alone may
  not get SC7 under 250 ms. The options:
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
the critic's fix is in the plan as proposed. Locations are r3.1 sections.

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
| A-N9 | No count-only tool for the test answerable count | Applied: `eval:count --set test` (r3 only named it; P-5b builds it since A3-1) | §3 P-5b, §5, §9 |
| B-1 | Vectorize not an identical standby at cutover | Applied: step 8 (r3: step 7) upserts the 6,778 bundle vectors (round 2: with full metadata) | 3-0 standby |
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
| A2-13 | Stale: PR #28 merged; group-aware baseline exists | Applied in part (dissent 3): P-1 done; branch rebased; baseline cited as "under qrels-v2, to be measured"; since PR #30 it is measured and cited | §1, §3 |
| B2-1 | Runbook verify always fails; delete and upsert wipe the standby | Applied: verify split; D1-only delete in step 4, `deleteByIds` in step 8 (r3: steps 3 and 7); full `storedVectorMetadata` | 3-0 runbook |
| B2-2 | `/admin/hashes` exists and 404s in prod; fixture leak via dev | Applied: guard and admin calls via `wrangler dev --remote`; values from the asset in the POST body; no prod secret; "new" struck | 3-0 guard, runbook, §7 |
| B2-3 | Step 3-0.0 can't produce a warm p67; formula omits fts | Applied: Phase 1 spans + ≤ 12-query burst; per-sample projection with max(); Q3 conditional | §1, 3-0.0, §6, §10 Q3 |
| B2-4 | CI and SC4 mix catalogues | Applied: pinned bundle for CI and SC4, production bundle for deploys only | 3-0 bundles, §4 |
| B2-5 | Eval and production key vectors differently | Applied: keyed builder with shared-text expansion and a row-count assertion | 3-0 bundles |
| B2-6 | Hand-bumped `rv`; `DENSE_BACKEND` flip unkeyed | Applied: key on `CF_VERSION_METADATA.id`; SC7 checks `x-app-version` | 3-0 cache key |
| B2-7 | TTFB guard measures connection setup | Applied (lead's choice): rely on the startup gate; report true TTFB against the 3-0.0 baseline; no threshold | 3-0 startup gate, 3-0.0, §8 |
| B2-8 | Binding limit becomes CPU | Applied: measure `CPUTimeMs` on the 3-0 smoke; README names the smaller | 3-0 CPU, §6, §8 |
| B2-9 | §6 undercounts deploys | Applied: 11 planned, budgeted at 13 | §6 |
| B2-10 | Row ingest doesn't reach Vectorize metadata | Applied: step 8 (r3: step 7) upserts on row-only changes too; since B3-3 it upserts every code | 3-0 runbook, 3H |
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

### Round 3 (r3, PR #27 head 48f46ba), the final round

| # | Objection (short) | Disposition | Where |
|---|---|---|---|
| A3-1 | 3G's holdout count would be a look; no `eval:count` exists | Applied: P-5b builds custodian-only `eval:count` (test answerable, holdout emptied-untagged), one integer, logged in `eval/count-log.md`, with tamper tests; ADR 0003's look definition amended in the same commit | 3G, §3 P-5b and arithmetic, §5, §9 |
| A3-2 | 3G's no-look gate lets d-095 be emptied; the floor allows 0.83 total loss | Applied in part (dissent 4): no untagged dev query may return `no-signal`; the SC4 suite must be green, typo items included | 3G, §3 look table, §7, §9 |
| A3-3 | Partial-code rule fails by construction at topK 20 (CS32 27 groups, GEC 35) | Applied (lead's choice): the partial-code and pillar items run at topK = 50; count = G | §1, §4 |
| A3-4 | Holdout baselines never stored or judged; `eval --holdout` reserves first | Applied: steps 1–2 store and pool a new baseline; step 4 is `eval:report` | §1, §3 holdout, §6, §9 |
| A3-5 | 3D bundle can't pool with its parts; 3E has 8 new runs | Applied (lead's choice of A3-5's options): a second, dev-only round for 3D's bundle; 3E pools 8 | 3D, 3E, §3, §6 |
| A3-6 | τ percentile method unstated; candidates derived on the set they're gated on | Applied: nearest rank; a seeded split into derivation and gate halves (set ≥ 40) | 3G, §3 P-6, §6 |
| A3-7 | 3H fallback "dev runner-up" unranked; pattern list fixed late | Applied: P-6 fixes the cohort-only pattern list and the fallback (the other semantics, same raw/stripped); L7 measures the prereq intent only | 3H, §3 P-6 |
| B3-1 | New params and `ignore` missing from the cache key | Applied: `exam`, `su`, `hoursBelow`, `prereq` and sorted `ignore` join the key in parsed form, one test each; §1's key description corrected | §1, 3-0 cache key |
| B3-2 | 3-0.0 burst has no colo rule | Applied: `/health` probes until `cf-ray` is SIN, burst on that connection; < 8 SIN samples → Phase 1 projection stands | §1, 3-0.0, §6, §10 Q3 |
| B3-3 | Step 7 can't find the changed set, doesn't wait for the mutation, and is a no-op for 3H | Applied: step 8 upserts every code in ≤ 1,000 batches, returns `mutationId`, waits with `waitForMutation`; 3H text reworded | §1, 3-0 runbook, 3H, §6 |
| B3-4 | "Between steps 3 and 5 (minutes)" is false: deploy needs a merged commit | Applied: data version computed offline; manifest and data version merge at step 2; the guard refuses until D1 matches | §1, 3-0 guard and runbook, rollback, §7 |
| B3-5 | D1-only `/admin/ingest` is an unnamed code change | Applied: D1-only modes for `/admin/ingest`, `/admin/delete` and `ingest-core`, tested to make no AI or Vectorize call | §1, 3-0 runbook, Touches |
| B3-6 | The Vectorize flip can't serve 3B masks or 3H filters | Applied: masks in code order, 3H after hydrate, one test; SC4 not claimed under the flip | §1, 3-0 standby, §7 |
| C3-1 | 4-digit and suffix joins still make words into codes | Applied, stricter than proposed (lead decision below): collision and stopword letters join only as a whole query that names a real code; suffix join needs a real code and never before `/` or `-`; 3H phrases match first; four guards | §1, 3B, §4, §7 |
| C3-2 | Hard level = N for year phrases contradicts dev (d-064) | Applied (lead's choice): year phrases are the window N ≤ level ≤ 4; `level N000`, `N000 level`, `Nk` stay exact; SC4 year items | §1, 3D, §4, §7 |
| C3-3 | Same as A3-3 | Applied with A3-3 | §4 |
| C3-4 | Prefix range scan takes in CSA | Applied: `code >= 'CS0' AND code < 'CS:'`; test that `cs` returns no CSA | §1, 3B |
| C3-5 | Collision seed misses DSA, SE, PE, LAB | Applied: added; `dsa` guard | §1, 3B, §4 |
| C3-6 | No rule for an unknown code inside a longer query | Applied: it routes nothing and its tokens stay; d-016 item | §1, 3B, §4 |
| C3-7 | `lvl 3000` can't fire; mask and third-list order unstated | Applied: `lvl N000` is a 3D phrase; whole-query `cs 3000` is prefix ∩ level by dense score; third list by dense score | 3B, 3D, §4 |
| C3-8 | §1 misstates d-011; d-099 loses by construction | Applied: §1 corrected; the loss is named; constraint-exempt rule for the dev screen (lead decision below) | §1, 3H, §7 |

### Dissent and partial application
1. **B-8, "delay step 5 until smoke passes"** (round 1, applied in part). B-2's guard needs D1's
   text hashes to match the manifest *before* the deploy, so the D1 write cannot wait for the
   smoke. It runs before the deploy, behind a Time Travel bookmark, and is restored from it, with
   step 2's merge reverted, if the smoke fails. Every Vectorize write waits for the smoke, as B-8
   asks, and since B2-1 that includes deletions. B-8's intent, that a bad deploy can be undone
   with nothing lost, holds.
2. **A2-7, a fallback per SC4-required change** (applied in part). Every one has a
   pre-registered fallback, but in some cases it coincides with the candidate or does not exist:
   - 3B's is "without `stopwords-v2`". When `stopwords-v2` already failed dev, L3 carries 3B
     alone and the fallback is the same change;
   - 3C's is the other variant, which may fail the SC4 typo rule and so be ineligible;
   - 3D's is the rules with α = 0 and no β, the same change if that point was selected;
   - 3G's is the next τ candidate, which may not pass on dev.

   In each case a failure goes straight to Jacob (Q4). Writing extra variants now would add
   designs no critic has reviewed.
3. **A2-13, the group-aware baseline on `docs/phase2-baseline`** (applied in part). The plan does not
   cite that table: it is scored under `qrels-dev-v1`, which scores d-087 to d-092 as no-answer.
   P-0a supersedes it, and the plan gates on the `qrels-dev-v2` baseline in `EVAL.md` (P-4, PR
   #30).
4. **A3-2, "the whole SC4 suite green" at 3G's gate** (round 3, applied in part). 3G can merge
   before 3H, and a change SC4 needs can be dropped (Q4), so a literal whole-suite rule could
   block 3G for reasons it doesn't control. Items owned by an unmerged or dropped workstream are
   listed and skipped. The typo, gibberish, non-existent-code and guard items, which A3-2 is
   about, are never skipped, and SC4's exit check (§8) still needs the whole suite.

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

From round 3:
- **3H's constraint-exempt queries (C3-8).** The dev screen's `no-loss` excludes a query whose
  every relevant document fails the parsed constraint. The student asked for the constraint, so
  removing those answers is what they asked for. The exemption covers the dev screen only; L7's
  holdout rule is unchanged. Pre-registered at P-6.
- **The join rule is stricter than C3-1 proposed.** C3-1 lets collision-list letters join
  whenever the result is a real code. ME3000 is offered, so `give me 3000 level electives` would
  still pin it. In r3.1 collision and stopword letters join only when they and the digits are
  the whole query. The cost is that `is 4246 workload` is not pinned.
- **Several level phrases in one query take the union** of their ranges (d-045 → levels 3–4).
  C3-2 sets the year window but not how it combines with an exact level.
- **`first year` and `1st year` stay beginner.** Their hard effect is the year window with
  N = 1, plus α.
- **The gibberish set grows to ≥ 40**, so each half of A3-6's split holds ≥ 20 strings.
- **The GE-inside-a-longer-query rule counts groups**, as A3-3's partial-code rule does, so a
  collapsed page cannot fail it by construction.
- **3D's bundle gets a second dev-only round** rather than pooling all 12 α × β points: one
  extra run instead of 12.
