# Phase 3 plan: search that understands students (draft r2)

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

r2 applies every round-1 objection (§11) and the lead's dispositions. The structural changes:
- 3G and 3H spend no holdout look;
- stopwords and β are each screened alone;
- one pooling round per grid, before selection;
- 3F uses the eval's groups-v1 rule;
- the SC5 reading is settled before L1;
- the 3-0 rollout order is rebuilt around the deploy guard, the Vectorize standby and rollback.

## 1. Facts gathered
- **Dev baseline, not group-aware** (`qrels-dev-v1`, primary answerable n = 78, judged@10 100%,
  `groups: []`): v0 hybrid nDCG@10 0.762, P@5 0.631; lexical only 0.648; vector only 0.723.
  No-answer: 0 of 15 come back empty. These numbers score every duplicate as a separate document.
  The gating baseline is **re-measured under groups-v1** at step P-4 (§3). r2 quotes no
  group-aware number until then.
- **Duplicate groups, groups-v1** (branch `feat/eval-duplicate-groups`, PR #28, open;
  `eval/lib/groups.mjs`). Over the offered modules of the pinned corpus:
  - a *variant family* is codes with the same prefix letters and four digits that differ only in
    suffix letters, with the same normalised title;
  - a *cross-listing* is different codes with an identical normalised title and description,
    where the placeholder `Not Available` or an empty description never counts;
  - groups are transitive, and singletons are dropped.

  Result: 509 groups, 1,562 members, largest 38. TR3202I/N/S/T, CS1010/A/E/HS/R/S/X and
  MNO1706A–F/X are each one group. MA2101 and MA2101S stay apart because their titles differ.
  Critic A counts 14 dev queries with ≥ 2 relevant documents in one group.
- **Dev shape counts** (`eval/dev/queries.json`, 98 queries): topical 25, mapping 12, level 7,
  ge 6, typo 6, abbreviation 6, code-exact 5, code-space 3, code-partial 3, noanswer 5,
  constraint 5 (a feature-gap block, outside the primary metric). Dev has no `code-nonexistent`
  query. The SC4 shapes have 3–7 dev queries each, too few to show SC4 on their own. Hence the
  acceptance suite in §4.
- **The 15 dev queries with no grade-≥1 document** (critics A and C):
  - 5 are tagged `noanswer`. Only d-012 and d-025 have no plausible answer.
  - 5 are code queries the v0 pool missed (`cn 2109`, `is 4246`, `MUL21`, `DAO17`, `GEC`).
  - 4 are mapping queries with no relevant document judged (d-005, d-017, d-032, d-042).
  - 1 is d-061 (`evo devo`).
  
  So r1's 3G cutoff could gain at most ~0.07–0.2 correct-empty against its 0.25 bar.
- **Holdout**: 81 queries, 0 of 12 looks used (`eval/holdout-ledger.md`).
- **SC7 FAIL** (`docs/evidence/phase1/sc7.md`): pooled p50 351 ms.
  - Warm p50 spans: `vector` 232, `embed` 88, `fts` 19, `hydrate` 13, `cache` 8.
  - `embed`→`vector` runs alongside `fts`, so `total` ≈ cache + max(embed + vector, fts) +
    hydrate.
  - With the APAC primary (ADR 0005), D1 is no longer the problem.
  - Post-switch smoke calls from SIN logged fts 45–269 and hydrate 16–43, but also embed 260–414
    and vector 245–254 (`requests.tsv` 72–73).
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
    - cache: the key holds `q` and `DATA_VERSION` only (`canonicalCacheKey`, lines 167–178),
      with a TTL of 3600 s (`CACHE_TTL_S`), so a ranker-only deploy serves old rankings for up
      to an hour;
    - timing: workerd's clock advances only across I/O, so a CPU-only span such as an in-Worker
      dot product reads ~0.
  - `src/fts-query.js`: quoted tokens joined by OR, with a 27-word stopword list. 0006 built
    prefix indexes `'2 3 4'` but kept `code` UNINDEXED, because indexing it would change bm25
    lengths.
  - `scripts/lib.mjs` `embeddingText`: title, department, faculty, description; no code, no level
    (`EMBEDDING_TEXT_VERSION = 1`).
  - Ingest and query: the ingest Worker embeds in batches of 50 (`src/ingest.js`). The query is
    embedded verbatim, with no bge instruction prefix. A changed `text_hash` changes `row_hash`,
    which changes the data version.
- **Corpus facts for 3B–3H** (critic C, pinned corpus; re-run and committed by step 3B-0 or
  3H-0):
  - Prefixes:
    - ART and LAW are not prefixes. Real collisions with words or abbreviations: AI 9 modules,
      IT 18, PR 79, JS 24, GE 62, MA 110, EE 123, CE 144, LL 386.
    - GEA has 2 offered modules, CS101 7, DAO17 2, MUL21 4.
    - `comp`, `math`, `econ` are not NUS prefixes.
  - Catalogue: 14,359 catalogue codes are not offered this year (e.g. GEQ1000, GEH1001, IS1103).
  - Prerequisites: 4,180 of 6,771 offered modules have no prerequisite field.
  - Workload: 259 modules have an all-zero workload array. 4,614 of 5,081 4-MC modules list 10
    h a week.
  - S/U and grading: `attributes.su` is set on 933 modules (levels 1–4). 648 are graded CS/CU
    (1 of them also `su`). `grsu` is set on 410 (levels 5–6).
  - Exams: 35 modules have an `examDate` in some offered semesters and not others.
  - Words: "final" has df 171 (Final Year Project).
  - Groups and credits: of the exact title+description groups, 37 mix credits (AR4421 8 MC,
    AR4421A 12 MC). 270 same-title groups have different descriptions.
- **Cloudflare limits** (docs, 2026-11-04):
  - Worker size 64 MiB uncompressed (no compressed limit since 2026-09-04);
  - startup 1 s; 128 MB per isolate;
  - Paid CPU 30 s per request by default;
  - static asset file and KV value 25 MiB each;
  - Vectorize queried dims = (queried + stored vectors) × dims.

## 2. Workstreams

The order is fixed by dependency:
1. The preconditions (§3, P-1 to P-7).
2. 3-0. Every later dense change then reaches production in a deploy instead of a re-ingest, and
   the replica and production search the same way.
3. 3A-1, then 3A-2.
4. 3B, then 3C, 3D, 3E and 3F.

3H's data migration is ranking-neutral and can land early. 3G comes after 3C (it reads the
vocabulary) and 3-0 (it reads exact cosines). Each workstream lists its approach, what it
touches, and how it is measured: dev screen first, then the holdout step planned in §3.

### 3-0 In-Worker exact vector search (SC7)
- **3-0.0 Embed-latency gate (B-6), before any 3-0 code.**
  - Read the warm `embed` spans logged since the APAC switch from Workers Logs. The read is
    read-only and makes no `/search` call.
  - Project the warm p67 total as cache + embed + ~5 (exact search, *est.*) + hydrate, each at
    its warm p67.
  - If the projection is above 200 ms, building 3-0 waits for Jacob (§10, Q3): embed time alone
    would then put SC7 at risk.
  - The step writes the numbers to `docs/evidence/phase3/embed-latency.md`.
- **Approach.** Replace `env.VECTORIZE.query` in `denseSearch` with a brute-force dot product over
  L2-normalised corpus vectors held in the Worker.
  - Apply the filter mask first, keep the top `depth` with a bounded selection, and order by score
    desc then code asc, so ties are deterministic.
  - Cosine is the index metric (README: `--metric=cosine`), so on normalised vectors this is the
    same similarity.
  - Return the scores internally: 3B's partial-code mask and 3G need them.
- **Storage form: float32 in a `Data` module** (ArrayBuffer, zero-copy `Float32Array`).
  - Size: 6,778 × 384 × 4 = 10.4 MB, plus a ~12 B/row (*est.*) filter table: sem bits, level, credits,
    faculty id, NG and NG-semester bits, a group id (3F), and the 3H bits (exam semesters, S/U
    source, workload, prereq-none). That is ~16% of 64 MiB and ~8% of 128 MB.
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
- **Fresh checkouts and CI (B-9).** The production vectors module is gitignored.
  - The import goes through an alias (wrangler `alias`) that defaults to a committed fixture
    module, `test/fixtures/vectors.bin`. That module holds the ~400 fixture modules' vectors from
    the fake embedder: 400 × 384 × 4 ≈ 0.6 MB.
  - A fresh checkout, `npm test` and the `check` job build against the fixture.
  - The `full-corpus` job downloads the release asset, checks its sha256 against
    `data/vectors.json`, and points the alias at it.
  - `npm run deploy` refuses the fixture.
- **Startup gate (B-4).**
  1. `wrangler check startup` runs locally as a pre-check.
  2. The deploy is split. `wrangler versions upload` creates the version. The script parses its
     reported `startup_time_ms` and refuses if it exceeds 200 ms (*est.* well under; the limit is
     1 s).
  3. Only then does `wrangler versions deploy <id>@100%` promote the version.
  
  `--dry-run` reports no startup time, so r1's check could not work.
  - `Server-Timing` `total` starts at fetch entry, so isolate startup is invisible to SC7. The
    SC7 report therefore also gives client TTFB on the sparse samples, with a pre-registered
    guard (below).
- **CPU per query (B-5).**
  - Work: 6,778 × 384 ≈ 2.6M multiply-adds, *est.* 3–6 ms of scalar JS (fewer rows with a
    filter).
  - The `vector` span reads ~0, because the workerd clock does not advance during CPU work. It
    is kept for comparability but is not evidence.
  - Measurement: a workerd microbenchmark in Vitest measures it cold (first call in an isolate)
    and warm. Live, it is read as the request's CPU time (`CPUTimeMs`) from Workers Logs.
  - Allowance: against the 30M CPU-ms included each month, 5 ms a search is ~6M searches.
- **Vectors become a content-addressed artifact** (`scripts/vectors.mjs`, new).
  - Rows are keyed by `textHash`, which covers model, text version and text. They are built
    from the eval's corpus asset plus embeddings of any texts it lacks (`scripts/embed.mjs`,
    REST, logged in `neurons.tsv`).
  - The builder refuses a row with no `textHash` (A-N6).
  - Each build is published as a release asset `vec-<dataVersion>-<embVersion>` and recorded in
    a committed manifest `data/vectors.json`. The manifest records data version, embedding
    version, count, the asset's sha256 and **`rowsKey`**: the sha256 of the sorted
    (code, textHash) pairs (B-2).
  - For every text that production and the pinned eval corpus share, production gets the **same
    bits** as the replica. This removes "cause 2" of the fidelity gap by construction.
  - Nothing of 10 MB enters git.
- **Deploy guard (B-2).**
  - `npm run deploy` downloads the asset and checks its sha256.
  - It then compares `rowsKey` against D1's current (code, `text_hash`) pairs. These come from
    a new read-only, secret-authenticated route `/admin/hashes`: ~6.8k rows read, logged.
  - It also requires the manifest's data version to equal `src/data-version.json`.
  - Any mismatch refuses the deploy.
  - Because `text_hash` → `row_hash` → data version, D1 must hold the new text hashes before the
    Worker that bundles their vectors deploys. Hence the order below.
- **Ingest and re-embed runbook (B-2, B-3, B-8, B-10).** One order for every corpus change: a
  catalogue update, 3A-2's re-embedding, or 3H's row change.
  1. Build the vectors asset: reuse vectors by `textHash`, and embed only the missing texts
     (REST, logged). Publish it and write the manifest on a branch.
  2. Record a D1 Time Travel bookmark in `remote-ops.md`.
  3. Ingest the D1 rows with precomputed `values`. `/admin/ingest` writes D1 only: text and row
     hashes, plus new rows or fields. It makes no Workers AI call.
  4. `npm run verify`: D1's (code, `text_hash`) pairs equal the manifest's `rowsKey`, and the
     bundle's codes and filter table equal D1's.
  5. Commit the data version and manifest, then run `versions upload`, the startup gate and
     `versions deploy`.
  6. Smoke (≤ 4 calls). If it fails, roll back (below) and stop.
  7. After the smoke passes, upsert the same values into Vectorize through a new values-only
     route, `/admin/vectors`, which makes no D1 write and no AI call. Then verify a `getByIds`
     sample against the bundle bits.
  - Every remote D1 operation is estimated and logged in `remote-ops.md`, **reads included**
    (B-10).
  - Between steps 3 and 5 (minutes), the live Worker runs its old bundle against the new D1. Old
    vectors can still return a code that changed. So after hydrate, `localMatchesFilters`,
    extended with the 3H fields, runs on every dense row against the fresh D1 row and drops
    rows that fail (B-3). A test covers this. Rows missing from D1 are dropped at hydrate, as
    stale Vectorize ids are today.
- **Vectorize stays, off the search path, as an identical cold standby (B-1).**
  - Cutover: ingest skips unchanged rows, and today's production vectors came from ingest batches
    of 50 that differ from the bundle. So at the 3-0 cutover, `/admin/vectors` upserts all 6,778
    bundle vectors in place: 0 D1 writes, 0 neurons, and stored dims unchanged at ~2.6M of 10M.
  - From then on, runbook step 7 keeps the standby equal to the bundle.
  - The flip: `DENSE_BACKEND=vectorize`, a var flipped by a deploy, restores today's path. Between
    steps 5 and 7 of a re-embed the standby holds the previous vectors, so the flip is not used in
    that window.
  - The brief forbids deleting or recreating the index. Keeping it costs nothing material.
  - When the bundle is missing or corrupt, or Workers AI fails, the fallback stays keyword-only
    (B6), with `degraded.source` `dense-index` or `workers-ai`. SC7's Vectorize-failure case
    becomes moot and is reported that way.
  - Vectorize queried dims drop to ~0 per search, and the binding limit moves to Workers AI
    (below).
- **Response cache key (B-7, A-N5).** `canonicalCacheKey` adds two parameters, one key change
  that covers both objections:
  - `ev=<embVersion>.<first 8 hex of the manifest sha256>`;
  - `rv=<RANKER_VERSION>`. `RANKER_VERSION` is a constant in `src/search.js`, bumped by every
    ranking-affecting PR, and every response carries it as `x-ranker-version`.
  
  A ranker-only deploy then misses the old cache entries. SC7 collection rejects any sample whose
  `x-ranker-version` differs from the frozen one.
- **Rollback (B-8).**
  - Every deploy's version id goes into `remote-ops.md`.
  - Rollback is `wrangler rollback <id>` to the previous recorded version. The floor is the
    version built from `597c2b7`: older versions are bound to the deleted WEUR database
    (ADR 0005).
  - If D1 changed in runbook step 3, restore it to the step-2 bookmark (a logged remote D1
    operation).
  - Vectorize needs nothing, because step 7 has not run.
- **Eval fidelity (A-N6).**
  - The harness builds the same Data module from `emb-bge-small-vN` and the pinned corpus, so
    the replica runs the production code path. Only `eval-v0` keeps the fake Vectorize, which is
    the same exact cosine with an id tiebreak (`test/fakes.js:209–210`).
  - Proof without a look: `head` with the bundle and `head` with the fake Vectorize give the same
    **result lists** on dev and the fixture. The run files' `treeHash` differs by construction,
    so the comparison is on results.
  - Adjacent items whose float32 scores differ by less than 1e-6 may swap. Every such swap is
    listed.
  - So 3-0 **uses no holdout look**.
  - In production it replaces ANN with exact search, moving production towards the replica. A
    third fidelity check needs a new pin first: production runs the 2026-11-04 catalogue, the
    eval the 2026-09-04 one.
- **Embed latency remains, with no query-embedding cache in Phase 3.** SC7 is measured on
  distinct queries, so such a cache cannot move it. Phase 7 decides on one from real hit rates,
  which the log can count.
- **Neurons (B-11).** The 3A-1 prefix adds tokens: *est.* ~0.05 neurons a query, so the 10k/day
  Workers AI allowance covers ~200k searches a day. 3C-2's second embed doubles that.
- **Expected latency** (*est.*, B-6). The warm p67, not the p50, sets the pooled p50 (§1).
  - Critic B's warm-p67 estimate with exact search is ~140 ms: cache + embed + ~5 + hydrate.
  - Step 3-0.0 replaces it with the measured embed spans.
  - Sparse, with the APAC primary: cache 25 + embed 227 + 5 + hydrate ~40 ≈ 300 ms.
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
  - **TTFB guard (3-0 exit, not part of SC7's rule):** median(client TTFB − `total`) over sparse
    samples minus the same over warm samples ≤ 200 ms (proposed; fixed in the method file). A
    failure opens the int8 or static-asset fallback.
  - The method is committed in `docs/evidence/phase3/sc7.md` before any sample.
  - Calls: 45 fresh queries (none from the eval sets, SC4, or earlier calls), `sc7-collect.mjs`
    with `wrangler tail` running, then `sc7-analyse.mjs`. At most 45 calls per run.
  - VPN: §10, Q2.

### 3A Vector half setup (S3)
- **3A-1 query instruction prefix.** Prepend bge's retrieval instruction ("Represent this sentence
  for searching relevant passages: ") to the query text only. Corpus vectors are unchanged.
  - New query embeddings are needed for dev, holdout, the SC4 suite and the gibberish set: ~300
    texts, *est.* < 15 neurons.
  - It touches `src/search.js` (`denseSearch`), `RANKER_VERSION`, and the eval embedding caches.
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
  3. Merge. Then the runbook above, steps 1–7. Step 1 reuses the eval's vectors by `textHash`
     and embeds only the texts the pinned corpus lacks (*est.* ≤ 400 texts, ≤ 300 neurons). Step
     3 rewrites every `text_hash`: no Workers AI call, and no FTS writes, since title and
     description are unchanged. *est.* ~35k rows written (5.2 per module, Phase 1 small batch).
     Step 7 upserts the new vectors in place, with no parallel index.
- A 768-d model would fit Paid's 10M stored dims, but it doubles the bundle and adds embed time.
  Not planned.

### 3B Codes, GE pillars, keyword brittleness (S5, S4)
- **3B-0 corpus data**, committed with the script that builds it:
  - the prefix list: letter parts of offered codes, with counts;
  - the collision list (C-2): prefixes that are English words, df > 0 tokens, or common
    abbreviations, starting from AI, IT, PR, JS, GE, MA, EE, CE, LL;
  - the catalogue-only code list (C-7);
  - the GE pillar table: pillar names → {GEA, GEC, GEH, GEI, GEN, GEQ, GES, GESS, GET, GEX},
    with the NUS GE page URL in the file.
  
  The step re-runs critic C's counts and commits them as evidence.
- **Canonicalisation (C-14)** before any matching, on the canonical q:
  - letters + space + 1–3 digits joins (`cs 32` → `cs32`, `cs 101` → `cs101`);
  - letters + space + 4 digits joins (`cs 1010s` → `cs1010s`);
  - code + space + 1–2 suffix letters joins (`cs1010 s` → `cs1010s`).
  
  Each join happens only when the letters are a known prefix.
- **Code parser** (`src/query-intent.js`, new; pure, Node-testable):
  - Only a **known corpus prefix** makes a token code-shaped (C-7). `comp 1010`, `math 1001` and
    `econ 1101` are topical queries.
  - A token `<prefix><4 digits><suffix>` that names an offered module is pinned in query order.
    Up to 3 are pinned, still subject to the filters.
  - A whole query that is code-shaped but names no offered module:
    - in the catalogue but not offered (C-7): `count: 0`, `results: []`,
      `noMatch: { reason: "not-offered", code, title, related: [codes] }`. `related` holds the
      top 5 dense neighbours of the catalogue text (title + description), embedded at request
      time. The text comes from a new D1 table `catalogue_only` (migration `0008_catalogue.sql`,
      loaded by ingest). Neighbours ride in `noMatch`, never in `results`, so the eval still
      scores the response as empty.
    - in neither: `count: 0`, `noMatch: { reason: "unknown-code" }`. The eval scores
      non-existent codes as correct-empty.
  - `XX N000` (`cs 3000`, `lvl 3000`, `year 1000`) is a level intent (3D), not a code. When `XX`
    is a known prefix, the prefix route also applies.
- **Partial codes and GE pillars (C-1, C-2)**:
  - **Whole-query partial code** (`[a-z]{2,4}\d{0,3}`, known prefix, the whole query, e.g.
    `CS32`, `GEA`, `cs101`): a **hard candidate mask**. A PK range scan `code >= ? AND code < ?`
    reads ≈ the rows it returns. The members are ordered by exact dense score (3-0). Lexical and
    RRF play no part.
  - **A code token inside a longer query** (`cs32 machine learning`): the prefix members become a
    **third RRF list** with weight w_c, tuned in 3E.
  - **Letter-only tokens:**
    - A letter-only token never prefix-routes inside a multi-token query.
    - As a whole query, it routes only when it is a known prefix and is not on the collision
      list. So `AI`, `js` and `pr` are topical queries.
  - **GE intent**: `ge`, `gen ed`, `general education`, and the pillar names from the table:
    - maps to the pillar prefixes only, never `GE\d` (Geography);
    - a whole query → the pillar mask ordered by dense score;
    - inside a longer query (d-079 `GE module about technology and society`) → a hard restriction
      to the pillar prefixes on the hybrid result.
    - It is echoed as `interpreted.ge` and undoable with `ignore=ge`.
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
    the drop is logged in the PR.
  - The targeted route still needs ≥ 3 distinct answerable target queries.
  - One look (L3).

### 3C Typos and prefixes (S4)
- **Order per token with df 0** (pre-correction tokens):
  1. **Prefix (C-9).** A token of ≥ 4 letters becomes an FTS prefix term `"progr"*`, served by
     0006's prefix index. `psych` matches `psychology` without being edited to `psyche`.
  2. **Edit distance.** Only if the prefix term also matches nothing, and only for tokens of
     **≥ 5 letters** (C-3): correct to the nearest vocabulary term. Edit distance is 1 for 5–7
     letters and 2 for 8+, with ties going to the higher df. Shorter tokens (`asdf`, `lol`,
     `idk`, `foo`, `hgb`) are never corrected.
  3. The original token stays in the OR, so nothing is lost.
- The vocabulary (surface tokens by `queryTokens` with df, *est.* ~25k terms, ~300 KB) is built
  from the same corpus as the vectors bundle and ships beside it, versioned the same way.
- **Variants** (finite, pre-registered):
  - 3C-1 changes the lexical half only.
  - 3C-2 also embeds the corrected text. The second embed is a separate single-text call run in
    parallel with the first (B-11), so neither embedding depends on batching, and the latency
    is max(), not sum. It needs new query embeddings, capped at 500 neurons per run.
  - Both variants' top-10s are pooled in one round before selection.
- **Measured.**
  - Dev target `typo` (6).
  - A dev-only diagnostic adds noise-model variants of clean dev queries. They live in a
    **separate set directory with their own qrels** (`--set-dir eval/diag/typo`, A-N8), so the
    locked dev file never changes. Unjudged pairs are judged there. It is reported and never
    gated.
  - One look (L4).

### 3D Level intent and graduate flooding (S6)
- **Intent rules, per direction (C-6, C-13)**, from the parser in `src/query-intent.js`. The
  phrase lists are pre-registered.

  | intent | phrases (examples) | effect |
  |---|---|---|
  | beginner | `intro`, `introductory`, `beginner(s)`, `for beginners`, `no background`, `first year`, `1st year`, `level 1000`, `1000 level`, `1k` | **hard exclusion of level ≥ 5**; soft prior α favours levels 1–2 over 3–4 |
  | graduate | `graduate`, `postgraduate`, `masters`, `phd` | hard filter level ≥ 5 |
  | level N | `level N000`, `N000 level`, `N000-level`, `Nk`, `Nth/Nrd year`, `year N`, `XX N000` | hard filter level = N (as the `level` param) |
  | none | `advanced` alone (`advanced calculus` keeps MA2311), any phrase negated by `not`/`non`/`except`/`beyond` within the two preceding tokens (`not first year basics`) | no level intent; the phrase stays in the query text |

  - Matched phrases are stripped from the lexical query only. The dense query stays raw.
  - The intent is echoed as `interpreted.level` (direction and the exclusion applied), so the UI
    (Phase 5) can show it. `ignore=level` undoes it.
  - `no background` also sets `prereq=none` (3H). Both are echoed, and each is undoable on its
    own.
- **Ranking**, in two parts screened separately (A-4):
  - **α**, the beginner soft prior after fusion: score × (1 − α·p), where p is 0 for levels
    1–2, 0.5 for 3 and 1 for 4. Grid α ∈ {0.1, 0.2, 0.35}, against the shipped α = 0.
    - Screened on the targeted route, with target `level`.
    - The hard rules above are part of every α point.
  - **β**, a default penalty on level ≥ 5 when no level intent is parsed. S6: 46% of the corpus
    is level 5+.
    - Grid β ∈ {0.1, 0.2, 0.35}, against 0.
    - It touches every query, so it is screened **alone under the general CI rule**. It joins L5
      only if it passes dev alone.
- P2 interaction: Phase 4 adds the study-level input and the hard rule for exchange mode. The
  priors stay soft and only order what that rule allows.
- **Measured**: dev target `level` (7) for the rules + α. The overall dev CI rule applies to β.
  All six grid points are pooled in one round. One look (L5).

### 3E RRF weighting (S2)
- Weighted RRF in `fuse()`: w_v/(k + r_v) + w_l/(k + r_l) (+ w_c/(k + r_c) for the 3B code
  list). The hash tiebreak becomes: best single-list rank, then dense rank, then code.
- Pre-declared grid:
  - w_v/w_l ∈ {1, 1.25, 1.5, 2} (w_l = 1);
  - k ∈ {20, 60};
  - **w_c ∈ {1, 2}** (C-1).
  
  That is 16 points, one of them the shipped (1, 60, 1), tuned **after** 3A and 3D, which shift
  the lists' relative quality. All 16 are pooled in one round before selection.
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
- **Eval.** groups-v1 merges before L1 (P-1), so the eval scores collapse the same way the product
  does. Under group-aware scoring, collapse replaces only duplicates that score nothing, so it
  cannot lower nDCG@10 or P@5. The look checks that the product rule equals the eval rule in
  practice. One look (L7).

### 3G Gibberish and "no matches" (S8)
- **Trigger** (C-3): return `count: 0` with `noMatch: { reason: "no-signal" }` iff:
  - no code, prefix or GE route fired;
  - no **pre-correction** token has df > 0 or an FTS prefix match; and
  - the top exact dense cosine (from 3-0) is below τ.
  
  3C's correction runs after this test, so `asdf` → `aidf` cannot rescue gibberish.
- **τ** comes from a finite candidate set. That set is fixed before any 3G dev run, from step
  3G-1's distribution of top-1 cosine on the gibberish set and on dev answerable queries. 3G-1
  uses no relevance labels. Selection: the largest τ that meets the rule below. Ties go to the
  smaller τ.
- **Gate, no holdout look** (A-1, C-3; ADR 0003 amendment, §9). 3G passes iff all of these hold:
  - the SC4 gibberish, non-existent-code and guard rules pass;
  - ≥ 90% of the **pre-registered gibberish set** returns `count: 0` (proposed threshold, fixed
    at P-6). The set is `eval/dev/gibberish.json`, ≥ 20 strings written before any 3G code:
    keyboard mash, filler, out-of-vocabulary slang, and mixed tokens like d-025. It is disjoint
    from SC4.
  - dev answerable ΔnDCG@10 ≥ −0.01.
  
  Under the amended no-answer rule (§9), emptying any query outside the tagged no-answer set is
  answerable loss.
- Its r1 look returns to the reserve.

### 3H No-exam, S/U, workload and prerequisite intents (S7)
- **Data (3H-0, 3H-1).**
  - Migration `0007_intents.sql` adds:
    - `exam_semesters` (JSON: the semesters with an `examDate`) and generated `exam_sem1..4`;
    - `su` (from `attributes.su`) and `grading_basis`;
    - `workload_hours`: the sum of the workload array, NULL when unparseable **or all zero**
      (259 modules, C-11);
    - a generated `prereq_none` (prerequisite IS NULL, C-5).
  - `normalise()` keeps them, and `NORMALISER_VERSION` is bumped, so every `row_hash` changes.
  - That makes a row-only re-ingest through the runbook: no re-embedding, no FTS writes, *est.*
    ~35–50k rows written, after the headroom check and a bookmark (ADR 0004). It is
    ranking-neutral, so it can land early.
  - 3H-0 re-runs critic C's field counts and commits them.
  - **The fixture is rebuilt** after the bump (C-15). It gains examples of each intent: mixed
    per-semester exams, CS/CU grading, zero workload, no prerequisite.
- **Query side.** The intent parser maps phrases to new explicit params:

  | phrases | param | constraint |
  |---|---|---|
  | `no exam(s)`, `no final(s)`, `no final exam`, `without final(s)` | `exam=0` | no `examDate` in the selected semester, or in any offered one when none is set |
  | `s/u`, `su-able`, `s/u-able`, `pass/fail` | `su=1` | `su` **or** grading basis CS/CU (C-12); `interpreted.su` says which matched |
  | `light workload`, `low workload` | `hoursBelow=10` | `workload_hours < 10`; NULL excluded |
  | `under N hours`, `less than N hours`, `< N hours` | `hoursBelow=N` | `workload_hours < N`; NULL excluded |
  | `no prereq(s)`, `no prerequisite(s)`, `no background` | `prereq=none` | prerequisite IS NULL |

  - **"light" is a fixed 10 hours** (pre-registered). 10 h a week is the standard 4-MC load,
    and 4,614 of 5,081 4-MC modules list exactly that. So "light" means below the standard load.
    A fixed number means the same thing to every student, and 2-MC modules (5 h) qualify, as
    they should. 3H-1 measures how many modules match and reports the count.
  - The constraints are hard filters in SQL and in the in-Worker filter table.
  - **Matched phrases are stripped from the keyword query (C-4)**, so `final` no longer boosts
    Final Year Projects and `s/u` no longer becomes `s`.
  - For the dense query, raw vs stripped is a **pre-registered dev diagnostic on the constraint
    block**. Stripped wins unless raw's constraint-block mean nDCG@10 is higher by ≥ 0.05 and
    raw's overall dev Δ ≥ 0 (margin proposed, fixed at P-6).
  - The response echoes `interpreted`, so the UI (Phase 5) can show it, and `ignore=<intent>`
    undoes it.
  - Copy:
    - no `examDate` means "no final exam listed", not certified;
    - NULL workload reads "workload not listed";
    - Phase 3 copy makes no claim about whether exchange students may S/U. The registrar question
      goes to Phase 4 as an open question (C-12).
  - `grsu` (graduate S/U) is left to Phase 4.
- **Measured: no holdout look** (A-N4; ADR 0003 amendment, §9). Judges never see exam, S/U,
  workload or prerequisite fields (`JUDGING.md`), so compliance is measured by the SC4 suite.
  3H passes iff all of these hold:
  - the SC4 intent rules pass;
  - dev primary ΔnDCG@10 ≥ 0 (point estimate; constraint block reported);
  - the **custodian's count check** on the holdout passes. The custodian stores the 3H candidate
    and the shipped ranker with `--holdout --store-only` (no verdict, no look). A custodian-only
    script then prints two numbers and nothing else:
    - (a) holdout queries where the parser sets an intent;
    - (b) holdout queries with no parsed intent whose top-10 changed.
    
    Pass needs (b) = 0. If (a) ≥ 3, 3H instead takes a reserve look under the general rule,
    because then it moves the relevance metric enough to need one.

## 3. Measurement and the holdout look plan
- **Before L1** (P-1 to P-7, in order):
  - P-1. groups-v1 (PR #28) merges, and `eval/groups.json` is the duplicate-group source for
    every set (A-2).
  - P-2. 3-0.0 embed-latency read. Q3 goes to Jacob only if it triggers.
  - P-3. 3-0 is built, proven identical on dev and the fixture, and deployed. The Vectorize
    standby is upserted. No look.
  - P-4. The first pooling round. It pools v0 and 3A-1's dev runs, plus a deeper pool for
    d-005, d-017, d-032 and d-042 (top 50 of the lexical-only and vector-only runs). It is
    judged into `qrels-dev-v2`, and the dev baseline is re-measured under groups-v1. §1's
    baseline is replaced by that measurement.
  - P-5. The ADR 0003 and 0004 amendments merge (§9).
  - P-6. **The pre-registration commit** (A-N3, A-6). It fixes:
    - every grid and finite candidate set: 3A-2 v1–v3, 3C-1/3C-2, the α and β grids, the 3E
      grid with w_c;
    - the selection statistic and tie-break;
    - the stopword list, edit thresholds, intent phrase lists, GE table and collision list;
    - "light" = 10 h, the raw/stripped margin, and the gibberish set and its 90% threshold;
    - the SC4 suite and the TTFB guard.
    
    The one exception: τ's candidate set is fixed before 3G's first dev run.
  - P-7. Jacob answers Q1 (SC5 reading), batched with Q2 (VPN) (§10).
- **Dev is open.** Every candidate runs `npm run eval -- --variant <v> --baseline <shipped>`
  (with `--target-shapes` where declared) and must pass the dev screen before its look.
- **One pooling round per workstream, before selection (A-6).** `eval:pool --runs
  <shipped>,<every grid point> --unjudged` pools the union of every grid point's top-10.
  - Judge A (`claude-opus-5-5`, single-judge protocol, ADR 0004) grades the round, with a 5%
    drift sample, and it merges to a new qrels version.
  - Only then is a point selected. judged@10 must be 100% for every run compared.
  - The pool step's output gives the actual new-pair count, which §6 bounds.
- **Selection statistic (pre-registered).**
  - Ranking:
    - general change: dev primary mean ΔnDCG@10 vs the shipped ranker;
    - targeted change: mean ΔnDCG@10 over the declared targets' answerable queries, among
      points with overall Δ ≥ 0.
  - Ties (equal to 3 decimals) go to the point nearest the shipped configuration: fewest changed
    parameters, then the smallest change, then grid order.
  - The second-ranked point is the change's **named retry candidate**, written into the PR before
    that change's look (A-N3). A change with no grid (3A-1, 3F) has no retry candidate.
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
  - This replaces r1's Δ-sign check on the 150 calibration pairs. Those pairs are v0-era: dev
    keeps only them, and encrypted sets refuse the check, so it could not inform a Phase 3 gate.
- **Holdout, custodian only.** Tuning agents never get the key and never decrypt; they see only
  the verdict lines. For each look the lead (custodian):
  1. stores the candidate (`--holdout --store-only`, no look);
  2. pools it encrypted (`--custodian --unjudged`);
  3. judges it with in-process subagents and merges;
  4. only then runs the verdict, so no look is spent `unjudged`.
  
  The ledger is committed after each look. Retries are the named runner-ups only, so the
  custodian directs no rework after seeing a verdict (A-N3).
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
  | L7 | 3F groups-v1 collapse | general |
  | — | 3G no-match | no look: SC4 + gibberish set + dev answerable ΔnDCG@10 ≥ −0.01 |
  | — | 3H intents | no look: SC4 + dev Δ ≥ 0 + custodian count (b) = 0; a reserve look if (a) ≥ 3 |
  | L8–L12 | reserve, **sealed reading** (5 slots) | as the original change |
  | L8–L11 | reserve, **holdout reading** (4 slots) | as the original change |
  | L12 | **holdout reading only**: frozen ranker vs `eval-v0`, the SC5 look | SC5 rule (BCa lower bounds of ΔnDCG@10 and ΔP@5 > 0) |

  **Arithmetic.**
  - r1: 9 change looks (L1–L9) + 2 reserve + 1 report (L12) = 12.
  - r2 change looks: 9 − 1 (3G, no look) − 1 (3H, no look) = **7** (L1–L7).
  - Stopwords and β add 0: each rides L3 or L5 only after passing dev alone, and is dropped
    otherwise.
  - SC5 on the holdout adds 0 under the sealed reading (r1's report-only L12 is dropped, A-N4),
    or 1 under the holdout reading.
  - Reserve = 12 − 7 − 0 = **5** (sealed) or 12 − 7 − 1 = **4** (holdout).
  - If 3H's count (a) ≥ 3, it takes one reserve slot, leaving 4 or 3. Either way ≥ 1 reserve
    slot stays.
  - The reserve funds at most one retry per failed change (its named runner-up), in order of
    failure. When one slot is left and more than one change is waiting, the waiting changes are
    bundled into that look, never a 13th. A change that fails with no retry is dropped.

## 4. SC4 acceptance suite (pre-registered)
- **Written by the lead** before any 3B–3H code merges, from the SC4 wording. Committed as
  `test/sc4/queries.json` at P-6, with rules, counts and thresholds fixed in the same commit.
  Implementers may not edit it; a change goes through the lead with the reason logged.
  - Dev is open, so named dev texts may appear, and each is listed: d-024 as an intent rule,
    d-079 as a GE guard.
- **Custody (A-N1).**
  - No holdout text enters the suite. The custodian runs the v2.1 code-overlap rule and the
    query-embedding cosine ≥ 0.9 check of every suite query against the holdout. The tool prints
    only the hit count and the hitting suite ids, and those suite queries are replaced.
  - The suite's texts and code targets join the test-set exclusion list and the test-set leak
    filter (§5).
- **Runs** the real Worker over the full pinned corpus and the bundle in the `full-corpus` CI job.
  Query embeddings are committed (*est.* ~90 texts with the gibberish set, < 5 neurons).
- **Every query has an exact expected `interpreted` JSON**, with `null` for every intent it must
  not set. Any difference fails (C-10).
- **Items, fixed counts, rules** (C-10, C-1, C-6):

  | item | n | rule |
  |---|---|---|
  | space code (`cs 1010s`, `ma 1521`, `cs1010 s`) | 5 | that code at rank 1 |
  | partial code or pillar (`CS32`, `cs101`, `cs 32`, `GEA`, `gec`, `ge`) | 6 | count > 0 and **all of the top min(10, \|prefix set\|)** are members of the prefix or pillar set |
  | typo | 5 | top-10 overlap with its clean form ≥ 7 |
  | level: beginner | 4 | no level ≥ 5 in the top 10, and a named level-1/2 answer in the top 3 (e.g. CS2109S, EE2211) |
  | level: graduate | 2 | every top-10 result level ≥ 5 |
  | level: N / year (`4000 level`, `level 3000`, `3rd year`, `cs 3000`) | 4 | every top-10 result at level N |
  | no-exam (incl. d-024's text) | 3 | 100% of results satisfy the constraint, and top-10 overlap ≥ 7 with (clean query + explicit param) |
  | S/U | 3 | as no-exam |
  | workload | 3 | as no-exam |
  | no prerequisite | 3 | as no-exam |
  | gibberish | 5 | `count: 0`, `noMatch.reason` `no-signal` |
  | non-existent code | 3 | `count: 0`, `noMatch.reason` `unknown-code` |
  | not-offered code | 2 | `count: 0`, `noMatch.reason` `not-offered`, `noMatch.title` equals the catalogue title |
  | guards | 24 | count > 0; no prefix route fired; ≤ 2 of the top 10 have a code whose letter part equals a letter-only query token |
  | **total** | **72** | |

  The guards include `art history`, `law and society`, `intro to psych`, `learn korean`, `AI`,
  `ai ethics`, `js`, `pr`, `comp 1010`, `math 1001`, `econ 1101`, `advanced calculus` (MA2311 in
  the top 10, no level intent), `not first year basics`, and d-079's text (no `GE\d` module in
  the top 10).
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
       - Pool v0 + final top-10, judge A in-process, then run the cross-family check on the
         differing pairs (reported).
       - Then **one look** on the test set: BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0,
         final vs `eval-v0` on the pinned corpus. No holdout L12.
     - **Holdout reading:** L12 is the SC5 look, final vs `eval-v0` on the holdout under the SC5
       rule. It is reported with the holdout's look count and the adaptive-reuse caveat from ADR
       0003. No sealed test set is written.
- **Labelling.** Results are labelled "offline replica". After 3-0, production's dense search is
  exact too, so the replica-vs-production caveat in ADR 0003 narrows to the corpus pin.

## 6. Cost and quota plan

Allowances (ADR 0004): D1 25B rows read and 50M written a month; Vectorize 50M queried dims a
month; Workers AI 10k neurons a day; live traffic ≤ 60 `/search` calls per agent per session.

| item | D1 read | D1 written | Vectorize queried dims | neurons | live `/search` |
|---|---|---|---|---|---|
| 3-0.0 embed-latency read (Workers Logs) | 0 | 0 | 0 | 0 | 0 |
| 3-0 cutover: `/admin/hashes` + values-only Vectorize upsert of 6,778 | ~6.8k | 0 | 0 (upserts; stored 2.6M of 10M) | ≤ 300 (missing texts, *est.*) | ≤ 4 smoke |
| deploys (≤ 8) via `versions upload`/`deploy`, guard read + smoke (≤ 4 each) | ~13k + ~54k (6.8k guard × 8) | 0 | 0 after 3-0 | ~2 | ≤ 32, ≤ 4 per session |
| SC7 counted run at the freeze | ~18k (45 × 406 mean) | 0 | 0 | ~2 (45 × 0.05) | 45, one session |
| SC7 declared re-run (colo shortfall only) | ~18k | 0 | 0 | ~2 | 45, another session |
| 3A-1 query prefix, all sets | 0 | 0 | 0 | < 15 | 0 |
| 3A-2 text variants (3 eval passes) | 0 | 0 | 0 | ≤ 7.2k, ≤ 2 passes a day | 0 |
| 3A-2 production (runbook) | ~30k | ~35k *est.* | 0 | ≤ 300 | ≤ 4 smoke |
| 3B `0008_catalogue` + load of ~14.4k catalogue-only rows | ~15k | ≤ 30k *est.* (rows + PK index) | 0 | 0 | ≤ 4 smoke |
| 3H migration 0007 + row-only ingest | ~30k | ~35–50k *est.* | 0 | 0 | ≤ 4 smoke |
| 3C-2 / rewrites (embed-missing cap) | 0 | 0 | 0 | ≤ 500 per run | 0 |
| verify after each corpus change (×4) | ~27k | 0 | `getByIds` sample only | 0 | 0 |
| SC4 suite + gibberish embeddings + live confirmation | ~8k | 0 | 0 | < 5 | ≤ 20 |
| **Phase 3 total** | **< 0.25M of 25B** | **< 0.15M of 50M** | **~2.6M (stored term) of 50M** | **≤ 5k on any one day** | **≤ 60 per agent session** |

**Judging (agent time, no Cloudflare cost).** These are upper bounds: dev has 98 queries × 10 =
980 top-10 slots per run. Most slots repeat already-judged pairs. Each round's pool step prints
the actual new-pair count before packets are prepared.

| round | runs pooled (besides the shipped one) | new pairs ≤ | cross-family pairs ≤ |
|---|---|---|---|
| P-4 (v0 under groups-v1, 3A-1, deep pool of 4 mapping queries) | 1 + 2 single-mode top-50 | 980 + 400 | — |
| 3A-2 (v1–v3, dense-only + hybrid) | 6 | 5,880 | 1,960 |
| 3B (codes + GE, `stopwords-v2` alone) | 2 | 1,960 | — |
| 3C (3C-1, 3C-2) + diagnostic set (own qrels) | 2 + 2 | 1,960 + diag | — |
| 3D (α × 3, β × 3) | 6 | 5,880 | 1,960 |
| 3E (15 new points) | 15 | 14,700 | 1,960 |
| 3F, 3H | 1 each | 980 each | — |
| holdout, per look (custodian) | 1 | 810 | — |
| SC5 test pool (sealed reading) | 2 (v0, final) | ~20 per query | ~20 per query |

"Cross-family pairs ≤" is 20 per query (the symmetric difference of two top-10s) × 98.

Other rules:
- The ingest and a corpus eval pass never run on the same UTC day.
- Every remote D1 operation, reads included, is estimated and logged in `remote-ops.md`.
- Every write first gets the ADR 0004 headroom check: estimate × 1.5 must fit the remaining
  allowance.
- Every neuron spend goes into `neurons.tsv`.

## 7. Risks
- **Bundle size and startup**: 10.4 MB could slow cold isolates outside `total`. The mitigations
  are the `versions upload` startup gate, the sparse TTFB guard, and int8 or a static asset as
  fallbacks.
- **Deploy-coupled freshness**: no deploy after an ingest leaves the dense half stale. The deploy
  guard refuses a manifest whose `rowsKey` or data version differs from D1's. Verify and `/health`
  compare the bundle's data version. The dense rows are re-filtered against fresh D1 rows.
- **Embed latency** (sparse 227 ms, post-switch 260–414 ms) is outside our control, and the warm
  p67 sets SC7. Step 3-0.0 measures it before 3-0 is built, and Q3 goes to Jacob if it
  threatens SC7. If the counted run fails, it fails. The plan does not change the rule.
- **Dev overfitting**: 98 queries, SC4 shapes of 3–7. Mitigations:
  - grids are finite and pre-registered;
  - selection happens after full judging of every point;
  - retries are named in advance;
  - the holdout screens each change, and the SC5 set decides.
- **Look exhaustion**: 7 planned looks and 4–5 reserve. The fallback is to bundle rather than
  take a 13th.
- **Intent parser false positives**: the collision list and the "known prefix only" rule stop
  `AI`, `js`, `comp 1010` from routing. Hard level and intent filters are echoed and undoable.
  The SC4 guards and exact `interpreted` JSON pin each case down.
- **Hard beginner exclusion** removes level ≥ 5 even where a student might accept one. It is
  echoed so the UI can undo it.
- **Exam data semantics**: a missing `examDate` is not a certified "no exam". The mitigations are
  the UI copy and the echoed interpretation.
- **No-match hides real long-tail answers**: three signals must all agree. Dev answerable loss is
  capped at 0.01, and the SC4 guards must stay non-empty.
- **Single same-family judge** (ADR 0004) grades every new pair. The per-round cross-family check
  on the differing pairs is the mitigation. Its verifiers are Claude, so the risk is lowered,
  not removed.
- **SC7 collection conditions**: last time the VPN gave 3 SIN sparse samples of the 10 needed. Q2
  asks Jacob, and the declared re-run covers one more colo shortfall.
- **Response shape changes** (`variants`, `noMatch`, `interpreted`, `ignore`, new params,
  `x-ranker-version`) are public API changes: branch and PR, consumed by Phase 5.

## 8. Exit criteria
- SC7: the counted re-measurement at the frozen ranker passes the pre-registered rule, with
  evidence in `docs/evidence/phase3/sc7.md`. The B6 fallback tests pass, and the 3-0 TTFB guard
  passes.
- SC4: the acceptance suite is green in CI at `phase3-final`, and the live confirmation agrees.
- SC5: one SC5 look passes, under the reading Jacob chose before L1.
- FINDINGS S2–S8 are `fixed` (or `rejected` with a reason). README's cost section names the new
  binding limit. ADR 0006 records the in-Worker dense search, the vectors artifact and deploy
  guard, and Vectorize's standby role.

## 9. ADR amendments needed
| ADR | amendment | objections | when |
|---|---|---|---|
| 0003 | **No-answer set fixed by tag** for any change: `noanswer`, `code-nonexistent` or `noAnswerByRule`. Emptying any other query is answerable loss. An untagged query with no grade-≥1 document stays out of both sets and is listed in every report. | A-1, C-3 | P-5, before L1 |
| 0003 | **3G gated without a look**: SC4 + the gibberish set (≥ 90%) + dev answerable ΔnDCG@10 ≥ −0.01. | A-1, C-3 | P-5 |
| 0003 | **3H gated without a look**: SC4 + dev Δ ≥ 0 + the custodian's two-number count from `--store-only` runs, which is not a look. A reserve look if count (a) ≥ 3. | A-N4 | P-5 |
| 0003 | **SC5 reading** recorded as Jacob decides it, with L12 per reading (sealed: none; holdout: the SC5 look). | A-3 | P-7 |
| 0003 | **groups-v1** named as the duplicate-group rule for dev, holdout, test and the product, with the `eval/groups.json` hash in the locks. | A-2, C-8 | P-1/P-5 |
| 0003 | **SC4 custody and test-set exclusions**: the count-only overlap check against the holdout; SC4 and gibberish texts join the test-set exclusion and leak filter; the count-only test answerable tool is not a look. | A-N1, A-N9 | P-5 |
| 0004 | **Per-round cross-family check** (Gemini + Sonnet verifier, blind to A) on differing pairs for 3A-2, 3D, 3E and the SC5 test pool. It replaces the calibration Δ-sign report, and an opposite sign on dev stops the change before its look. | A-N2 | P-5 |
| 0006 (new) | In-Worker exact dense search; vectors artifact and manifest `rowsKey`; deploy guard and `versions upload` startup gate; runbook order; cache key `ev`/`rv`; Vectorize as an identical standby; rollback floor `597c2b7`. | B-1…B-11, A-N5 | with 3-0's PR |

## 10. Gate questions for Jacob
Q1 and Q2 go together, before L1. Q3 is asked only if step 3-0.0 triggers it.

- **Q1. Which set decides SC5?** The default reading is the sealed test set: written fresh
  after the freeze and looked at once, with the holdout reported as secondary. The other option
  is the holdout itself, which by then has been used for up to 11 per-change decisions, so it
  carries a reuse caveat.
  - Sealed: we keep 5 spare holdout looks and write a new test set at the end.
  - Holdout: we keep 4 spare looks, the 12th look is SC5, and no test set is written.
  
  The answer is needed before the first holdout look (L1), so it isn't chosen after seeing
  results.
- **Q2. Can the VPN be off for the SC7 run at the freeze?** The run takes about 2 hours: 33 warm
  calls, then 12 calls 10.5 minutes apart. Last time the Mullvad exit sent 3 of 6 sparse calls to
  Tokyo or Marseille, which left 3 Singapore samples of the 10 needed. If the VPN stays on, we
  use the nearest-APAC-colo clause and the one declared re-run, and accept that the sample may
  still fall short.
- **Q3 (only if triggered). Should 3-0 go ahead if embed time alone threatens SC7?** Step 3-0.0
  reads the warm embed times logged since the APAC switch. If the projected warm total (the
  67th percentile, which decides SC7) is above 200 ms, exact vector search alone may not get SC7
  under 250 ms. The options:
  - build 3-0 anyway: it still removes ~230 ms of Vectorize time, but SC7 may fail on embed time;
  - pause 3-0 while the lead plans an embed-side change.

Not a Phase 3 gate: whether exchange students may S/U at all (C-12) needs a registrar source and
goes to Phase 4 as an open question.

## 11. Objection log (round 1)
Three independent critics reviewed r1 (PR #27, head 40c5ec0): A on eval discipline, B on
vectors, ingest and cost, C on SC4 and student queries. The lead's default was to accept each
objection with its proposed fix, with the choices below where critics overlapped. "Applied"
means the critic's fix is in r2 as proposed.

| # | Objection (short) | Disposition | Where in r2 |
|---|---|---|---|
| A-1 | 3G cutoff can't pass: dev no-answer is mostly pool misses | Applied: no-answer set fixed by tag (ADR 0003 amendment); 3G gated by SC4 + gibberish set + dev answerable ΔnDCG ≥ −0.01, no look | §1, 3G, §3 table, §9 |
| A-2 | Eval not group-aware; groups-v1 uses another rule than 3F | Applied: 3F uses groups-v1; it merges before L1; re-baseline at P-4 | §1, 3F, P-1, P-4, §9 |
| A-3 | SC5 sign-off after the freeze is too late | Applied: sign-off before L1 (Q1); L12 defined per reading | §5, §3 table, §10 Q1 |
| A-4 | Stopwords (L3) and β (L5) ride the targeted route | Applied: each screened alone under the CI rule; bundled only if it passes alone | 3B, 3D, §3 table |
| A-5 | L3 dev screen fails by construction | Applied: 3B pool judged first; targets with 0 answerable queries dropped by a stated rule | 3B "Measured" |
| A-6 | Grid selection on incomplete judgments | Applied: one pooling round over the union of every grid point; selection statistic and tie-break pre-registered; w_c declared; pair counts | §3, 3E, §6 judging table |
| A-N1 | SC4 custody weak | Applied: custodian count-only overlap check; SC4 texts in test-set exclusion and leak filter; fresh live-confirmation queries at the freeze | §4 custody, §5, §9 |
| A-N2 | Calibration Δ-sign check uninformative | Applied: per-round blind Gemini grade + Sonnet verifier on differing pairs for 3A-2, 3D, 3E and the SC5 test pool (ADR 0004 amendment) | §3, §6, §9 |
| A-N3 | Pre-registration gaps; retries directed by the custodian | Applied: P-6 commit fixes every finite set and parameter; retries are the named dev runner-ups | §3 P-6, selection, 3A-2, 3C, 3D, 3H |
| A-N4 | No look slack | Applied: L12 dropped under the sealed reading; 3H gated by SC4 + custodian count (ADR 0003 amendment); its look returns to the reserve | 3H, §3 table, §9 |
| A-N5 | Response cache key ignores the ranker | Applied with B-7: one key change, `ev` + `rv`, plus `x-ranker-version` checked in SC7 | 3-0 cache key |
| A-N6 | 3-0 identity harness gaps | Applied: builder refuses missing `textHash`; results compared, not `treeHash`; 1e-6 near-tie tolerance | 3-0 vectors artifact, eval fidelity |
| A-N7 | SC7 run count and conditions | Applied: one counted run at the freeze; one re-run on a declared colo-shortfall condition; TTFB guard threshold pre-registered | 3-0 SC7 re-measurement |
| A-N8 | 3C diagnostic would break the dev lock | Applied: separate `--set-dir` with its own qrels | 3C |
| A-N9 | No count-only tool for the test answerable count | Applied: `eval:count --set test` | §5, §9 |
| B-1 | Vectorize not an identical standby at cutover | Applied: values-only `/admin/vectors` upserts the 6,778 bundle vectors in place | 3-0 Vectorize standby, §6 |
| B-2 | 3A-2 order fails the deploy guard | Applied: manifest `rowsKey` vs `/admin/hashes`; order embed → asset → ingest with values → commit → deploy | 3-0 deploy guard, runbook, 3A-2 |
| B-3 | Stale filter table between ingest and deploy | Applied: `localMatchesFilters` (with 3H fields) on hydrated dense rows, plus a test | 3-0 runbook |
| B-4 | Startup gate can't use `--dry-run` | Applied: `versions upload` → `startup_time_ms` ≤ 200 → `versions deploy <id>@100%`; `wrangler check startup` locally | 3-0 startup gate |
| B-5 | `vector` span ~0 (clock frozen in CPU work) | Applied: CPU time from Workers Logs; cold and warm microbenchmark | §1 code, 3-0 CPU |
| B-6 | Estimate should use warm p67; embed risk | Applied: p67 basis shown; step 3-0.0 reads embed spans first; Q3 if projected > 200 ms | §1, 3-0.0, expected latency, §10 Q3 |
| B-7 | Cache key lacks the embedding/bundle version | Applied with A-N5 | 3-0 cache key |
| B-8 | Rollback recipe | Applied in part: version ids recorded, `wrangler rollback <id>`, floor `597c2b7`, bookmark before the D1 step. The Vectorize upsert waits for the smoke; the D1 step cannot (dissent 1) | 3-0 rollback, runbook |
| B-9 | Gitignored vectors break CI and fresh checkouts | Applied: alias defaulting to a committed fixture module; `full-corpus` downloads and sha-checks | 3-0 fresh checkouts |
| B-10 | Log every remote D1 op, reads included | Applied | 3-0 runbook, §6 |
| B-11 | Neurons with prefix; 3C-2 second embed | Applied: ~0.05/query, ~200k/day; 3C-2 uses a parallel single-text call | 3-0 neurons, 3C, §6 |
| C-1 | Partial-code/pillar rule unmeetable | Applied: whole-query partial code → hard mask by dense score; third RRF list only inside longer queries; w_c in the 3E grid; rule = top min(10, \|set\|) all members | 3B, 3E, §4 |
| C-2 | Prefix-collision guard wrong; GE → Geography | Applied: letter-only tokens never prefix-route in multi-token queries; committed collision list; GE intent → pillar prefixes only; guards `AI`, `ai ethics`, `js`, `pr`, d-079 | 3B, §4 guards |
| C-3 | 3G almost never fires; 3C corrects gibberish into vocabulary | Applied: vocabulary test on pre-correction tokens; correction only for ≥ 5 letters; the 4 mapping queries judged at P-4; pre-registered gibberish set | 3C, 3G, P-4 |
| C-4 | Intent phrases stay in the keyword query | Applied: stripped from the keyword query; dense raw vs stripped as a pre-registered dev diagnostic; d-024 as an SC4 rule query | 3H, §4 |
| C-5 | S7 prerequisite part missing | Applied: `prereq=none` (prerequisite IS NULL), phrases stripped, SC4 rule, filter-table bit | 3H, §4 |
| C-6 | Level rule contradicts the soft prior | Applied: per-direction rules; beginner = hard exclusion of level ≥ 5, echoed and undoable; median rule replaced by a named level-1/2 answer in the top 3 | 3D, §4 |
| C-7 | Unknown-code rule empties ordinary queries | Applied: only a known prefix makes a token code-shaped; `XX N000` = level intent; catalogue-only codes → `not-offered` with title and dense neighbours of the catalogue text | 3B, §6 |
| C-8 | 3F doesn't fix S8 | Applied with A-2: groups-v1 (same title + code stem) groups TR3202I/N/S/T; variants carry credits | 3F |
| C-9 | No prefix matching for S4 | Applied: df-0 tokens ≥ 4 letters → FTS prefix term before edit distance | 3C |
| C-10 | SC4 suite not pass/fail | Applied: fixed counts, exact `interpreted` JSON, guard and intent rules as proposed, live rules on codes in both catalogues | §4 |
| C-11 | Workload: zero arrays, "light" undefined | Applied: zero → NULL, excluded, "not listed"; light = fixed 10 h, reason stated | 3H |
| C-12 | S/U semantics | Applied: `su=1` := su OR CS/CU, echo which; `grsu` and the registrar question go to Phase 4; no exchange S/U claim in Phase 3 copy | 3H, §10 |
| C-13 | Level phrase patterns and negation | Applied: `4000 level`, `3rd year`, negation, `advanced` alone not an intent; guards | 3D, §4 |
| C-14 | Spaced and partial codes | Applied: canonicalise letters + space + digits and code + space + suffix | 3B |
| C-15 | Fixture lacks the 3H fields | Applied: rebuild after the `NORMALISER_VERSION` bump with examples of each intent | 3H |

**Dissent and partial application.**
1. **B-8, "delay step 5 until smoke passes"** (applied in part). r1's step 5 was one ingest that
   wrote D1 and Vectorize after the deploy. B-2's guard needs D1's text hashes to match the
   manifest *before* the deploy, so the D1 half cannot wait for the smoke. r2 splits the step:
   - the D1 write runs before the deploy, behind a Time Travel bookmark, and is restored from it
     if the smoke fails;
   - the Vectorize upsert waits for the smoke, as B-8 asks.
   
   B-8's intent, that a bad deploy can be undone with nothing lost, holds. The literal ordering
   holds for the Vectorize half only.

Decisions that go beyond a critic's text, recorded so they can be challenged in round 2:
- 3H's custodian count gets a pass rule ((b) = 0) and a reserve-look trigger ((a) ≥ 3). A-N4
  names the count but no threshold.
- `no background` sets both the beginner intent (disposition 7) and `prereq=none` (C-5). Each is
  echoed and undoable on its own.
- The unscored untagged queries (no grade-≥1 document after P-4) are listed rather than tagged,
  so the dev lock does not change.
- Proposed thresholds, each fixed at P-6:
  - gibberish set ≥ 90%;
  - raw-vs-stripped margin 0.05;
  - TTFB guard 200 ms;
  - "light" = 10 h.
