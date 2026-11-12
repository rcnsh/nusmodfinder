# EVAL.md: how ranking quality is measured

The ranker is measured offline, on judged queries, and no change to a ranked list merges without
evidence. This file says what is measured, what the current number is, and how to check a ranking
change. The harness and every command are in [`eval/README.md`](eval/README.md); the grading
protocol is [`eval/JUDGING.md`](eval/JUDGING.md); why the rules are what they are, and the hashes
that lock the sets, are [ADR 0003](docs/decisions/0003-eval-holdout-and-gate.md).

## The headline

On the sealed test set (n = 195 primary answerable queries, after the leak filter), the ranker
frozen for the test (`0878efb`) beats the first hybrid version, `eval-v0` (`5c5cce4`), on the
pinned corpus:

| | ΔnDCG@10 [BCa 95% CI] | ΔP@5 [BCa 95% CI] |
|---|---|---|
| frozen ranker − `eval-v0` | **+0.120 [0.083, 0.161]** | **+0.059 [0.036, 0.090]** |

Both lower bounds are above 0, which is the test set's rule. The queries were written and judged
after the ranker froze, and the set allows one look, which is spent, so this number stands. It
covers the ranker as it was frozen; every ranking change since is covered by its own holdout look
or no-look route (below), each against the ranker then in production.

## The query sets

| set | where | size | use |
|---|---|---|---|
| dev | `eval/dev/` (plaintext) | 98 queries | open; screen every change here, as often as needed |
| holdout | `eval/holdout/*.enc` (AES-256-GCM) | 81 queries | one look per change; verdict only; 12 looks in all |
| test (sealed) | `eval/sealed/*.enc` (AES-256-GCM) | 195 primary answerable | one look, spent |
| fixture | `eval/fixtures/` | 11 synthetic queries over a 23-module corpus | CI: the self-test and the ranking lock |

**Looks spent:** 8 of 12 holdout looks and 1 of 1 test-set look
([`eval/holdout-ledger.md`](eval/holdout-ledger.md), one row per look). Each further look needs its
rule committed before it is taken (ADR 0003, "Looks").

**Dev qrels:** `qrels-dev-v11`, 2,476 pairs, graded by one judge model or, for hard-constraint
violations and code targets, by rule (ADR 0016; [`eval/JUDGING.md`](eval/JUDGING.md)). Every
pooled document is judged before a gate reads it: a gate needs judged@10 at 100%.

The queries are written for student personas by writer agents, not taken from real searches. Each
is tagged with its shapes (`topical`, `home-course`, `typo`, `code-exact`, `ge-pillar`,
`constraint`, `noanswer` and others; [`eval/README.md`](eval/README.md), "Sets and files").

## What a run measures

- **An offline replica.** A run executes the actual Worker in workerd over local D1 holding the
  pinned corpus, with committed query embeddings, corpus embeddings from their release assets
  (sha-checked against `eval/embeddings.json`), and no Cloudflare call. It is not production
  (ADR 0003, "Replica fidelity").
- <!-- year:pinned --> **The corpus** is NUSMods' 2026/27 catalogue as pinned on 4 September 2026
  (release `data-2026-2027-20260904`), 6,771 offered modules.
- **Replica and production differ in three ways:**
  - the corpus: the pinned snapshot against production's `current` in
    [`data/corpus.json`](data/corpus.json);
  - the NG files: `eval/pinned/` never moves, while `data/` follows NUS's revisions. The two copies
    of the NG list are identical today (the same sha256);
  - query vectors: production embeds each query live with Workers AI, the eval uses committed
    vectors, and Workers AI isn't bit-deterministic across batches, so ties near the cut can differ.

  A Δ between two replica runs is unbiased by these. An absolute number describes production only
  approximately.
- **Metrics:** nDCG@10, P@5 and MRR@10 over the top 10 at production's depth, with duplicate
  groups `groups-v1` ([`eval/groups.json`](eval/groups.json)): within a group only the first
  member to appear earns gain. Each query is answerable, no-answer (tagged and with no relevant
  document; scored by correct-empty rate) or unscored. Intervals are BCa bootstraps (10,000
  resamples, seeded); paired p values come from a sign-flip test.

## Checking a ranking change

A ranking change is any change to what `/search` returns for some query: `src/`, `data/`,
`migrations/`, `scripts/lib.mjs` or the test Worker config. <!-- pointer --> The ranker every
change is compared with is the commit `SHIPPED_BASELINE` names in
[`eval/lib/baseline.mjs`](eval/lib/baseline.mjs), the shipped pin.

1. **Is it a ranking change at all?** Commit, then run `npm run eval:lock -- --check`. It
   recomputes every dev and fixture list in three filter modes and compares them with
   `eval/ranking-lock.json`. Equal lists mean the change is neutral: you are done, and the lock
   stays as it is. CI's `eval-gate` job runs the same check.
2. **Screen it on dev**, as often as you like:
   ```sh
   npm run eval -- --variant shipped --ref <the SHIPPED_BASELINE sha>
   npm run eval -- --variant cand --baseline shipped [--target-shapes <a,b>] [--change-kind <kind>]
   ```
   This prints the metrics, the CIs, the per-shape breakdown and the dev gate's verdict.
3. **Take one holdout look** (custodian only; needs the key). Store the candidate's run, have its
   unjudged top-10 documents judged, then take the verdict on the stored runs:
   ```sh
   npm run eval -- --holdout --variant cand --store-only
   npm run eval:report -- --holdout --run cand --baseline shipped-<sha7> [--change-kind <kind>]
   ```
   The verdict appends one row to the ledger, pass or fail. Commit the ledger at once.
   A change that a no-look route covers skips this step and takes the route's checks and count
   instead (below).
4. **Rewrite the lock with its evidence**, in the PR that ships the change:
   `npm run eval:lock -- --evidence holdout-pass <ledger row>`, or
   `npm run eval:lock -- --evidence no-look <count-log row>` for a no-look route.
5. **Move the shipped pin** in the same PR: set `SHIPPED_BASELINE` in `eval/lib/baseline.mjs` to
   the shipped commit and append a `- shipped pin:` line to ADR 0003's "Shipped-ranker pin"
   section (`test/eval/baseline.node.test.js` ties the two). After the merge, the custodian stores
   the new baseline's holdout run before the next look.

The full procedure, with every flag, is [`eval/README.md`](eval/README.md), "Checking a ranking
change".

## The gate rules

`eval/lib/gate.mjs`. Every rule also fails a candidate with more errored queries than its
baseline, any comparison over fewer than 10 primary answerable queries, and any CI-based check on
a degenerate interval. The rule applied is printed with the verdict and recorded in the ledger.

| rule | where | passes iff |
|---|---|---|
| general | dev | no exact-code regression, and the ΔnDCG@10 BCa 95% lower bound > 0 |
| targeted (`--target-shapes a,b`) | dev | every target's ΔnDCG@10 > 0 and overall Δ ≥ 0, over ≥ 3 target queries; a target whose one-sided 95% upper bound is below 0 fails |
| holdout | holdout | ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates), no exact-code regression |
| cutoff (`--change-kind cutoff`) | dev and holdout | correct-empty gain ≥ 0.25 and answerable ΔnDCG@10 ≥ −0.01; every list must be the baseline's or a prefix of it |
| no-loss | dev only | ΔnDCG@10 ≥ 0 (point estimate) |
| answerable-floor | dev only | answerable ΔnDCG@10 ≥ −0.01 |
| compliance (`--change-kind compliance`) | dev and holdout | for a change to the constraint phrases: scored on constraint-filtered qrels against a frozen reference parse; primary ΔnDCG@10 and ΔP@5 ≥ 0, the constraint block's ΔnDCG@10 ≥ 0, every shown result satisfies its parsed constraints, every unparsed query's top 10 unchanged |
| test-set | test | BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, against `eval-v0` |

**No-look routes.** Some changes can't be measured by a relevance look, or are fully checked
without one. Each is a pre-registered rule in ADR 0003 ("No-look routes") whose checks run on the
open sets plus a custodian count, which prints one integer and is logged in
`eval/count-log.md`, not the ledger: `representative-only` (which duplicate-group member is
shown), `answerable-floor` (the no-match answer), `group-first` (the duplicate collapse) and
`gated-without-a-look` (exchange-mode correctness, checked by the oracle suites instead).

## The ranking lock

CI's eval gate (ADR 0013). `eval/ranking-lock.json` holds, for each open-set query, the sha256 of
its HTTP status and ordered result codes: the dev set on the pinned corpus filtered, `--strip ng`
and `--unfiltered`, and the fixture set on its own corpus in the same three modes. It also records
`inputsHash` (the git objects of `LOCK_INPUTS` in `eval/lib/ranking-lock.mjs`: the ranker, the
runner's import closure, the fakes, the eval config, the sets, the embeddings manifest and
`package-lock.json`), the embedding version, the corpus release and the evidence for its lists.

```sh
npm run eval:lock -- --check [--base <rev>]       # the gate (CI's eval-gate; base: merge base with origin/main)
npm run eval:lock -- --diff-ref <ref>             # <ref>'s ranker against HEAD's lock (e.g. the shipped pin)
npm run eval:lock -- --evidence <kind> <ref>      # write changed lists, with their evidence
npm run eval:lock                                 # rewrite for a new embedding version or corpus; refused if the lists change
```

- **Fast path.** HEAD's lock equals the base's, and HEAD's `inputsHash` equals the lock's or the
  base's (the PR base, or `main`'s last green). Seconds, with no `npm ci`. Any lock edit skips it.
- **Recompute.** Otherwise the eval runner recomputes the lists at HEAD (about 30 s locally, no
  Cloudflare call: the pinned corpus and the corpus embeddings are sha-checked release assets).
  They must equal HEAD's lock, or the gate fails naming each changed query with its statuses. A
  neutral change passes and leaves the lock as it is, so PRs never conflict on it.
- **A ranking change** rewrites the lock with evidence written after the base lock, checked
  against the base commit's lock: `holdout-pass <n>` (row n of `eval/holdout-ledger.md`, verdict
  `pass`, against the base commit's `SHIPPED_BASELINE`), `no-look <n>` (row n of
  `eval/count-log.md`, whose `route` names a no-look route), or `revert <commit>` (the lists of an
  earlier lock). Commit the row first; each row is cited once. Unchanged evidence and a shipped-pin
  line are refused; `bootstrap` is allowed only when the base has no lock.
- **What it does not cover.** It compares open sets only: the custodian's holdout count at a ship
  stays. It guards against accidents, not against false evidence; a lock change shows in every
  diff.
- It reads committed content only, so commit before running it. It needs the pinned corpus in
  `.data/` (`gh release download data-2026-2027-20260904 -p '2026-2027-moduleInfo.json.gz' -D .data`,
  then `gunzip`) and downloads the corpus embeddings release asset.
- `test/eval/ranking-lock.node.test.js` fails if the runner's import closure (read with acorn)
  reaches a file outside `LOCK_INPUTS`, or a dynamic import it cannot resolve to a listed path.

## What CI runs

- `check`: `npm run test:eval` (the harness self-test, end to end on the fixture with a throwaway
  key) and `npm run eval:verify` (every ciphertext's sha256 against its manifest, no key).
- `eval-gate`: `npm run eval:lock -- --check`.

## Custody

The held-out sets are protected procedurally (an honest custodian), with encryption at rest:
- ciphertexts are AES-256-GCM with the set and file name bound as additional data, so a file moved
  into another slot or set fails to decrypt;
- the key lives outside the repo (`~/.config/vnm/holdout.key`) and never enters CI, a log or an
  error;
- every ciphertext a verdict reads must match its directory's `MANIFEST.json`;
- the look ledger is append-only, a look past the limit is refused before any retrieval, and a
  look is refused when the ledger has fewer rows than git's copy;
- the baselines are pinned: the test set compares with `eval-v0`, a holdout look with the
  shipped pin, and a baseline run must prove it is that commit's ranker;
- holdout and test commands print only the verdict, the Δ lines and counts; any error prints its
  class and nothing else.

## What the numbers don't show

- **Production.** Every number here is the offline replica on the pinned corpus. Production
  differs in its corpus, its NG files after a revision, and its query vectors (above).
- **Students.** The queries are written for student personas by writer agents (ADR 0003,
  "Provenance"), not taken from real searches.
- **A human view of relevance.** One judge model grades every pair; a cross-family model check is
  the only outside reading (ADR 0016).
- **Dev as an unbiased estimate.** The dev set is open and has screened every change, so dev
  results are optimistic. The holdout has been looked at 8 times, which inflates its
  false-positive rate; the per-change gates are screening. The overall claim rests on the sealed
  test set, used once.
- **Constraint queries.** Queries that need a filter the site doesn't parse ("no Friday classes")
  are a feature-gap block, scored apart, and score low.
- **Exchange-mode correctness.** Which courses an exchange student may take is checked against an
  independent oracle by `npm run test:oracle` ([docs/exchange-mode.md](docs/exchange-mode.md)),
  not by this eval.
