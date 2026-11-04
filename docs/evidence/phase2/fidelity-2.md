LIVE CALLS DONE 2026-11-04T06:22:59Z

# Phase 2: second live fidelity check (Phase 1 production vs the head replica, dev)

The method, the acceptance rule and the analysis self-test below were written and committed
**before** any live call of this check (see `git log` for this file). Results follow in the
second half. The first check is `fidelity.md`; this one keeps its method and rule except where
Phase 1 changes what they can test, and each change is listed below.

## Method

### What is compared

**Production.** `https://vector-nusmods.jacobjameswiltshire.workers.dev`, read-only.
- Code: the Phase 1 Worker. Its `src/` at `8d94982` is identical to `c2d37d5` apart from
  `src/data-version.json`, which only enters the cache key.
- Data: force re-ingested 05:44–05:47 UTC on 2026-11-04 from the pinned snapshot
  `data-2026-2027-20260904` (`docs/evidence/phase1/remote-ops.md`): 6,771 modules upserted, every
  corpus vector re-embedded by production's Workers AI in batches of 50, 0 deleted, verify clean,
  data version `c25f43ebfbdb`. Production holds exactly the pinned corpus until the next catalogue
  ingest, which runs after this check's live calls.

**Replica.** The Phase 1 Worker in workerd, built by the eval harness as `npm run eval` builds it:
- ranker `8d94982` (`src/`, `migrations/`, `scripts/lib.mjs`, `data/`), extracted by
  `buildWorkspace`. Its tree hash `7415af0bcd3e…` equals the working tree's, so it is the same
  ranker `npm run eval` runs without `--ref`;
- seeded through its own `/admin/ingest` with the pinned corpus and corpus vectors
  `emb-bge-small-v0`;
- query vectors from `eval/dev/embeddings.json`. Phase 1 embeds the canonical query (trimmed,
  whitespace collapsed, ASCII lower-cased). Five of the 15 queries have a canonical form that
  differs from the raw text (d-073, d-076, d-079, d-085, d-043), and for each of them the cached
  canonical vector is bit-identical to the raw one.

It is driven by `probe.mjs` with `probe-head.eval.js`, the Phase 1 counterpart of `probe.eval.js`.
`probe.eval.js` replicates v0's SQL, which Phase 1 no longer runs. The head probe instead:
- takes the lexical list from the ranker's own `lexicalSearch` at depth 50, the call `runSearch`
  makes;
- takes FTS5 `rank` values for every match that passes the request's filters;
- deletes the request's canonical cache entry before each request;
- refuses a degraded answer.

There are no Cloudflare calls on the local side.

### Queries and live calls

**Queries.** The same 15 dev queries (v2.1) with the same params as the first check (`ids.mjs`).
11 are sent unfiltered and 4 with their dev filters:

| id | shape | params |
|---|---|---|
| d-001, d-015, d-039, d-055 | topical | unfiltered |
| d-073 | mapping (123 chars) | unfiltered |
| d-018 | alternatives | unfiltered |
| d-007 | language | unfiltered |
| d-076 | abbreviation | unfiltered |
| d-079 | ge | unfiltered |
| d-085 | code-exact (pinned) | unfiltered |
| d-095 | typo | unfiltered |
| d-063 | level | `sem=2&ng=1` |
| d-043 | sea | `ng=1` |
| d-065 | no-answer | `sem=2&ng=1` |
| d-088 | code-space | `ng=1` |

All 15 are ASCII.

**Live calls (`fidelity-2.mjs live`).** 30 in total, made once; the script refuses to run again.
- `f2-1`–`f2-15`: `GET /search?q=…[&filters]` at production defaults (no `topK`, no `mode`), the
  same query string the replica receives, in the order above.
- `f2-16`–`f2-30`: the same paths with `&mode=lexical&topK=50`, the direct lexical check.
- At least 3 s between one call's end and the next call's start (3.5 s is used), a browser
  `User-Agent`, and no retries. A call that has not answered in 30 s is recorded as an error and
  not repeated.
- Each call's raw body text and all of its response headers (Server-Timing, `x-app-version`,
  `cf-cache-status`, `cf-ray`) are saved in `live-2/<id>.json` and `live-2-lexical/<id>.json`.
- Each call is logged in `fidelity-2-requests.tsv`, in the column format of
  `docs/evidence/requests.tsv`. The rows carry no `[search#n]` numbers; those are assigned when
  they are merged into the main log.

**Local side (`fidelity-2.mjs local` → `fidelity-2-local.json`).** For each query:
- the hybrid response;
- head's lexical list (depth 50). This is checked equal to the replica's
  `mode=lexical&topK=50` page and to `retrieval.lexical`;
- the dense list (`mode=vector&topK=50`, ranks from the one-list RRF scores);
- the FTS5 rank values.

### What Phase 1 changes, check by check

- **Fusion is unchanged.** It is RRF with k = 60 in float64 from 0, vector list first, depth 50,
  with the pin lifted out. So the score decomposition of check 2 carries over as is.
- **B1 (exact filtered lexical recall).** Filters now run in SQL, exactly, with ties in
  (rank, rowid) order. v0's lexical list becomes head's (`lexicalSearch`). The rank values used
  for tie groups now cover only the matches that pass the filters; v0's covered all matches,
  which was slightly more lenient for a group cut at depth 50. Measured before the live calls:
  on these 15 queries head's lexical lists, retrieval counts and hybrid top-20 equal the v0
  replica's (`fidelity-local.json`).
- **B8 (Unicode tokeniser).** For ASCII input the MATCH string is byte-identical, so this does not
  touch these 15 queries.
- **B4–B6 (parallel path, timeouts, keyword fallback).** A live hybrid answer can now be a 200
  with `degraded` (keyword-only), which does not measure the dense half. Check 1 requires that it
  is absent.
- **B7 (canonical cache key).** A live answer can come from `caches.default`, stored earlier (by
  the same code and data version, up to an hour before). Check 1 requires the Server-Timing span
  `cache;desc=miss`. On the replica, unknown parameters no longer split cache entries, so the
  first check's `_p` tags no longer keep noise conditions apart. The head probe deletes the entry
  instead.
- **New `retrieval.fused`.** It counts the union of both lists, so it depends on the dense list.
  It is reported, not checked.
- **Version.** Check 1 requires `x-app-version` to name a commit whose `src/` equals `8d94982`'s
  apart from `src/data-version.json` (that is `8d94982` or `c2d37d5`).
- **Direct lexical check.** In the first check it came after the fact (after the PR #12 review),
  because the hybrid-score decomposition cannot pin lexical ranks. Here it is pre-registered as
  part of check 2.

### Checks per query

1. **Rows:** status, `count`, `retrieval.lexical` and `retrieval.vector` equal; the same pinned
   code; no `degraded`; Server-Timing `cache;desc=miss`; `x-app-version` as above.
2. **Lexical, up to tie-group order.** Both parts must hold.
   - **(a) Decomposition (as in the first check).**
     - Every live RRF score decomposes bit-for-bit into a vector rank and a lexical rank (each
       `∅` or 1..50).
     - The lexical rank is a position that the code's FTS5 rank-value tie group occupies in head's
       local list. A group cut at depth 50 may also be absent.
     - Any local lexical hit whose guaranteed lexical score alone exceeds the live 20th score
       appears live.
   - **(b) Direct.** Live `mode=lexical&topK=50` against head's list, with the pinned code
     removed and the list cut to 50 minus the pin, as the Worker pages it.
     - Status 200, not degraded, cache miss.
     - The same pin, and `retrieval.lexical` equal.
     - The same codes, each within the positions its tie group spans.
     - A group cut at depth 50, or at the page cut when the pin shortens the page, compares as a
       set.
3. **Dense half (reported only).** The live vector rank of each returned code, from the
   decomposition, against the local dense ranks.
4. **Overlap.** overlap@10 and RBO@10 (extrapolated, p = 0.9) between live and local hybrid
   top-10.

### Noise envelope (`noise-2.json`)

The envelope was recomputed for the head replica with
`noise.mjs --ref 8d94982 --probe head --out noise-2.json`, using the first check's conditions,
draws and seeds:
- the real 20-text re-embedding;
- query vectors moved to cosine 0.9957 and 0.9797 (5 draws each);
- corpus vectors moved by the measured fixture-pair cosines (3 draws, also combined with the real
  re-embedding).

The envelope for a query is the lowest overlap@10 against the unperturbed head replica under any
batch-level condition (0.9996, same text in two calls, excluded as before). `noise.mjs` now keys
each override vector under both query forms, with the random draws unchanged. Rerun for eval-v0,
it reproduces `noise.json` exactly (per-query and summary).

**Result, before the live calls:** `noise-2.json` equals `noise.json` on all 2,102 per-query
entries (dev and fidelity params). On these queries the head replica responds to every noise
condition exactly as v0 does, so the envelope is the same:

| id | d-001 | d-015 | d-039 | d-055 | d-073 | d-018 | d-007 | d-076 | d-079 | d-085 | d-095 | d-063 | d-043 | d-065 | d-088 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| min overlap@10 | 9 | 9 | 9 | 8 | 9 | 7 | 7 | 8 | 4 | 9 | 4 | 9 | 9 | 8 | 7 |

Mean overlap@10 over the 15 queries, per modelled condition:

| condition | mean overlap@10 |
|---|---|
| real re-embedding | 9.47 |
| query noise at cosine 0.9957 | 9.47–9.80 |
| query noise at cosine 0.9797 | 8.80–9.20 |
| corpus noise | 8.47–9.27 |
| corpus noise + real re-embedding | 8.67–9.07 |

### Acceptance rule (pre-registered)

- A query passes iff check 1 holds, check 2 holds (both (a) and (b)), and live overlap@10 ≥ its
  envelope.
- The replica is faithful (**PASS**) iff all 15 pass.
- Otherwise the verdict is **FAIL**, and the failing queries are listed as unexplained. Nothing is
  "fixed", and no call is repeated.
- A degraded answer, a cache hit or a wrong version fails check 1 for that query, so it can only
  fail the verdict, never pass it.
- The only change from the first rule is (b). The verdict under the first rule read literally
  (check 2 = (a) only) is reported next to it but does not decide.
- RBO@10 ≥ 0.8 is reported but does not decide, for the first check's reason.

### Reported, not deciding (pre-registered)

- For each query: the first check's overlap@10, envelope and result next to this check's.
- overlap@10 of old production (first check, `live/`) against new production (`live-2/`).
- The dense ranks of old against new production: each answer's vector ranks are decomposed
  against its own replica's lexical list, and the codes both answers return with one candidate
  rank each are compared.
- Live mean overlap@10 against the modelled condition means above.

### How the outcome bears on the two candidate causes (pre-registered)

The first check left two candidates for its dense-half gap:
1. the Vectorize ANN index versus the fake's exact cosine;
2. production's corpus vectors coming from its own ingest batches.

The re-ingest changed production's corpus vectors (new batches of 50) and with them the contents
of the index. The replica side is unchanged: the same corpus vectors, and the same envelope as
shown above. So this check cannot cleanly separate the two causes. It reads them as follows:
- **(A) d-001 and d-065 back inside their envelopes, and live mean overlap@10 within the
  modelled range (≥ 8.47).** The first gap was specific to the old production vectors. This is
  consistent with cause 2. It gives no support to a systematic ANN effect.
- **(B) d-001 and/or d-065 outside again, by a similar margin, or the mean still below every
  modelled condition.** A gap that survives a full re-embedding in different batches points away
  from batch composition (cause 2) and towards something stable across re-ingests: the ANN index
  (cause 1), or corpus-side noise larger than the 21-pair fixture sample models.
- **(C) Other queries outside instead.** Production's dense half is noisier than the envelope in
  general. Neither cause is singled out; the envelope understates production noise.

### Analysis self-test (`fidelity-2.mjs selftest`, before the live calls)

The head replica stands in for "live" (`fidelity-2-selftest.json`):
- **Clean.** Hybrid with the 20 re-embedded query vectors (real Workers AI noise), plus the
  replica's own `mode=lexical&topK=50` pages: **PASS**, mean overlap@10 9.47.
- **Corrupted**, one defect each on five queries:
  - a score nudged by 1e-6 (d-001);
  - `retrieval.lexical` off by one (d-015);
  - Server-Timing marked a cache hit (d-039);
  - `degraded` added (d-055);
  - two lexical-mode results swapped across tie groups (d-073).

  The result is **FAIL on exactly those five**.
- **Identity.** The replica against itself: **PASS**, every vector rank inferred exactly (0 shifts).

### Not modelled

- Production Vectorize is an approximate (ANN) index; the fake is exact.
- Production's corpus vectors are the re-ingest's batches of 50; the replica's are
  `emb-bge-small-v0`. The corpus-noise draws model the difference with the measured batch-effect
  distribution.

## Results (2026-11-04)

**Calls.** 30 live `/search` calls, `f2-1`–`f2-30` in `fidelity-2-requests.tsv`, made
06:21:08–06:22:59 UTC.
- 15 hybrid and 15 `mode=lexical&topK=50`. All returned HTTP 200, all were Server-Timing
  `cache;desc=miss`, and none carried `cf-cache-status` or `degraded`.
- `x-app-version` was `8d94982` on every call.
- Hybrid calls took 0.39–0.94 s in total, lexical calls 0.07–0.28 s.
- There were no retries and no other calls from this check.
- Raw bodies and headers are in `live-2/` and `live-2-lexical/`; the comparison is in
  `fidelity-2-result.json` (`fidelity-2.mjs analyze`).

The last three columns are the reported comparisons: the first check's overlap@10, old production
against new, and the dense ranks old against new.

| id | params | rows | decomp. (2a) | direct (2b) | retrieval.lexical | fused live / local | overlap@10 | envelope | RBO@10 | 1st check overlap@10 | old vs new prod. overlap@10 | dense ranks old = new | result |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d-001 | unfiltered | ok | ok | ok (ties) | 50 | 67 / 68 | **8** | 9 | 0.568 | 8 | 10 | 19/19 | **outside** |
| d-015 | unfiltered | ok | ok | ok (exact) | 50 | 84 / 85 | 9 | 9 | 0.961 | 9 | 10 | 20/20 | pass |
| d-039 | unfiltered | ok | ok | ok (exact) | 50 | 86 / 84 | 10 | 9 | 0.928 | 10 | 10 | 20/20 | pass |
| d-055 | unfiltered | ok | ok | ok (exact) | 50 | 84 / 82 | 9 | 8 | 0.948 | 9 | 10 | 20/20 | pass |
| d-073 | unfiltered | ok | ok | ok (ties) | 50 | 76 / 82 | 10 | 9 | 0.869 | 10 | 10 | 19/19 | pass |
| d-018 | unfiltered | ok | ok | ok (ties) | 50 | 93 / 95 | 8 | 7 | 0.704 | 8 | 10 | 20/20 | pass |
| d-007 | unfiltered | ok | ok | ok (ties) | 50 | 76 / 77 | 9 | 7 | 0.914 | 9 | 10 | 20/20 | pass |
| d-076 | unfiltered | ok | ok | ok (exact) | 2 | 50 / 50 | 8 | 8 | 0.875 | 8 | 10 | 20/20 | pass |
| d-079 | unfiltered | ok | ok | ok (exact) | 50 | 96 / 95 | 8 | 4 | 0.781 | 8 | 10 | 20/20 | pass |
| d-085 | unfiltered (pinned) | ok | ok | ok (exact) | 1 | 50 / 50 | 9 | 9 | 0.948 | 9 | 10 | 19/19 | pass |
| d-095 | unfiltered | ok | ok | ok (exact) | 0 | 50 / 50 | 5 | 4 | 0.640 | 5 | 10 | 20/20 | pass |
| d-063 | sem=2, ng=1 | ok | ok | ok (exact) | 50 | 74 / 73 | 9 | 9 | 0.915 | 9 | 10 | 20/20 | pass |
| d-043 | ng=1 | ok | ok | ok (exact) | 50 | 74 / 72 | 10 | 9 | 0.923 | 10 | 10 | 20/20 | pass |
| d-065 | sem=2, ng=1 | ok | ok | ok (exact) | 50 | 82 / 86 | **7** | 8 | 0.861 | 7 | 10 | 20/20 | **outside** |
| d-088 | ng=1 | ok | ok | ok (exact) | 0 | 50 / 50 | 7 | 7 | 0.783 | 7 | 10 | 20/20 | pass |

- **Rows: 15/15 match.** Status, `count` (20), `retrieval.lexical`, `retrieval.vector` (50), the
  pinned code (d-085 → MA2101), no `degraded`, cache miss and version all agree.
- **Lexical (check 2): 15/15.**
  - (a) All 299 live RRF scores (300 results minus the pinned one) decompose bit-for-bit with a
    lexical rank head's list allows.
  - (b) The direct check matches on all 15: 11 in exact order, and d-001, d-073, d-018 and d-007
    differ only inside FTS5 tie groups.
- **Dense half: it differs on every query, as in the first check.** 9–19 of each query's returned
  codes have a live vector rank different from the replica's.
- **Overlap@10:** mean **8.40**, min 5 (d-095). RBO@10 ≥ 0.8 holds for 10/15.
- **Envelope:** 13/15 inside. **d-001** (8 vs ≥ 9) and **d-065** (7 vs ≥ 8) each fall one item
  outside.
- **Aggregate:** live mean overlap@10 (8.40) is again below the mean of every modelled noise
  condition (lowest 8.47, corpus noise).
- **Against the first check (reported):**
  - Every query's overlap@10 against the replica is the same as in the first check, and so is
    every RBO@10 except d-001's (0.595 → 0.568).
  - Old and new production share all 10 of their top-10 on every query, and 14/15 are in
    identical order.
  - d-001's order differs only where LL5527V, LLJ5527V and LL6527V share an FTS5 rank value:
    their lexical ranks swapped inside the tie group, and their dense ranks did not change.
  - Of the 297 codes whose dense rank can be inferred unambiguously in both answers, **297 have
    the same dense rank in old and new production**.
  - The live `fused` counts equal the first check's on every query.

## Verdict: FAIL (pre-registered rule)

The first rule read literally gives the same: FAIL.

- **Unexplained:** d-001 and d-065. **The gaps persist unchanged.** Each query is one item below
  its envelope, exactly as in the first check: d-001 at 8 vs ≥ 9, and d-065 at 7 vs ≥ 8.
- **Faithful:** everything structural.
  - Rows, the pin and the lexical half all match. The lexical half is exact up to tie order by
    both the decomposition and the direct check.
  - The head replica reproduces the Phase 1 Worker's lexical behaviour, including B1's SQL
    filters on the four filtered queries.
- **The gap:** it is in the dense half only, and the same size as before.
- **Candidate causes, by the pre-registered reading.** This is outcome **(B)**: both queries are
  outside by the same margin, and the mean is still below every modelled condition. A gap that
  survives the re-ingest points away from the composition of production's old ingest batches
  (cause 2 as the first check framed it). It points towards something stable across re-ingests:
  the ANN index (cause 1), or production corpus vectors that differ from the replica's
  `emb-bge-small-v0` by more than the 21-pair fixture sample models.
- **Not changed:** the replica, the envelope and the rule, after the live calls.

## After the fact (not part of the pre-registered method)

This note was written after the live calls. It changes neither the verdict nor the reading above;
it qualifies how much the reading can carry.

- **The re-ingest probably did not change production's dense half.** Its dense ranks are identical
  before and after it on all 297 comparable codes, and the top-10 sets are identical on all 15
  queries. If the re-embedding had moved the corpus vectors by the measured batch effect (cosine
  0.9797–0.9957), the replica's corpus-noise draws say top-10 sets would change on 7–13 of these
  15 queries (`noise-2.json`, `fid:corpus1..3`).
- **The likely reason (inferred, not verified).** The forced re-ingest sent the same texts in the
  same batches as the original production ingest.
  - The Phase 0 deployed tree (`3b18041`) already used `scripts/ingest.mjs` with batches of 50
    (concurrency 4), in corpus-file order, and the Phase 1 ingest defaults to the same batch size.
    The pinned snapshot is sorted by module code, so file order and code order coincide.
  - Workers AI then returned the same vectors for the same batches. Its nondeterminism is
    measured across *different* batches (`eval/README.md`).
  - Checking this directly would need production's vectors (`getByIds`), which this check does
    not read.
- **What this does to the reading.** The check's premise was that cause 2 had changed ("new
  batches"). If the batches were in effect the same, it did not, and outcome (B) says less than
  it seems to:
  - it rules out a transient or one-off property of the old production state;
  - it shows the gap is reproducible;
  - it does not separate ANN (cause 1) from "production's batch-of-50 vectors differ from the
    replica's batch-of-100 vectors" (cause 2, reframed).
- **An experiment that could separate them (suggested, not run).**
  - Embed the pinned corpus offline in batches of 50 in corpus-file order, as production does, as
    a new corpus version (≈2.4k neurons, no production call).
  - If those vectors reproduce production's, a replica built on them differs from production only
    by the ANN index.
  - Re-scoring the saved `live-2/` bodies against it would need no new live call.
