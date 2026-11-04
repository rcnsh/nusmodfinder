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

## Results

Pending: the live calls follow this commit.
