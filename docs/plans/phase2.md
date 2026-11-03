# Phase 2 plan — a real eval (draft r1)

Goal (exit): the harness is reproducible from one command; baseline numbers for the current
ranker (commit `3b18041`) recorded in EVAL.md. This enables SC5 (Phase 3): shipped ranker beats
the current one on the held-out set on nDCG@10 and P@5 with a paired bootstrap 95% CI excluding 0.

Fixes S1: the old eval is circular (relevance = regexes on the query's own words), order-blind
(recall@10), tidy-English-only, run at topK=10 while production runs depth 50, never re-measured
after `ORDER BY rank`.

## 1. Queries (≥ 150, target 180)
- Written by **persona-writer subagents** who never see the corpus or search results: 6 personas
  (e.g. German business exchange student, US CS junior, Korean engineering student, Australian
  arts/humanities student, French life-sciences student, a postgrad exchange student) plus a
  "generic Reddit question" voice. Each writes queries in their own words with a pre-registered
  **intent narrative** ("relevant = …; partially relevant = …; not relevant = …") and any hard
  constraints (semester, exchange, level) — the narrative is written before any results exist.
- Quotas by shape (tags on each query; a query may carry several):
  topical natural language 60 · abbreviations/jargon 15 · typos 15 · exact/space/partial codes 20 ·
  GE pillars 10 · level intent ("for beginners", "advanced") 15 · constraint intents (no exam, S/U,
  light workload) 15 · exchange scenarios with sem/ng/level 20 · no-answer/gibberish 10.
- Dedupe (normalised text), no editing for the corpus.

## 2. Split and lock
- Stratified by shape tag, seeded RNG: 60% dev, 40% holdout (≈ 108/72).
- `eval/holdout.v2.json` sha256 recorded in **ADR 0003** at creation; CI fails if it changes.
- Tuning agents (Phase 3) are told not to open the holdout; the eval CLI prints only aggregate
  holdout numbers. Every holdout evaluation is appended to `eval/holdout-ledger.md` (date, commit,
  variant, numbers) so the number of looks is visible.

## 3. Judging (blind, pooled, ≥ 2 judges)
- Pool = union of top-20 from every variant: BM25 baseline (offline), current lexical, current
  vector, current hybrid (all at `3b18041` behaviour), plus later Phase 3 variants (incremental
  judging of new unjudged documents with the same protocol). Shuffled, no system/rank info.
- Judges get: query, intent narrative, constraints, and for each candidate: code, title, level,
  semesters, NG semesters, units, description (full), prereq. Grade 0/1/2 against
  `eval/JUDGING.md` (written criteria; hard-constraint violations are 0).
- ≥ 2 independent judge subagents per query (different model families/instances: one Opus, one
  Sonnet), batches of ~15 queries per judge run. Agreement: quadratic-weighted Cohen's κ overall
  and per shape; target κ ≥ 0.6, report whatever it is. Disagreements (|Δ| ≥ 1) → third
  adjudicator judge sees both grades + rationales; adjudicated grade final.
- Judgments stored in `eval/qrels.v2.json` with judge ids and rationales.

## 4. Running retrieval (offline replica, no live traffic)
- The eval runs the **actual Worker code** under the Vitest harness: full pinned corpus in local
  D1 (same migrations, same FTS5), fake Vectorize loaded with **real corpus embeddings**, fake AI
  returning **real precomputed query embeddings**. Production configuration (defaults, depth,
  topK=20 returned, metrics on top-10).
- Embeddings: produced by Workers AI `@cf/baai/bge-small-en-v1.5` via the REST API from a local
  script (`scripts/embed.mjs`, uses the local wrangler OAuth token, never in CI), stored as
  versioned release assets keyed by (model, embedding-text version): corpus ~6,771×384 f32 gz,
  queries as JSON. Cost: ~2–3k neurons per corpus embedding pass (free 10k/day). Alternative
  rejected/considered: exporting production vectors with `getByIds` (exact match but billing for
  getByIds unclear; also can't produce Phase 3 variant embeddings) and local ONNX (no Cloudflare
  cost, but fidelity to Workers AI unproven).
- **Fidelity check**: for 10 queries, offline vector-mode top-10 vs live `mode=vector` top-10
  (≤ 10 live calls) — expect ≥ 9/10 overlap; offline lexical vs live lexical identical.
- Baseline: run once at `3b18041` (worktree at that ref with the harness copied in) → frozen run
  file `eval/runs/v0-3b18041.json`. Later variants produce run files; metrics computed from run
  files + qrels, so the baseline never needs re-running.

## 5. Metrics
- nDCG@10 (gain 2^g − 1), P@5 (relevant = grade ≥ 1), MRR (first grade ≥ 1), per query; macro
  mean over answerable queries. No-answer queries scored separately: "correct empty" rate and
  false-positive count (any result returned counts as FP until Phase 3 adds a cutoff).
- Unjudged documents in a run's top-10 count as non-relevant; **judged@10 coverage** reported per
  run; a run with coverage < 95% must be judged before its numbers are used for a gate.
- Paired bootstrap (10,000 resamples over queries, seeded) 95% CI for Δ vs baseline.
- Per-shape breakdown.

## 6. Pre-committed gate (ADR 0003, written before any Phase 3 change)
A Phase 3 change ships iff, vs the currently shipped ranker:
1. dev: ΔnDCG@10 point estimate > 0 and no shape tag regresses by more than 0.05 nDCG@10;
2. holdout: ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates), judged@10 ≥ 95%;
3. no regression in exact-code queries (code at rank 1 stays at rank 1).
SC5 (end of Phase 3): final shipped ranker vs `v0-3b18041` on holdout: nDCG@10 and P@5 paired
bootstrap 95% CI lower bound > 0.

## 7. One command
`npm run eval` → builds/loads corpus + embeddings (from release assets, sha-checked), runs the
named variant(s) through the Worker in the harness, writes `eval/runs/<variant>.json`, prints the
table with CIs, and appends to the ledger when `--holdout` is passed. `npm run eval:judge` prints
the unjudged pool for a run (judging itself is agent-driven, documented in JUDGING.md).
Old `scripts/eval.mjs`, `judge*.mjs`, `pool.mjs`, `baseline.mjs` and `eval/*.json` v1 moved to
`eval/v1/` and marked historical.

## Quota
Live: ≤ 10 `/search` (fidelity). Workers AI: one corpus pass + ~200 query embeddings (~3k neurons).
No D1/Vectorize remote use.

## Exit criteria
`npm run eval` reproduces baseline numbers from a clean checkout (+ release assets); EVAL.md
has the baseline table with CIs, κ, judged coverage; ADR 0003 has the holdout hash and gate.

---
# r2 amendments (supersede r1 where they conflict)

## Three query sets
- **dev** (tuning, open), **holdout** (per-change gate, as the brief requires, verdict-only),
  **test** (sealed; SC5). The test set is written **after Phase 3 freezes** by fresh
  persona-writer runs from prompts + seeds pre-registered now in ADR 0003, pooled (v0 + final),
  judged with the same protocol, and evaluated exactly once. This removes the adaptive-reuse
  inflation critic A simulated (14% false-positive SC5 at 9 changes vs 2.5% nominal).
- Holdout protection: holdout queries + qrels live only as an age-encrypted release asset; the
  key is in the macOS keychain and a GitHub secret, never given to tuning agents. `npm run eval
  -- --holdout` decrypts in memory and prints only the gate verdict + overall Δ with CI (no
  per-query, no per-shape output). Ledger counts looks; ≤ 12 holdout looks in Phase 3.
- Split by **topic cluster** (embedding similarity of query + narrative, agglomerative), then
  stratified by shape; dev 55% / holdout 45%.

## Queries reflect exchange students
- Every query carries `filters` = the UI state the persona would set (most exchange queries:
  `ng=1&sem=N`; some unfiltered). Primary metrics run **with filters**; unfiltered is secondary.
  Hard constraints are applied as API filters (structural), and constraint violations@10 are
  reported separately; pre-grading marks violating docs 0 mechanically before judges see them.
- Personas: undergrad incoming exchange students only (NG list has 0 level-6 and 28 level-5
  modules → postgrads out of scope, recorded). Personas: business (Europe), CS (US), engineering
  (Korea), arts/humanities (Australia), life sciences (France), one modelled on Jacob's real
  exchange (Newcastle CS; anchors from his allocated/unallocated picks, non-identifying).
- Shapes (target 180): topical NL 45 · home-course mapping (pasted home course title/outcomes,
  incl. > 200 chars, which today returns 400) 20 · alternatives/backups ("like X but…", "backup
  for CS3219") 10 · language modules 8 · Singapore/SE-Asia content 8 · level equivalence/ECTS 8 ·
  abbreviations/jargon 12 · typos 15 (generated by a keyboard/phonetic noise model from clean
  queries) · codes exact/space/partial 18 (validated against the corpus; non-existent codes are
  no-answer by rule) · GE pillars 6 · level intent 12 · constraint intents (no exam, workload,
  exam timing) 10 — reported as a **feature-gap** block, not averaged into the primary metric ·
  no-answer/gibberish 8.
- Pre-registered **answerable rule**: a query is answerable iff ≥ 1 judged doc has grade ≥ 1.

## Metrics (changes)
- nDCG@10 with gain 2^g−1, **duplicate-group aware**: qrels mark variant groups (same title
  family, e.g. TR3202I/S/T, cross-listings); only the first member of a group earns gain.
- P@5 (grade ≥ 1, divisor 5), MRR. No-answer: correct-empty rate; pre-registered trade-off for a
  cutoff change: ships iff correct-empty gain ≥ 0.25 and answerable nDCG@10 loss ≤ 0.01.
- Paired bootstrap (BCa, 10k, seeded) + paired sign-flip randomisation test as a cross-check;
  persona-clustered bootstrap reported alongside.
- Qrels versioned; every compared run recomputed under the same qrels version; judged@10 must be
  **100%** for any run used in a gate.
- Power statement: with ~65 answerable holdout queries, ~80% power at ΔnDCG@10 ≈ 0.06.

## Gate (changes)
Per change: dev ΔnDCG@10 BCa 95% lower bound > 0 **or** (targeted-shape Δ > 0 and overall dev
Δ ≥ 0, for changes that only touch one shape, e.g. typo correction); shape tripwire only on the
targeted shapes (one-sided CI); holdout verdict: Δ point estimates ≥ 0 on nDCG@10 and P@5, no
exact-code regression, judged 100%. SC5 on the sealed test set: CI lower bounds > 0 for both.

## Judging (changes)
- Pool = union of **top-10** of every variant run with filters (+ unfiltered secondary runs);
  new variants' top-10 judged before gating.
- Judges from **different families**: Claude Opus and Gemini 3.1 Pro (via delegate_task),
  1–3 queries per judge call, results written to file per query, ~12 queries per agent run,
  shuffled order, ~5% planted repeats for self-consistency. Adjudicator (Claude Sonnet) grades
  blind first, then sees both grades and reconciles.
- Agreement: raw agreement, Krippendorff ordinal α, binary κ at grade ≥ 1, quadratic κ.
- **Human calibration**: ~150 stratified pairs graded by Jacob (decision-gate item; not blocking
  the baseline). Report Δ(final − v0) sign under judge A, judge B, adjudicated and human subset.
- Drift: each new judging batch re-judges a 5% sample of old pairs.

## Mechanics (changes)
- Baseline at tag **`eval-v0` = 7ac9841** (behaviourally identical to 3b18041, esbuild-proven),
  using that commit's own migrations and harness, run before Phase 1 merges; frozen run file.
  "Reproducible" = metrics recompute from frozen runs + qrels in one command, and any variant at
  HEAD re-runs retrieval in one command.
- Run/qrels files carry corpus version (moduleInfo sha + NG sha) and embedding version.
- Results leave workerd via a custom Vitest reporter reading `task.meta`; embeddings enter as
  one base64 Float32 string via `provide`/`inject` (nested arrays crash the pool). One test per
  query (timeouts).
- `scripts/embed.mjs`: token from `wrangler auth token` per run, model default pooling, batch 100.
- Fidelity: 15 live calls — hybrid mode, includes filtered queries; RBO and top-10 overlap vs
  offline; acceptance RBO ≥ 0.8. Lexical must match exactly.

## Objection log (round 1)
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 1 | A | shared holdout inflates SC5 false positives | sealed post-freeze test set for SC5 |
| 2 | A | paraphrase leakage; holdout readable by tuners | topic-cluster split; encrypted holdout; verdict-only CLI |
| 3 | A | metrics auto-reject dedupe and cutoff | duplicate-aware nDCG; pre-registered no-answer trade-off |
| 4 | A,B | constraints undefined (filters vs text) | per-query `filters`; structural; violations reported |
| 5 | B | query mix ≠ exchange students | reshaped quotas; home-course mapping, alternatives, Jacob anchors; postgrad dropped |
| 6 | B | baseline worktree at 3b18041 unsafe | tag eval-v0 = 7ac9841 with own migrations |
| 7 | B | results can't leave workerd; embeddings transport | reporter via task.meta; base64 Float32 |
| 8 | A | power / tripwire / bootstrap calibration | power statement; targeted tripwire; BCa + sign-flip |
| 9 | A,B | same-family judges; κ paradox; adjudicator bias | Opus + Gemini; α + binary κ; blind-first adjudication; human calibration |
| 10 | A | incremental judging / qrels drift | versioned qrels; 100% judged@10; drift sample |
| 11 | A | fidelity check too weak | hybrid + filtered, RBO |
| 12 | B | judging batch size | 1–3 queries per call, files per query |
| 13 | A,B | typos, codes, answerable rule | noise model; corpus validation; pre-registered rule |

---
# r3 amendments (round-2 objections; supersede r2 where they conflict)
- **Holdout protection is procedural, stated honestly in ADR 0003**: a named **custodian** (the
  lead) holds the age key; holdout queries, qrels, run files, query embeddings and judge outputs
  are stored only age-encrypted (`eval/holdout/*.age`); tests use opaque ids (`h-017`) and only
  the custom reporter prints; holdout judging is dispatched only via in-process subagents (not T3
  threads that tuning agents could search); Phase 3 tuning implementers are briefed not to
  decrypt and never receive the key. The ledger counts looks (≤ 12). This is honour-system plus
  encryption at rest, and ADR 0003 says so.
- **Sealed test set leak filter**: pre-registered near-duplicate rule vs dev ∪ holdout (same
  embedding, cosine ≥ 0.9 on query text, or same source query for derived typo/code variants) →
  dropped; count reported; SC5 reported on the filtered set (unfiltered secondary). Target
  **≥ 160 answerable** test queries (power for P@5, critic C), pre-registered.
- **v0 runner**: tag `eval-v0` (= 7ac9841) + the Phase 2 runner overlaid (src + migrations from the
  tag, runner from HEAD), pinned to corpus `data-2026-2027-20260904` and that ranker's embedding
  assets. SC5 runs v0 and final on the **same pinned corpus** (embedding text is part of each
  ranker). "Frozen v0 run" = cache, not a requirement; v0 can re-run any time.
- **Group-aware P@5 and MRR** (only the first member of a duplicate group counts) and group-aware
  IDCG (one ideal doc per group).
- **Splits by provenance first** (derived typo/code variants follow their source), then topic
  cluster, then stratify by shape.
- Cutoff changes: the no-answer trade-off rule governs on **holdout** for changes whose purpose is
  the cutoff; the general gate governs everything else.
- Non-existent-code queries are excluded from the answerable set by rule and scored only on
  "nothing pinned / correct empty".
- SC5 reading (sealed test set as "the held-out set"; holdout reported as secondary; test set
  governs on disagreement) recorded in ADR 0003 and queued for Jacob's sign-off at the next gate.
- Fidelity check runs **before Phase 1 deploys**; lexical compared up to tie-group order after a
  row-count check; failure branch: investigate before any gating (no gating on an unfaithful replica).
- Judges named: `claude-opus-5-5` and `gemini-3.1-pro-low` (CLI Proxy API provider); adjudicator
  `claude-sonnet-5-5`. "Seeds" = seeds for persona/shape assignment only.
- Fake AI fails loudly for any text without a precomputed embedding; a reranker (Phase 3) needs
  recorded scores the same way.

## Objection log (round 2)
| # | Critic | Objection | Resolution |
|---|---|---|---|
| 14 | C | holdout leaks via run files, embeddings, test names, judge threads | procedural custodian + encryption at rest + opaque ids + in-process judging; ADR states it honestly |
| 15 | C | sealed test set paraphrase leakage | pre-registered near-dup filter vs dev∪holdout |
| 16 | C | SC5 needs v0 re-run; contradicts frozen mechanics | v0 runner = tag + overlaid runner on pinned corpus |
| 17 | C | P@5/MRR not duplicate-aware | group-aware P@5, MRR, IDCG |
| 18 | C | test N / power; brief wording; derived-query leakage; small contradictions; fidelity timing; model names; fake AI | all addressed above |

---
# Final (round-3 cap reached; lead decisions)
Supersession: r1 §4's "worktree at 3b18041", r1 quota "≤ 10 /search" (now 15), r1 §2's
`holdout.v2.json` plaintext hash (now: ciphertext hash of `eval/holdout/*.age`) are void.

1. **Query-text-altering variants** (typo correction, rewriting, expansion): `npm run eval` (local,
   never CI) embeds texts missing from the cache via Workers AI REST with a per-run neuron cap
   (default 500 neurons, logged), appending to the plaintext dev cache or, under `--holdout`, to
   the encrypted holdout cache. Only the custodian runs `--holdout`. CI evaluates dev only, from
   the committed cache, and fails loudly on a miss ("run npm run eval:embed locally").
2. **Gemini judges vs in-process isolation**: Gemini is only reachable through `delegate_task`
   (T3 threads). Decision: holdout/test judging uses delegate_task for the Gemini judge;
   isolation from tuning agents is procedural (tuning briefs forbid reading other threads).
   ADR 0003 states this plainly; no claim of technical isolation.
3. No CI secret holds the age key; CI checks only the ciphertext hash.
4. SC5 governing statistic: BCa paired bootstrap over queries; clustered bootstrap and sign-flip
   reported. If Jacob rejects the sealed-test reading, SC5 is reported on the holdout with the
   look count and an explicit caveat. No 13th holdout look: tuning stops at 12.
5. Test-set N: keep writing (≤ 2 extra persona rounds) until ≥ 160 answerable after the leak
   filter; otherwise report the shortfall and the resulting power.
6. Adjudicator sees only disagreements; grades blind first, then reconciles.
7. The ADR records that per-change gates are screening; false-positive control rests on the sealed
   test set.
