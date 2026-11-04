# EVAL.md — retrieval quality for vector-nusmods

## Phase 2 baseline (current)

The harness is described in [`eval/README.md`](eval/README.md). These are the numbers that
Phase 3 changes are measured against.

**Setup:**
- **Ranker:** tag `eval-v0` (= 7ac9841). Production up to the start of Phase 3 returns the same
  top 20 on every dev query (`docs/evidence/phase2/baseline.md` §2).
- **Corpus:** pinned `data-2026-2027-20260904`, 6,771 offered modules.
- **Query embeddings:** `emb-bge-small-v0`, committed vectors.
- **Queries:** dev queries v2.1, 98 in total. 78 are primary answerable; the rest are 5
  feature-gap and 15 no-answer.
- **Qrels:** `qrels-dev-v1`, 1,616 pairs (25 graded by rule, the rest by judge A
  `claude-opus-5-5`, single-judge mode, ADR 0004).
- **Duplicate groups:** `groups-v1` (509 groups, `eval/groups.json`). Within a group, only the
  first member to appear earns gain.
- **Judged@10:** 100% for all three runs.

**Primary answerable queries (n = 78), 95% bootstrap CIs (10,000 resamples, seeded):**

| run | nDCG@10 [BCa CI] | P@5 [BCa CI] | MRR@10 [BCa CI] |
|---|---|---|---|
| **v0 hybrid** | **0.758** [0.703, 0.804] | **0.608** [0.538, 0.674] | **0.872** [0.805, 0.924] |
| v0 lexical only | 0.648 [0.575, 0.709] | 0.482 [0.413, 0.551] | 0.800 [0.713, 0.868] |
| v0 vector only | 0.715 [0.652, 0.768] | 0.572 [0.503, 0.636] | 0.848 [0.769, 0.906] |

**Paired differences (hybrid minus each half):**

| | ΔnDCG@10 [BCa CI] | ΔP@5 [BCa CI] | ΔMRR@10 [BCa CI] |
|---|---|---|---|
| hybrid − lexical | +0.110 [0.060, 0.169], p = 0.0001 | +0.126 [0.085, 0.179], p = 0.0001 | +0.073 [0.005, 0.146], p = 0.044 |
| hybrid − vector | +0.043 [−0.004, 0.090], p = 0.080 | +0.036 [−0.003, 0.072], p = 0.088 | +0.025 [−0.034, 0.080], p = 0.41 |

The p values are from a paired sign-flip test. For hybrid − vector, the persona-clustered
intervals are [0.010, 0.083] for nDCG and [0.006, 0.060] for P@5. Those exclude 0, while the BCa
intervals don't. The script prints both.

**Reading:**
- Hybrid clearly beats lexical alone.
- Hybrid's lead over vector alone is about +0.04 nDCG and is borderline: whether it clears 0
  depends on the interval method. On this dev set the keyword half adds little beyond the
  dense half.
- This reverses v1's conclusion below (lexical ≈ hybrid). v1 graded relevance with a title regex
  and measured recall only. Phase 2 uses graded judgments over a pooled top 10.

**Outside the primary set (v0 hybrid):**
- **Feature-gap (constraint queries, n = 5):** nDCG@10 0.604.
- **No-answer queries (n = 15):** correct-empty 0%, with 11 false positives and 4 errors. The 4
  are the 400 responses to home-course pastes over 200 characters.
- **Hard-constraint violations:** 12 in the top 10s.
- **Weakest dev shapes:** `ge` 0.482, `equivalence` 0.507, `typo` 0.529, `constraint` 0.604.

**Judge quality:**
- **Self-consistency:** planted repeats were graded identically 80 of 80 times on dev and 65 of
  65 on the holdout.
- **Cross-family check** of 150 stratified dev pairs (ADR 0004 amendment,
  `docs/evidence/phase2/calibration/`). Gemini graded each pair blind to judge A, and Claude
  Sonnet then verified every grade. Agreement with A:
  - raw agreement 0.880;
  - quadratic κ 0.915;
  - Krippendorff α 0.915.

  A is slightly lenient: it graded 12 pairs higher and 6 lower. No human has graded a pair.

**Holdout:** `qrels-holdout-v1` is committed only as ciphertext, with 23 rule pairs and 1,296
pairs graded by A. No look has been taken (`eval/holdout-ledger.md`). Looks are spent only on
Phase 3 candidates, at most 12.

**Reproduce:**
```sh
npm run eval -- run --set dev --variant v0 --ref eval-v0          # plus --mode lexical|vector for the halves
npm run eval:report -- --run v0 --baseline v0-lexical
node docs/evidence/phase2/baseline-table.mjs                       # this section's tables
```
Running from a clean clone with the release assets gives identical results. A run file's hash
differs between runs because the file records a `createdAt` time.

---

> **v1 (historical).** Everything below is the superseded v1 eval. Its fixtures and scripts now
> live in `eval/v1/`.

**Verdict up front.** The hybrid retriever passes the pre-committed gate on both the
development fixture (+1.0pp) and a held-out fixture written after tuning was frozen
(+1.0pp). But the margin is ~10 documents out of 970 and is not statistically
significant (sign test p = 0.77). And the component analysis is unflattering:
**a lexical-only retriever using D1 FTS5 matches the hybrid almost exactly, with 5 wins
and 0 losses against the baseline.** Vector-only is indistinguishable from the keyword
baseline (8 wins, 9 losses, net +2 documents, p = 1.00).

The honest reading: *the measurable improvement over a keyword box comes from moving
BM25 into the database with proper stemming, not from the embeddings.* Vectorize earns
its place on specific query shapes and on nothing else measured here.

---

## Method

Two fixtures, both judged by written criteria applied to the entire 6,771-module corpus:

| fixture | queries | status |
|---|---|---|
| `eval/queries.json` | 6 topical, 3 exact codes, 3 exact titles, 3 filtered | **tainted** — the retriever was modified in response to it failing |
| `eval/holdout.json` | 12 topical | **clean** — written after RRF and stopword tuning was frozen |

**Not evaluated:** the exchange-student (`ng`) filter added after this measurement. It is
a hard structural filter with an exhaustive source list, verified to return zero
violations across all three retrieval modes and in combination with `sem`, `level` and
`faculty` — but no eval query exercises it, so it contributes nothing to and takes nothing
from the numbers below.

> **One unverified change.** After this measurement, the lexical SQL changed from
> `ORDER BY bm25(modules_fts, 0.0, 3.0, 1.0)` to `ORDER BY rank`, with the same weights
> stored on the table itself (`migrations/0005_rank.sql`). This is a cost fix — 389 D1
> rows read became 7 — and it is *intended* to be ordering-neutral, because FTS5's `rank`
> IS bm25 with the table's configured weights. An interim attempt to fix cost by switching
> the query from OR to AND **was reverted**, precisely because that one *would* have
> changed retrieval and could not be re-measured. The behaviour evaluated below is the
> behaviour that ships.
>
> Still: `ORDER BY rank` has not been re-run against these fixtures, because the D1
> free-tier daily row-read limit was exhausted the same day. Re-run `npm run eval` and the
> held-out fixture after the quota resets and confirm the numbers are unchanged.

**Metric: micro-averaged recall@10** — total relevant retrieved ÷ total relevant, pooled
across queries. Precision@10 (divisor `min(K, |R|)`) and MRR are reported as diagnostics.

**Baseline: BM25** over title (×3) and description, porter-stemmed, stopword-filtered,
full-corpus scan, with the exact-code shortcut handed to it for free. The same stopword
list and the same stemming the Worker's FTS5 index uses, so neither side gets an easier
version of the query. This is deliberately a strong opponent: the point of the gate is
to find out whether any of this beats the keyword box NUSMods already has.

**Relevance judgements** are generated by `scripts/judge.mjs` — an explicit written
criterion per query, applied as a rule to all 6,771 modules, plus a small number of named
additions where the rule provably misses a document. Sets are therefore complete and
reproducible. `scripts/pool.mjs` builds a blind judging pool (union of every retriever's
top-20, sorted by code, with no system or rank attribution) for re-judging.

Because the sets are complete, `|R|` exceeds 10 for most topical queries, so recall@10 is
ceilinged at `10/|R|`. The ceiling is reported and is identical for every system.

The rules are lexical, which biases both fixtures **toward the keyword baseline**. That
is the conservative direction when testing semantic search, and it is stated rather than
hidden.

---

## Results

### Development fixture (`eval/results-main.txt`)

```
                      baseline            vector              lexical             hybrid
ALL                   15.9% (69/433)      14.8% (64/433)      17.1% (74/433)      17.1% (74/433)
topical                8.8% (35/397)       8.3% (33/397)       9.8% (39/397)       9.8% (39/397)
code                 100.0% (3/3)        100.0% (3/3)        100.0% (3/3)        100.0% (3/3)
title                100.0% (12/12)       83.3% (10/12)      100.0% (12/12)      100.0% (12/12)
filtered              90.5% (19/21)       85.7% (18/21)       95.2% (20/21)       95.2% (20/21)

precision@10          81.7%               76.4%               85.2%               83.8%
MRR                   0.942               0.869               0.942               0.967

Gate (topical):  vector -0.5% FAIL   lexical +1.0% PASS   hybrid +1.0% PASS
```

### Held-out fixture (`eval/results-holdout.txt`)

```
                      baseline            vector              lexical             hybrid
topical               11.9% (68/573)      12.6% (72/573)      12.7% (73/573)      12.9% (74/573)

precision@10          56.7%               60.0%               60.8%               61.7%
MRR                   0.833               0.674               0.903               0.820

Gate (topical):  vector +0.7% PASS   lexical +0.9% PASS   hybrid +1.0% PASS
```

### Pooled across all 18 topical queries (970 relevant documents)

| system | retrieved | vs baseline | wins | losses | ties | sign test |
|---|---|---|---|---|---|---|
| baseline (BM25) | 103/970 (10.62%) | — | — | — | — | — |
| vector only | 105/970 (10.82%) | +0.21pp | 8 | 9 | 1 | p = 1.00 |
| **lexical only (FTS5)** | **112/970 (11.55%)** | **+0.93pp** | **5** | **0** | 13 | p = 0.063 |
| hybrid (shipped) | 113/970 (11.65%) | +1.03pp | 7 | 5 | 6 | p = 0.774 |

Vector-only is a **high-variance trade**, not an improvement. Its per-query deltas against
the baseline are `[+5, +2, −5, −2, −3, +1, +4, −1, +4, −1, +5, −5, −3, +1, −1, −1, 0, +2]`.
It wins big where the user's words are not the course's words — `learning a foreign
language` (+5), `keeping computer systems secure` (+5), `computer science ai` (+5),
`diseases and how they spread` (+4) — and loses just as big on `music theory and
composition` (−5), `photography and film making` (−5), `how do i start my own company` (−5).

Lexical-only never loses. That is the finding that matters.

---

## History: what actually happened

### Phase 2 — baseline recorded

BM25 at ceiling on exact codes (100%), exact titles (100%) and filtered queries (91.7%);
weak on topical. Landmine L3 confirmed where the plan predicted it: a lexical engine is
unbeatable when the query *is* the document's text. Vector search could only fail to lose
those categories.

### Phase 4, first run — vector-only **FAILED** the gate

`topical: baseline 24.6%, vector 23.5%, delta −1.1%` (macro-averaged, on the original
fixture). Per the plan's stated fallback, work stopped and hybrid retrieval was built
before any UI work:

1. **FTS5 lexical index in D1** (`migrations/0002_fts.sql`) — `modules_fts` over title and
   description with porter stemming, synced by triggers.
2. **Reciprocal-rank fusion** — `1/(60 + rank)`, k=60 from the original RRF paper, left
   untuned. Weights deliberately not fitted: tuning two parameters on six topical queries
   would produce a number meaningless outside those six.
3. **Stopword filtering on the FTS query** — without it, "how do i start my own company"
   matched every *Design Your Own Course* record on the word "own". Uses the same list as
   the baseline, so it equalises rather than advantages.

Re-run: `topical delta +0.6%`, **PASS**.

### Then a hostile review demolished that result

An independent reviewer, given the fixture and results and told to find reasons not to
trust them, returned six blockers. The important ones were correct:

**1. The +0.6% was an artefact of macro-averaging.** Both systems had retrieved an
identical **11 of 45** relevant documents. The mean was positive only because one query
where vector gained had 7 relevant items and one where it lost had 8. Micro-averaged
delta: exactly **0.0%**.

**2. The relevance judgements were built from a truncated listing.** The original sets came
from grepping the corpus and reading the first 30 alphabetical hits. Consequences:

- `t4 climate change and the environment` contained **none of the 15 modules in the CCS
  "Climate Change and Sustainability" programme** — CCS sorts after the truncation point.
- `t3` included `BME5405` "Technology, Innovation and Entrepreneurship" but excluded
  `DBA5110` "Technology Innovation and Entrepreneurship" — same faculty, one comma apart,
  and the baseline's rank-1 hit.
- `t1` included `CS3263` and `CS6208` but excluded `CS3264`, `IT5005` and `CS6216` on no
  stated principle.

The exclusions landed disproportionately on documents BM25 ranked highly, so the fixture's
bias ran **against** the baseline — the opposite of what this file previously claimed.

**3. The system had been tuned against the only test set that existed.** RRF and the
stopword filter were both added in response to these six topical queries failing. Not
editing the fixture is not a defence when you edit the retriever instead.

**4. precision was divided by returned-list length, not K**, so a baseline returning one
document scored "100% precision" against a hybrid returning ten.

**5. The results file labelled a keyword+vector system as "vector"**, and the failing
vector-only run was recorded nowhere.

### What was changed in response

- Relevance rebuilt from written criteria applied to the **whole** corpus. Set sizes went
  from 8/7/8/8/8/6 to **57/36/91/171/11/31**.
- Gate metric switched to **micro-averaged** recall; the smallest registrable change is
  now printed alongside every result.
- precision@10 divisor fixed to `min(K, |R|)`.
- Baseline given the **same porter stemming** as the Worker's FTS5 index, removing an
  undisclosed asymmetry.
- Gate tolerance tightened from `>= -0.001` to `>= 0`.
- RRF alphabetical tiebreak replaced with a **stable hash**; alphabetical ordering
  correlated with the CS-heavy code prefixes in the fixture.
- `mode=vector|lexical|hybrid` added to `/search` so each retriever is measurable alone —
  this is what exposed that the lexical half does the work.
- **A held-out fixture** of 12 topical queries added, written after tuning was frozen.
- Raw returned code lists committed for every query and system
  (`eval/raw-queries.json`, `eval/raw-holdout.json`), so the whole run is auditable.

What was **not** changed: no relevance judgement was edited after seeing which system it
penalised, and the RRF weights were never fitted to the fixture.

---

## What this does and does not establish

**Supported:** hybrid retrieval is not worse than a strong keyword baseline, and is
modestly better on precision@10 in both fixtures (81.7→83.8, 56.7→61.7). It passes the
pre-committed gate on data it was never tuned against. The exact-code shortcut and filter
guarantees hold (R4, R5 pass).

**Not supported:** "semantic search beats keyword search here." Ten documents out of 970,
p = 0.77. And the component breakdown says the credit belongs to FTS5, not to embeddings.

**The uncomfortable conclusion.** A lexical-only build — D1 FTS5, no Vectorize, no Workers
AI, no embedding step in ingest — scores 112/970 against the hybrid's 113/970, never loses
a query against the baseline, and has the best held-out MRR (0.903 vs the hybrid's 0.820).
It would be cheaper, simpler, faster, and would not consume the account's shared Vectorize
allowance. On this evidence that is the build a careful engineer would ship.

The hybrid is shipped anyway because it passes the gate that was set in advance and it
wins on the query shapes the project exists to serve — the ones where a student describes
what they want in words no course title uses. That is a judgement call about what to
optimise for, and it should be recognised as one, not as something the numbers proved.

**Before this measurement is trusted for any further decision:** the fixtures need more
topical queries (18 is too few — one document moves the pooled number by 0.1pp but a
single query moves a per-query delta by up to 45pp), and relevance needs a second judge.
