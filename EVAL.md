# EVAL.md: retrieval quality for NUS Mod Finder

The ranker is measured offline, on judged queries, and no ranking change ships without evidence.
This file gives the current state first: the shipped ranker and how a change ships, then SC5, then
the Phase 2 baseline on today's dev qrels, then what the numbers don't show. The harness is
described in [`eval/README.md`](eval/README.md); the gate and custody rules are
[ADR 0003](docs/decisions/0003-eval-holdout-and-gate.md).

## The shipped ranker and how a change ships

<!-- pointer --> The shipped ranker, the baseline every change is compared with, is the commit
`SHIPPED_BASELINE` names in [`eval/lib/baseline.mjs`](eval/lib/baseline.mjs). Commits merged since
it are ranking-neutral, which the ranking lock below proves. ADR 0003's "Shipped-ranker pin" list
gives every pin with what it shipped and its evidence.

A change that moves any ranked list ships by one of two routes, each against the shipped pin:
- **A holdout look that passes** ([`eval/lib/gate.mjs`](eval/lib/gate.mjs), ADR 0003 "The gate"):
  on the encrypted holdout set, ΔnDCG@10 ≥ 0, ΔP@5 ≥ 0 and no exact-code regression, or the rule
  its declared kind names (targeted, cutoff, or the 5F compliance rule). Each look is a row in [`eval/holdout-ledger.md`](eval/holdout-ledger.md).
- **An ADR 0003 no-look route**, for a change whose effect the rule can show on open sets plus a
  custodian count: `representative-only`, `answerable-floor` (3G), `group-first` (3F) or
  `gated-without-a-look` (Phase 4). Each is a row in [`eval/count-log.md`](eval/count-log.md)
  whose `route` column names it (amendment 2026-11-12).

A change that moves no list needs neither. **CI enforces this** with the ranking lock
([`eval/ranking-lock.json`](eval/ranking-lock.json), the `eval-gate` job; "The ranking lock" in
[docs/REFERENCE.md](docs/REFERENCE.md#the-ranking-lock-cis-eval-gate)). The lock holds the ordered
result codes of every dev and fixture query in three filter modes. A PR whose lists differ from it
fails, unless it rewrites the lock with evidence written after its base: a passing ledger row, a
count-log route row, or a revert to an earlier lock.

**Looks spent:** 8 of 12 holdout looks and 1 of 1 test-set look
([`eval/holdout-ledger.md`](eval/holdout-ledger.md)). Phase 3 took seven holdout looks (3A-2, 3B
and 3C-2 passed; two tries each of 3D and 3H failed). The eighth, L8, was Phase 5's parsed phrases
(5F), under the compliance rule of ADR 0003's amendment 2026-11-11; it passed. The test-set look
was SC5, below.

The eval's Non-Graduating (NG) files are pinned too: `eval/pinned/` holds the NG list and the
restrictions the qrels were judged with, and the eval reads nothing else (ADR 0003, amendment
2026-11-12). A Registrar revision of the live files in `data/` moves no eval list.

## SC5: the sealed test set, one look

**SC5 passes.** On the sealed test set (n = 195 primary answerable queries, filtered), the frozen
Phase 3 ranker `phase3-final` (`c787dea`) beats `eval-v0` (`7ac9841`, the Phase 2 production
ranker) on the pinned corpus:

| | ΔnDCG@10 [BCa 95% CI] | ΔP@5 [BCa 95% CI] |
|---|---|---|
| `phase3-final` − `eval-v0` | **+0.120 [0.083, 0.161]** | **+0.059 [0.036, 0.090]** |

Both lower bounds are above 0, which is SC5's rule. The queries were written and judged after
Phase 3 froze, and the set allows no further look. Evidence, the secondary readings and how the
set was written: [`docs/evidence/phase3/sc5.md`](docs/evidence/phase3/sc5.md).

SC5 covers the ranker as Phase 3 left it. Changes shipped since (Phases 4 to 6) are covered by
their own holdout look or no-look route, not by the test set.

## What is measured

- **An offline replica.** A run executes the actual Worker in workerd over local D1 holding the
  pinned corpus, with committed query and corpus embeddings and no Cloudflare call. It is not
  production (ADR 0003, "Replica fidelity").
- <!-- year:pinned --> **The corpus** is NUSMods' 2026/27 catalogue as pinned on 4 September 2026
  (release `data-2026-2027-20260904`), 6,771 offered modules.
- **Replica and production differ in three ways.** Since 3-0 both run an exact dense search over
  vectors held in the Worker, so the differences are:
  - the corpus: the pinned snapshot against production's `current` in
    [`data/corpus.json`](data/corpus.json);
  - the NG files: `eval/pinned/` never moves, while `data/` follows NUS's revisions. The two copies
    of the NG list are identical today (the same sha256);
  - query vectors: production embeds each query live with Workers AI, the eval uses committed
    vectors, and Workers AI isn't bit-deterministic across batches, so ties near the cut can differ
    ([`eval/README.md`](eval/README.md), "Embeddings").

  A Δ between two replica runs is unbiased by these. An absolute number describes production only
  approximately.
- **Metrics:** nDCG@10, P@5 and MRR@10 over the top 10 at production's depth, with duplicate
  groups `groups-v1` ([`eval/groups.json`](eval/groups.json)): within a group only the first member
  to appear earns gain. Intervals are BCa bootstraps (10,000 resamples, seeded); paired p values
  are a sign-flip test.

## The Phase 2 baseline on today's dev qrels

The Phase 2 baseline is `eval-v0` (`7ac9841`) with its own corpus embedding `emb-bge-small-v0`,
re-scored here on today's dev qrels. The dev set is open, so a re-score takes no look.

**Queries:** dev v2.1, 98 in total. 85 are primary answerable; the rest are 5 feature-gap, 2
no-answer and 6 unscored.
- **No-answer is tagged and unanswered** (ADR 0003, amendment 2026-11-06): a query is no-answer iff
  it is tagged `noanswer` or `code-nonexistent`, or carries `noAnswerByRule`, and no judged document
  has grade ≥ 1. Dev has 2: d-012 and d-025. Three more are tagged `noanswer` (d-013, d-051,
  d-065) but have grade-≥1 documents, so they are primary answerable.
- **Unscored:** an untagged query with no grade-≥1 document is in neither set. The 6 are d-005,
  d-017, d-032 and d-042 (home-course pastes over 200 characters, which `/search` rejects with a
  400), and d-009 and d-020.

**Qrels:** `qrels-dev-v11`, 2,476 pairs (108 graded by rule, the rest by judge A `claude-opus-5-5`
in single-judge mode, ADR 0004). The rule covers hard-constraint violations and the code-target
rule (`eval/lib/code-rule.mjs`, [`eval/JUDGING.md`](eval/JUDGING.md) "Code-target rule"). Judged@10
is 100% for all three runs.

**Primary answerable queries (n = 85):**

| run | nDCG@10 [BCa CI] | P@5 [BCa CI] | MRR@10 [BCa CI] |
|---|---|---|---|
| **v0 hybrid** | **0.626** [0.551, 0.689] | **0.558** [0.480, 0.628] | **0.801** [0.713, 0.866] |
| v0 lexical only | 0.541 [0.465, 0.609] | 0.442 [0.372, 0.515] | 0.734 [0.641, 0.812] |
| v0 vector only | 0.604 [0.530, 0.667] | 0.525 [0.449, 0.593] | 0.778 [0.690, 0.848] |

**Paired differences (hybrid minus each half):**

| | ΔnDCG@10 [BCa CI] | ΔP@5 [BCa CI] | ΔMRR@10 [BCa CI] |
|---|---|---|---|
| hybrid − lexical | +0.085 [0.047, 0.132], p = 0.0001 | +0.115 [0.078, 0.167], p = 0.0001 | +0.067 [0.002, 0.133], p = 0.044 |
| hybrid − vector | +0.022 [−0.013, 0.053], p = 0.21 | +0.033 [−0.002, 0.066], p = 0.088 | +0.023 [−0.029, 0.074], p = 0.41 |

For hybrid − vector, the persona-clustered intervals are [−0.004, 0.049] for nDCG and
[0.005, 0.058] for P@5: only the P@5 one excludes 0. The script prints both.

**Reading:**
- Hybrid clearly beats lexical alone.
- Hybrid's lead over vector alone, +0.022 nDCG, is not distinguishable from 0. On this dev set the
  keyword half adds little beyond the dense half.
- The dense half is the stronger half. The v1 eval's opposite reading (lexical ≈ hybrid) came from
  title-regex relevance and recall only; it is kept as history in
  [`eval/v1/README.md`](eval/v1/README.md).
- **Why the numbers are lower than Phase 2's.** Later rounds judged the documents Phase 3 and 5
  candidates brought into their top 10s. Today's qrels hold 810 pairs from those nine rounds
  (`judging` in `eval/dev/qrels.json`); 221 of them have grade ≥ 1, and none of those is in v0's
  top 10. The ideal ranking rises and v0's scores fall. The ranker did not change.

**Outside the primary set (v0 hybrid):**
- **Feature-gap (constraint queries, n = 5):** nDCG@10 0.449.
- **No-answer queries (n = 2, d-012 and d-025):** correct-empty 0%, with 2 false positives and no
  errors. That is below the cutoff rule's floor of 3 no-answer queries, so a cutoff verdict cannot
  pass on dev (`insufficient queries: 2 no-answer …`). No Phase 3 change took the cutoff kind on
  dev: 3G used `answerable-floor`.
- **Unscored queries (n = 6):** d-005, d-009, d-017, d-020, d-032, d-042. The 4 non-200 responses
  are among them: the 400s to the home-course pastes.
- **Hard-constraint violations:** 12 in the top 10s.
- **Weakest dev shapes:** `code-partial` 0.000 (n = 3), `code-space` 0.210 (n = 3), `typo` 0.296,
  `equivalence` 0.309, `ge` 0.314, `constraint` 0.449.

**Reproduce** (dev set only). The runner downloads the embeddings from their releases with `gh`,
sha-checked; the pinned corpus comes from its release once:
```sh
gh release download data-2026-2027-20260904 -p '2026-2027-moduleInfo.json.gz' -D .data && gunzip .data/2026-2027-moduleInfo.json.gz
npm run eval -- run --set dev --variant v0         --ref eval-v0 --embedding emb-bge-small-v0
npm run eval -- run --set dev --variant v0-lexical --ref eval-v0 --embedding emb-bge-small-v0 --mode lexical
npm run eval -- run --set dev --variant v0-vector  --ref eval-v0 --embedding emb-bge-small-v0 --mode vector
npm run eval:report -- --run v0                    # the v0 row, outside-primary lines and per-shape table
node docs/evidence/phase2/baseline-table.mjs       # both tables above, CIs included
```
`--embedding emb-bge-small-v0` is required: the default embedding is a later one, and the runner
refuses a ranker whose corpus texts that embedding lacks. `eval:report` refuses `--baseline` with a
lexical or vector run, because gates compare hybrid runs only, so the paired Δ against the halves
comes from `baseline-table.mjs` alone. Re-running gives identical numbers; the run file's hash
changes, because the file records `createdAt` and the runner's sha.

### History: the Phase 2 baseline as first recorded, on `qrels-dev-v2`

Phase 2 recorded the baseline on `qrels-dev-v2` (1,666 pairs, 81 graded by rule), where 83 queries
were primary answerable and 8 unscored (d-061 and d-093 had no grade-≥1 document yet). Under
`qrels-dev-v1`, before the code-target rule, v0 read 0.758 nDCG@10 over 78 queries. HEAD's
`baseline-table.mjs` reads today's qrels, so it no longer prints these; `git show
846fac2:eval/dev/qrels.json` has the v2 file.

| run (n = 83, `qrels-dev-v2`) | nDCG@10 [BCa CI] | P@5 [BCa CI] | MRR@10 [BCa CI] |
|---|---|---|---|
| v0 hybrid | 0.712 [0.644, 0.770] | 0.571 [0.494, 0.641] | 0.820 [0.740, 0.884] |
| v0 lexical only | 0.609 [0.532, 0.678] | 0.453 [0.383, 0.525] | 0.752 [0.661, 0.830] |
| v0 vector only | 0.672 [0.599, 0.731] | 0.537 [0.463, 0.605] | 0.797 [0.712, 0.865] |

Paired on v2: hybrid − lexical +0.103 nDCG [0.055, 0.158]; hybrid − vector +0.040 [−0.003, 0.085],
p = 0.080, with a persona-clustered interval of [0.009, 0.078]. Feature-gap nDCG@10 was 0.604; the
weakest shapes were `code-partial` 0.000, `code-space` 0.210, `ge` 0.402, `equivalence` 0.507,
`typo` 0.529 and `constraint` 0.604.

## Judge quality

Every graded pair comes from one judge model, `claude-opus-5-5` (ADR 0004), or from the rule. No
human has graded a pair. Measured on Phase 2's first round:
- **Self-consistency:** planted repeats were graded identically 80 of 80 times on dev and 65 of 65
  on the holdout.
- **Cross-family check** of 150 stratified dev pairs (ADR 0004 amendment,
  `docs/evidence/phase2/calibration/`). Gemini graded each pair blind to judge A, and Claude Sonnet
  then verified every grade. Agreement with A: raw 0.880, quadratic κ 0.915, Krippendorff α 0.915.
  A is slightly lenient: it graded 12 pairs higher and 6 lower.

**Holdout:** 81 queries, committed only as ciphertext (`eval/holdout/`), with their qrels. A gate
needs judged@10 at 100%, so before a look the custodian has the candidate's unjudged top-10
documents judged, and the holdout's qrels grow with each look. A look prints a verdict and Δs only;
no per-query output leaves custody.

## What the numbers don't show

- **Production.** Every number here is the offline replica on the pinned corpus. Production
  differs in its corpus, its NG files after a revision, and its query vectors (above).
- **Students.** The queries are written for student personas by writer subagents (ADR 0003,
  "Provenance"), not taken from real searches.
- **A human view of relevance.** One judge model grades every pair; the cross-family check is the
  only outside reading.
- **Dev as an unbiased estimate.** The dev set is open and screened every Phase 3 to 5 change, so
  dev results for those changes are optimistic. The holdout has been looked at 8 times, which
  inflates its false-positive rate (ADR 0003, "Context"); the per-change gates are screening.
  The shipping claim rests on the sealed test set, used once, and it covers Phase 3 only.
- **Constraint queries.** Queries that need a filter the site doesn't parse ("no Friday classes")
  are feature-gap, scored apart, and score low. The known search limits S2, S3, S4 and S6 stay
  open ([`docs/FINDINGS.md`](docs/FINDINGS.md), ADR 0011 G4).
- **Exchange-mode correctness.** Which courses an exchange student may take is checked against an
  independent oracle by the SC1 suites (`test/sc1/`, docs/REFERENCE.md), not by this eval.

## The v1 eval

The pre-Phase-2 eval (title-regex relevance, recall@10, run against the live site) is history. Its
write-up, fixtures and scripts are in [`eval/v1/`](eval/v1/README.md).
