# Phase 2c: live fidelity check of the eval-v0 replica (dev)

The method and acceptance rule below were written, and the analysis self-tested, **before** any
live call. Results follow in the second half.

## Method

**What is compared.** Production (`https://vector-nusmods.jacobjameswiltshire.workers.dev`,
deployed version `c6744373…` = `3b18041`, behaviourally identical to `eval-v0` = 7ac9841) against
the offline replica: `eval-v0` in workerd, seeded through its own `/admin/ingest` with the pinned
corpus `data-2026-2027-20260904` and corpus vectors `emb-bge-small-v0`. Query vectors come from
`eval/dev/embeddings.json`. This is the same workspace, harness and fakes `npm run eval` uses,
driven by `probe.mjs`/`probe.eval.js`, which also return whole response bodies.

**Queries.** 15 dev queries (v2.1) covering 12 shapes. 11 are sent unfiltered and 4 with their dev
filters (`ids.mjs`):

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

**Live calls.** `GET /search?q=…[&filters]` with production defaults (no `topK`, no `mode`), the
same query string the replica receives. One call per query, 15 in total, no retries, ≥ 3 s apart,
with a browser `User-Agent`. Each call is logged in `docs/evidence/requests.tsv` and saved in
`live/<id>.json`.

**Local side.** It is local only and makes no Cloudflare calls (`fidelity-local.json`). It
records:
- the hybrid response;
- v0's lexical list (its SQL and semester filter verbatim, depth 50, checked equal to
  `mode=lexical`);
- the dense list (`mode=vector&topK=50`, ranks from the one-list RRF scores);
- FTS5 `rank` values for every match.

**Checks per query.**
1. **Rows:** status, `count`, `retrieval.lexical` and `retrieval.vector` equal, and the same
   pinned code.
2. **Lexical, up to tie-group order:** v0 returns each result's RRF score, `1/(60+v) + 1/(60+l)`
   (an absent term is skipped), computed in float64 from 0, vector term first.
   - Every live score must decompose bit-for-bit into a vector rank `v` and a lexical rank `l`
     (each `∅` or 1..50).
   - `l` must be a position that the code's FTS5 rank-value tie group occupies in the local
     lexical list. A group cut at depth 50 may also be absent.
   - Any local lexical hit whose guaranteed lexical score alone exceeds the live 20th score must
     appear live.
3. **Dense half:** the decomposition gives each returned code's live vector rank. These are
   compared with the local dense ranks; this is reported only, since the dense half differs by
   design.
4. **Overlap:** overlap@10 and RBO@10 (extrapolated, p = 0.9) between live and local hybrid top-10.

**Noise envelope (item 3, `noise.json`).** For each query and its params, the envelope is the
lowest overlap@10 against the unperturbed replica under any batch-level noise condition:
- the real re-embedding (one 20-text request);
- query vectors moved to cosine 0.9957 and 0.9797 along real noise directions (5 draws each);
- corpus vectors moved by the measured fixture-pair cosines (3 draws, also combined with the real
  re-embedding).

The envelope for each query, computed before the live calls:

| id | d-001 | d-015 | d-039 | d-055 | d-073 | d-018 | d-007 | d-076 | d-079 | d-085 | d-095 | d-063 | d-043 | d-065 | d-088 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| min overlap@10 | 9 | 9 | 9 | 8 | 9 | 7 | 7 | 8 | 4 | 9 | 4 | 9 | 9 | 8 | 7 |

**Acceptance rule (pre-registered).**
- A query passes iff check 1 holds, check 2 holds, and live overlap@10 ≥ its envelope.
- The replica is faithful (**PASS**) iff all 15 pass.
- Otherwise the verdict is **FAIL**, and the failing queries are listed as unexplained. Nothing is
  "fixed", and no gating runs on the replica until they are investigated.
- Plan r2's "RBO ≥ 0.8" is reported but does not decide. Embedding noise alone takes a query's
  RBO@10 as low as 0.44 (`noise.json`), so a fixed RBO bar would fail a perfect replica.

**Analysis self-test** (`fidelity.mjs selftest`, before the live calls), with the replica standing
in for "live":
- using the 20 re-embedded query vectors, the result is PASS;
- with one score nudged and one `retrieval.lexical` off by one, the result is FAIL on exactly those
  two queries;
- the replica against itself is PASS, with every vector rank inferred exactly.

**Not modelled.**
- Production Vectorize is an approximate (ANN) index; the fake is exact. Any ANN effect shows up
  as dense-half difference.
- Production's corpus vectors came from its own ingest batches, of unknown composition. The
  corpus-noise draws model this with the measured batch-effect distribution.

## Results (2026-11-04)

**Calls.** 15 live `/search` calls, `requests.tsv` rows 35–49 (`[search#34]`–`[search#48]`). All
returned HTTP 200 with 20 results, no `cf-cache-status`, 0.75–2.3 s total. There were no retries
and no other live traffic. Raw bodies are in `live/`; the comparison is in `fidelity-result.json`.

| id | params | rows | lexical | retrieval.lexical (live = local) | fused live / local | overlap@10 | envelope | RBO@10 | result |
|---|---|---|---|---|---|---|---|---|---|
| d-001 | unfiltered | ok | ok | 50 | 67 / 68 | **8** | 9 | 0.595 | **outside** |
| d-015 | unfiltered | ok | ok | 50 | 84 / 85 | 9 | 9 | 0.961 | pass |
| d-039 | unfiltered | ok | ok | 50 | 86 / 84 | 10 | 9 | 0.928 | pass |
| d-055 | unfiltered | ok | ok | 50 | 84 / 82 | 9 | 8 | 0.948 | pass |
| d-073 | unfiltered | ok | ok | 50 | 76 / 82 | 10 | 9 | 0.869 | pass |
| d-018 | unfiltered | ok | ok | 50 | 93 / 95 | 8 | 7 | 0.704 | pass |
| d-007 | unfiltered | ok | ok | 50 | 76 / 77 | 9 | 7 | 0.914 | pass |
| d-076 | unfiltered | ok | ok | 2 | 50 / 50 | 8 | 8 | 0.875 | pass |
| d-079 | unfiltered | ok | ok | 50 | 96 / 95 | 8 | 4 | 0.781 | pass |
| d-085 | unfiltered (pinned) | ok | ok | 1 | 50 / 50 | 9 | 9 | 0.948 | pass |
| d-095 | unfiltered | ok | ok | 0 | 50 / 50 | 5 | 4 | 0.640 | pass |
| d-063 | sem=2, ng=1 | ok | ok | 50 | 74 / 73 | 9 | 9 | 0.915 | pass |
| d-043 | ng=1 | ok | ok | 50 | 74 / 72 | 10 | 9 | 0.923 | pass |
| d-065 | sem=2, ng=1 | ok | ok | 50 | 82 / 86 | **7** | 8 | 0.861 | **outside** |
| d-088 | ng=1 | ok | ok | 0 | 50 / 50 | 7 | 7 | 0.783 | pass |

- **Rows: 15/15 match.** Status, `count` (20), `retrieval.lexical`, `retrieval.vector` (50) and
  the pinned code (d-085 → MA2101) all agree.
- **Lexical: 15/15 match exactly, up to tie-group order.**
  - All 299 live RRF scores (300 results minus the pinned one) decompose bit-for-bit with a lexical rank the local list allows.
  - No local lexical hit that must appear live is missing.
  - The replica's lexical half (D1/FTS5, migrations, filters) is faithful.
- **Dense half: it differs on every query, as expected.**
  - 9–19 of each query's returned codes have a live vector rank different from the local one.
  - Example: d-001's local dense #1, LL4527V, is live #4.
  - The live dense half is a re-ordering of the same neighbourhood, not a different list.
- **Overlap@10:** mean 8.40, min 5 (d-095, a typo query with no lexical hits, so purely dense).
  RBO@10 ≥ 0.8 holds for 10/15.
- **Envelope:** 13/15 inside. **d-001** (8 vs ≥ 9) and **d-065** (7 vs ≥ 8) each fall one item
  outside.
- **Aggregate:** live mean overlap@10 (8.40) is below the mean of every modelled noise condition on
  these 15 queries:

  | condition | mean overlap@10 |
  |---|---|
  | real re-embedding | 9.47 |
  | query noise at cosine 0.9957 | 9.47–9.80 |
  | query noise at cosine 0.9797 | 8.80–9.20 |
  | corpus noise | 8.47–9.27 |
  | corpus noise + real re-embedding | 8.67–9.07 |

  The live dense half is somewhat noisier than the noise modelled offline.

## Verdict: FAIL (pre-registered rule)

- **Unexplained:** d-001 and d-065. Their overlap@10 with the replica is one item below the lowest
  that any modelled embedding-noise condition produced for them.
- **Faithful:** everything structural. The lexical half is exact up to ties, and every row count
  and the pinned result agree.
- **The gap:** it is in the dense half only, and it is slightly larger than the modelled Workers AI
  nondeterminism.
- **Candidate causes**, neither verified and neither modelled:
  1. Production Vectorize is an approximate index; the fake is exact cosine.
  2. Production's corpus vectors came from its own ingest batches, whose noise may exceed the
     21-pair fixture sample used for the corpus draws.
- **Ruled out:**
  - Embedding-text drift: `scripts/lib.mjs` differs between `3b18041` and `eval-v0` only in
    JSDoc and type casts.
  - Corpus or filter drift: lexical counts and ranks match exactly.
- **Not changed:** the replica, the envelope and the rule, after the fact.
- **Consequence:** gating should not rely on the replica's dense half to resolve differences
  smaller than this gap until the lead decides how to treat it. Options for that decision:
  - widen the envelope with an ANN model;
  - export production vectors (`getByIds`, rejected in plan §4 on cost grounds);
  - accept that dense-only ranking differences of about 1–2 items in the top-10 are below the
    eval's resolution.

## Lead decision (2026-11-04)
Verdict stands as FAIL under the pre-registered rule. Gating proceeds on the replica with the
limitation recorded in ADR 0003 ("Replica fidelity"): lexical half exact; dense half slightly
noisier in production (ANN index, unknown corpus-vector batches); Δs are computed replica vs
replica; dense-only differences of 1–2 items per top-10 are below the eval's resolution; a second
fidelity check follows the Phase 1 forced re-ingest.

