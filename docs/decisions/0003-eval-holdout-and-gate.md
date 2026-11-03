# 0003 — Eval query sets, holdout custody and the pre-committed gate

Status: accepted (Phase 2), written before any Phase 3 change. One part (the SC5 reading,
below) waits for Jacob's sign-off.

## Context
SC5 needs a rebuilt eval: the shipped ranker must beat the current one on held-out queries on
nDCG@10 and P@5, with a paired bootstrap CI that excludes zero. Phase 3 will try many changes
against the same queries. Reusing one holdout adaptively inflates the false-positive rate (critic
A simulated 14% at 9 changes against 2.5% nominal). The plan (`docs/plans/phase2.md`, r1–r3 and
Final) settled the design over three critic rounds. This ADR records what was built, the hashes
that lock it, and where the build departs from the plan.

## Query sets
| set | where | size | role |
|---|---|---|---|
| dev | `eval/dev/queries.json` (plaintext) | 99 | tuning, open, full per-query output |
| holdout | `eval/holdout/queries.json.enc` (encrypted) | 81 | per-change gate, verdict only, ≤ 12 looks |
| test | `eval/sealed/` (written after Phase 3 freezes) | ≥ 160 answerable | SC5, one look |

- **Provenance.** 180 queries: 147 persona queries, 18 mechanical code queries and 15
  noise-model typos. Six persona writers (subagents with no corpus or tool access) wrote the
  persona queries from `eval/v2/writer-prompt.md`, `eval/v2/PERSONAS.md` and seeded shape quotas
  (`eval/v2/assign-shapes.mjs`, `eval/v2/shape-assignment.json`). `eval/v2/build-queries.mjs`
  builds and splits them.
- **Split.** Provenance first: a derived typo or code variant follows its source. Then topic
  clusters: TF-IDF over query text plus the relevant-narrative, single-link union at cosine
  ≥ 0.35. That is the lowest threshold in 0.30–0.50 (step 0.05) that leaves every shape with ≥ 2
  queries per split. Then stratification by shape. Result: dev 99 / holdout 81 (55/45, as r2
  planned).
- **Locks.**
  - dev plaintext sha256 `cf33e601054923fda58c1d85be4d83e0e04343b1d743e560e16e98f3d42bc3b4`.
  - holdout plaintext sha256 `8f653595ae7e272b6065ce821c5a529237b9caffebd18e4852989903f2f7bdb4`
    (verified on decrypting the committed ciphertext).
  - holdout ciphertext sha256 `2431c18ec4c045451006a17a8eabcca38006713a0eaee019875e64a0bf66b057`,
    recorded in `eval/holdout/MANIFEST.json`.
  - CI (`npm run eval:verify`) fails if any committed ciphertext differs from the manifest.
    Qrels, query embeddings and run files join the manifest as they are made.
- **Test set, pre-registered now.** The sealed test set is written after Phase 3 freezes. It uses
  the same writer prompt, personas and shape-assignment procedure, with fresh writer runs and a
  new seed recorded when it is drawn. It is pooled from v0 plus the final ranker and judged
  under the same protocol.
  - Leak filter: drop a query that is a near-duplicate of any dev or holdout query (query-text
    embedding cosine ≥ 0.9, or the same source query for a derived variant). Report the count.
    SC5 is reported on the filtered set, with the unfiltered set as secondary.
  - Size: keep writing, at most 2 extra persona rounds, until ≥ 160 answerable queries remain.
    Otherwise report the shortfall and the resulting power.

## Custody (procedural, stated plainly)
- **Custodian.** The lead holds the key at `~/.config/vnm/holdout.key` (32 bytes, hex, mode
  600). `~/.config/vnm/custody/` (mode 700) holds the holdout plaintext and the six writer
  outputs. The plaintext is kept, not deleted: it adds no exposure while the key sits beside it,
  and deleting it would leave the key as the holdout's only copy.
- **Holdout files.** Queries, qrels, query embeddings, run files and judge outputs are committed
  only as AES-256-GCM ciphertexts (`VNMENC2`). The additional authenticated data is
  `<set>/<file>`, so a file cannot be swapped between slots or sets.
- **Output.** The CLI prints only the verdict and the overall Δ lines with their CIs. Errors
  print `eval: <set> run failed (<ErrorClass>); details withheld`. Retrieval runs in a child
  process whose output is discarded.
- **Isolation.**
  - Phase 3 tuning agents are briefed never to decrypt and never get the key.
  - Gemini, the second judge, is reachable only through T3 `delegate_task` threads. Tuning
    agents are forbidden by brief from reading other threads.
  - This is honour-system custody with encryption at rest. It is not technical isolation, and
    nothing here claims otherwise.
- **Looks.** A look is any run or report that prints a verdict for an encrypted set.
  - `eval/holdout-ledger.md` holds one row per look, with a set column shared by `holdout` (max
    12) and `test` (max 1).
  - A run reserves its row before retrieval; the reserved row counts even if the run is aborted
    or unjudged.
  - A look is refused when, for any set, the ledger records fewer looks than git's copy at `HEAD`
    or `origin/main`.
  - A lock serialises check-then-append.
  - There is no 13th holdout look: Phase 3 tuning stops at 12.

## Metrics
- nDCG@10 with gain 2^g − 1, P@5 (grade ≥ 1, divisor 5) and MRR@10 per query, macro-averaged
  over the primary answerable queries.
- Duplicate-group aware: only the first member of a variant group (same title family,
  cross-listings) earns gain, in DCG, IDCG, P@5 and MRR.
- No-answer queries are scored as correct-empty rate and false positives. Non-existent-code
  queries are no-answer by rule.
- A non-200 response is never correct-empty or relevant.
- judged@10 must be 100% for any run used in a gate.
- Intervals: paired BCa bootstrap (10,000 resamples, seeded) governs. A sign-flip test and a
  persona-clustered bootstrap are reported alongside.

## The gate (`eval/lib/gate.mjs`)
Every gate fails a candidate in four cases:
- it has more errored (non-200) queries than its baseline ("no new errors");
- it has fewer than 10 primary answerable queries;
- either run is below 100% judged@10;
- a check rests on a degenerate interval (a single query, or every delta equal).

| set | a change passes iff |
|---|---|
| dev (screen) | ΔnDCG@10 BCa 95% lower bound > 0; **or**, for a change declaring target shapes, every target's ΔnDCG@10 > 0, overall ΔnDCG@10 ≥ 0, and ≥ 3 distinct answerable queries across the targets. Tripwire on target shapes only: a target whose one-sided 95% upper bound on ΔnDCG@10 is below 0 fails it; with < 3 queries the tripwire uses the point estimate ≥ 0. |
| holdout | ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates); no exact-code query loses its rank-1 hit. |
| cutoff change (dev screen, holdout governs) | replaces the Δ rules: correct-empty gain ≥ 0.25, answerable ΔnDCG@10 ≥ −0.01, ≥ 3 no-answer queries. |
| test (SC5) | BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, final shipped ranker vs `eval-v0` (= 7ac9841, the production ranker), same pinned corpus `data-2026-2027-20260904`. |

Per-change gates are screening. False-positive control for the shipping claim rests on the
sealed test set, evaluated once.

## SC5 reading (needs Jacob's sign-off)
"The held-out set" in SC5 is read as the **sealed test set**. The holdout result is reported as
secondary, and the test set governs if they disagree. If Jacob rejects this reading, SC5 is
reported on the holdout with its look count and an explicit caveat about adaptive reuse.

## Deviations from the plan
- **Encryption.** AES-256-GCM with a hex key file instead of `age`. The key is not in the macOS
  keychain and not a GitHub secret (Final §3: no CI secret). CI checks only ciphertext hashes.
- **Split clustering.** TF-IDF similarity instead of embedding similarity. The embedding tool
  did not exist when the split was made.
- **Dev minimums.** The 10-query floor is overall. The floors on the comparison that decides a
  verdict are 3 for cutoff no-answer queries and 3 for target-shape queries, because dev has 5
  `noanswer` queries and some shapes only 2 (PR #6 review round 2).
- **Query embeddings.** Since PR #7 the ranker embeds the canonical query, which is trimmed, has
  whitespace collapsed and ASCII letters lowercased. The eval embeds both the raw text (for
  `eval-v0`) and the canonical text. Any `degraded` response fails its query.

## Interpretations confirmed by the lead
- The tripwire covers target shapes only.
- The cutoff rule screens on dev and governs on holdout.
- A look is any verdict-printing run, counting reserved, aborted and unjudged ones.
- One ledger serves holdout and test, with a set column.
- MRR is MRR@10.

## Dissent
None unresolved. The objections and their resolutions are in `docs/plans/phase2.md` (round 1 and
round 2 objection logs, Final).
