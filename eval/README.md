# Eval harness (Phase 2)

Plan: [`docs/plans/phase2.md`](../docs/plans/phase2.md) (later sections supersede earlier ones).
This directory holds the tooling. The query sets come from workstream 2b and the judgments from 2d.

## What a run is

A **variant** is (ranker ref × embedding version × query set). A run executes the **actual
Worker** (default export of `src/index.js`) inside workerd under `vitest.eval.config.mjs`, which
is not part of `npm test`:

- local D1 built from the ranker's own `migrations/`, seeded with the full pinned corpus
  (release `data-2026-2027-20260904`, sha-checked) **through the Worker's own `/admin/ingest`**;
- the fake Vectorize from `test/fakes.js`, filled by that ingest with **real** corpus embeddings;
- a fake AI (`runner/lookup-ai.js`) that returns **real** precomputed `bge-small-en-v1.5` vectors
  by `sha256(model + "\n" + text)` and throws loudly, naming `npm run eval:embed`, for any text
  without one;
- one `/search` per query with production defaults (no `topK`, so 20; depth as the Worker
  computes it) plus the query's `filters` as API params. One test per query, named by its
  opaque id.

Embeddings enter workerd through `provide`/`inject` as one base64 Float32 string. Results leave
it through `runner/reporter.mjs`, a Vitest reporter reading `task.meta`, which writes the run
file (ciphertext only for encrypted sets). No Cloudflare call is made during a run.

`--ref <git ref>` builds a workspace in `.eval-work/` from that ref's `src/`, `migrations/`,
`scripts/lib.mjs` and `data/` (the embedding text is part of the ranker) with the HEAD runner
overlaid. Without `--ref` the working tree is the ranker. `ranker.sha` is what `git rev-parse`
says; `ranker.treeHash` is a content hash of the ranker files actually extracted into the
workspace (`treeHash()` in `lib/workspace.mjs`: sha256 over sorted `path\0kind\0sha256` lines
of `src/`, `migrations/`, `scripts/lib.mjs`, `data/`). The self-test checks that a
`--ref eval-v0` run's `treeHash` equals the hash of `git archive eval-v0` of those paths, and
differs from the working tree's whenever git says the trees differ.

## Commands

```bash
npm run eval -- --variant v0 --ref eval-v0                # dev set, baseline ranker
npm run eval -- --variant head --baseline v0              # working tree; prints table, CIs, gate
npm run eval -- --variant typo-fix --baseline v0 --target-shapes typo
npm run eval -- --variant cutoff --baseline v0 --change-kind cutoff
npm run eval -- --variant head-unf --unfiltered           # secondary: filters dropped
npm run eval:report -- --run head --baseline v0           # recompute from run files + qrels only
npm run eval -- retire-run --holdout --variant v0 --reason "<why>"   # custodian: retire a stored encrypted run (logged)
npm run eval -- --variant v0-lexical --ref eval-v0 --mode lexical   # pool variant: one retrieval half only
npm run eval:pool -- --runs v0,head [--unjudged [--qrels <file>]]   # blind pool for judges
npm run eval:judge -- <command>                           # judging (see "Judging" below)
npm run eval:embed                                        # embed dev query texts missing from the cache
npm run eval -- --variant rewrite --embed-missing         # embed missing texts (cap 500), then run; local only
npm run test:eval                                         # self-test on the fixture set (CI)
npm run eval:verify                                       # ciphertext sha256 vs manifests (CI, no key)
npm run eval:groups [-- --check]                          # rebuild (or check) eval/groups.json from the pinned corpus
npm run eval:count -- --custodian --set test --answerable   # custodian: one integer, logged, not a look
npm run eval:count -- --custodian --holdout --emptied-untagged --run <variant>
```

`--mode hybrid|lexical|vector` (default `hybrid`, which sends no parameter) runs one retrieval
half through the Worker's own `mode` parameter (present at `eval-v0` and HEAD) and records it as
`config.mode`. It exists for pool variants only; gates compare shipped (hybrid) runs.

`--set dev|holdout|test` (default `dev`; `--holdout` = `--set holdout`). `--set-dir <dir>` points
a set at another directory (tests). It never moves a custody set's look ledger: `holdout` and
`test` always count looks in `eval/holdout-ledger.md`, so pointing `--set-dir` at the real
ciphertexts, or a copy of them, cannot start a fresh count. `--embedding <version>` picks a corpus embedding version
(default from `embeddings.json`). Run files go to `eval/runs/<variant>.json` (dev).

**Reproduce the fixture end to end (one command, no Cloudflare, no `.data/` needed):**
`npm run test:eval`.

## Sets and files

| set | where | format | output |
|---|---|---|---|
| `dev` | `eval/dev/{queries,qrels,embeddings}.json`, runs `eval/runs/` | plaintext | full table, CIs, per-shape, gate |
| `holdout` | `eval/holdout/*.enc` (queries, qrels, embeddings, `run-<variant>.json.enc`) | AES-256-GCM | verdict + overall Δ with CI; ledger; ≤ 12 looks |
| `test` (sealed, SC5) | `eval/sealed/*.enc` | AES-256-GCM | SC5 verdict + Δ; ledger; 1 look |
| `fixture` | `eval/fixtures/` (own 23-module corpus) | plaintext | synthetic; harness self-test only |
| `selftest` | `--set-dir` (the self-test's throwaway copy of the fixture) | AES-256-GCM | holdout rules; ledger at `<set-dir>/ledger.md` |

`queries.json`:
```json
{ "schema": "vnm-eval-queries/1", "set": "dev", "version": "dev-v1", "queries": [
  { "id": "d-001", "text": "…", "filters": { "ng": true, "sem": 1 },
    "constraints": { "level": [1, 2] }, "shapes": ["topical"], "persona": "cs-us",
    "narrative": "relevant = …; partially relevant = …; not relevant = …",
    "noAnswerByRule": false, "source": "d-000" } ] }
```
- `id`: opaque (`[A-Za-z0-9_-]`); never put text in it. `filters` keys: `sem`, `ng`, `level`,
  `credits`, `faculty` (the UI state; sent to `/search`). `constraints` (optional, defaults to
  `filters`) are the hard constraints used for violations@10.
- `shapes` tags: `topical`, `home-course`, `alternatives`, `language`, `sea-content`,
  `level-equivalence`, `jargon`, `typo`, `code-exact`, `code-space`, `code-partial`,
  `ge-pillar`, `level-intent`, `constraint` (feature-gap block), `noanswer`, `code-nonexistent`.
- `noAnswerByRule: true` for non-existent codes: never answerable, scored on correct-empty.
- **The no-answer set is fixed by tag:** `noanswer`, `code-nonexistent` or `noAnswerByRule`
  (ADR 0003, amendment 2026-11-06). Grades never move a query into or out of it.
- `source`: the id a derived typo/code variant came from (splits follow provenance).

`qrels.json`:
```json
{ "schema": "vnm-eval-qrels/1", "set": "dev", "version": "qrels-dev-v1",
  "corpus": { "moduleInfoSha256": "…", "ngSha256": "…" }, "embedding": "emb-bge-small-v0",
  "groups": [["TR3202I", "TR3202S", "TR3202T"]],
  "queries": { "d-001": { "judgments": { "CS1010": 2, "CS2030": { "grade": 1, "judges": {} } },
                          "groups": [] } } }
```
Grades 0/1/2; a judgment is a number or an object with `grade` (judge ids and rationales may
ride along). `groups` (global and per query) mark extra duplicate groups; the corpus groups
come from `eval/groups.json` (below), so qrels do not need to carry them. `corpus` is required:
`eval:report` and `npm run eval` refuse (`CorpusMismatchError`) when a run's corpus
`moduleInfoSha256` differs from the qrels', or its `ngSha256` does when the qrels record one.
`npm run eval` checks the baseline before any retrieval (on an encrypted set, before the look
is reserved) and the candidate after. Comparison output names the qrels version (`paired over
n primary answerable queries · qrels <version>`; holdout `holdout verdict: PASS · qrels
<version>`).

**Duplicate groups (`eval/groups.json`, `vnm-eval-groups/1`).** Built by `eval/groups.mjs`
(`npm run eval:groups`) from the offered modules of the pinned corpus: public fields only (code,
title, description), never qrels or grades, so the same groups score dev, holdout and test. The
rule (`lib/groups.mjs`): a **variant family** is codes with the same prefix letters and four
digits differing only in suffix letters (TR3202I/S/T, ACC1701X/XA) and the same title; a
**cross-listing** is different codes with the same title and the same description, except the
placeholder `Not Available` or an empty description, which never makes two codes cross-listed.
Titles and descriptions are compared lower-cased with whitespace collapsed. Groups are
transitive; singletons are dropped. groups-v1: 509 groups, 1,562 members, largest 38 (the UTOP
modules). The file records `corpus.moduleInfoSha256`; at scoring time (`eval:report`,
`npm run eval`, calibration's Δ nDCG@10) the harness adds its groups to whatever groups the
qrels carry (overlapping groups join) and refuses (`CorpusMismatchError`) a groups file built
from another corpus than the qrels were judged on. Like the qrels/run corpus check, `npm run eval`
checks it with the baseline before any retrieval (on an encrypted set, before the look is
reserved). Nothing rewrites the qrels, encrypted or not. `test/full/groups.node.test.js` (the full-corpus CI job)
checks the committed file is what the builder produces. Its sha256 is one of ADR 0003's locks
(`test/eval/lock.node.test.js`), so changing the groups means changing the ADR in the same PR.

Run file (`vnm-eval-run/1`): `variant`, `set`, `ranker` (ref, sha, dirty, `treeHash`, runner sha), `corpus`
(release, moduleInfo sha256, NG sha256, module count, sha256 of all embedding texts),
`embedding` (corpus version, model, text ref), `queries` (version, sha256, count), `config`,
`results` (`id → { status, codes, error? }`, top 20 as returned), `docs` (metadata of every
returned code, for violations). No query text.

## Metrics (`lib/metrics.mjs`, `lib/stats.mjs`)

- nDCG@10, gain 2^g − 1, discount log2(rank + 1). Duplicate-group aware (groups from
  `eval/groups.json` plus the qrels'): only the first member of a group to appear earns gain;
  the ideal ranking has one document per group (best grade). Groups ignore level, semesters,
  NG, credits and faculty, so a returned member breaking the query's `constraints` (graded 0
  by rule) is no member for that query and never takes a sibling's slot.
- P@5: group-first documents with grade ≥ 1 in the top 5, divided by 5. MRR@10 likewise.
- Unjudged = grade 0; judged@10 coverage reported; gates need 100%.
- Each query is in exactly one of three sets (`isTaggedNoAnswer`, ADR 0003 amendment 2026-11-06):
  - **no-answer**: tagged `noanswer` or `code-nonexistent`, or `noAnswerByRule`, whatever its
    grades. Scored on correct-empty rate (nothing returned) and false positives.
  - **answerable**: untagged, with some judged document at grade ≥ 1. Primary metrics are macro
    means over answerable queries **without** a feature-gap shape (`constraint`); those are
    reported as their own block.
  - **unscored**: untagged, with no grade-≥1 document. In neither set and in no metric.
    Dev reports list the ids (`unscored (…): n: d-005, …`, and an `unscored n` row). Holdout
    and test verdicts print only the count (`unscored queries: n`).
- **Errors.** A non-200 response is an error, never an answer: it is never correct-empty, and
  nothing in it is relevant (nDCG, P@5 and MRR are 0). `summarise().errors` counts them (the
  `non-200 responses` row), and `npm run eval` prints `errors: n of N queries returned a non-200
  response` after every dev run.
- violations@10: top-10 documents breaking `constraints` (semester; NG means NG *in that
  semester*; level; credits; faculty).
- Paired over the primary set: BCa bootstrap 95% CI (10,000 resamples, seed 20261104; checked
  against scipy in `test/eval/stats.node.test.js`), two-sided sign-flip randomisation p (exact up
  to 16 non-zero deltas), persona-clustered percentile bootstrap. Per-shape breakdown (dev only)
  with a one-sided 95% upper bound (two-sided 90% BCa).

## Gate (`lib/gate.mjs`)

Per change, vs the shipped ranker:
- **every gate** (dev, holdout, cutoff, SC5): **no new errors**: fails if the candidate has more
  errored (non-200) queries than the baseline.
- **dev** (screen): no exact-code regression, and ΔnDCG@10 BCa 95% lower bound > 0, or, if the
  change declares `--target-shapes`, every target's ΔnDCG@10 > 0 and overall Δ ≥ 0 (≥ 3 target
  queries). Tripwire on target shapes only: fails if a target's one-sided 95% upper bound on
  ΔnDCG@10 is below 0.
- **holdout**: ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates), no exact-code regression (no
  `code-exact` query whose baseline rank-1 is relevant gets a lower-graded rank-1), judged@10 100%.
- **no-loss** (`--change-kind no-loss`, dev only; 3F and 3H's dev screen): the CI rule is
  replaced by ΔnDCG@10 ≥ 0 (point estimate). The other dev checks still apply.
  `--exempt <file>` (a JSON array of dev ids, or `{ "ids": [...] }`; no-loss only, refused on
  encrypted sets) leaves those queries out of the no-loss comparison. 3H's constraint-exempt
  queries (C3-8) use it. The report prints each exempt id with its ΔnDCG@10 (`—` when the
  query is not primary answerable).
- **answerable-floor** (`--change-kind answerable-floor`, dev only; 3G): the CI rule is
  replaced by answerable ΔnDCG@10 ≥ −0.01, over the primary set with the no-answer set fixed
  by tag.
- `no-loss` and `answerable-floor` take no `--target-shapes`. No holdout or test verdict takes
  them: the CLI refuses them on an encrypted set before any look, and `gateFor` throws
  `GateRuleError`.
- **cutoff changes** (`--change-kind cutoff`): the no-answer trade-off replaces the Δ rules on
  both sets: correct-empty gain ≥ 0.25 and answerable ΔnDCG@10 ≥ −0.01. It is looser than the
  Δ rules, so it is not taken on the declaration alone: the candidate's result list for every
  query must be the baseline's or a prefix of it, with the same status (a cutoff truncates; it
  never reorders or adds). Anything else is refused (`CutoffError`) before any verdict or look.
  `--change-kind cutoff` takes no `--target-shapes`.
- **The rule applied** is printed with every verdict (`gate (dev): PASS · rule cutoff`;
  `holdout verdict: PASS · rule cutoff · baseline eval-v0 7ac9841 · qrels …`) and recorded in
  the ledger's `rule` column: `general`, `targeted: <shape,…>`, `cutoff`, `no-loss`,
  `answerable-floor` (dev only) or `sc5` (the test set, which takes no `--change-kind` or
  `--target-shapes`, or `--gate sc5`).
- **SC5** (test set): BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, judged 100%.
- **`--gate sc5`** (`eval:report` only, on stored runs) takes the SC5 rule on the holdout, for
  L12 under the holdout reading of SC5. It takes no `--change-kind` or `--target-shapes`, and
  `npm run eval` refuses it. `SC5_READING` in `lib/gate.mjs` is the reading ADR 0003 records,
  and `test/eval/gate.node.test.js` ties the two together. The reading is `sealed`, so
  `--gate sc5` is refused on the holdout (`GateRuleError`, before any look) and on dev. Under
  a `holdout` reading it would be accepted once per ledger, and a per-change holdout look
  would be refused at 11 looks, keeping the 12th for SC5.

Small samples (every gate, every set):
- **Insufficient queries.** A gate whose decisive comparison (the paired primary answerable
  queries) has fewer than 10 queries fails with `insufficient queries: n primary answerable,
  need 10`, however large the gain.
- **Degenerate intervals.** With zero variance (one query, or every delta equal up to float
  noise) `bcaInterval` returns the point as both bounds and sets `degenerate: true`. A CI-based
  check (dev's lower bound > 0, SC5's lower bounds > 0, a tripwire's upper bound ≥ 0) never
  passes on a degenerate interval; the check's detail says `degenerate: no variance`.
- **Small shapes.** A target-shape tripwire over fewer than 3 answerable queries has no usable
  interval and falls back to "point estimate ΔnDCG@10 ≥ 0".

## Judging (2d)

Protocol, grades, the judge instructions (verbatim) and worked examples:
[`JUDGING.md`](JUDGING.md). Judging uses one judge, judge A (`claude-opus-5-5`); the final grade
is `rule`, else A's. Tooling: `eval/judge.mjs` (`npm run eval:judge`), pure logic in
`lib/judging.mjs` and `lib/agreement.mjs`. The lead dispatches the judge agents; the tooling
makes no LLM or Cloudflare call.

```bash
# 1. pool: top-10 of each variant, with the queries' filters
npm run eval -- --variant v0 --ref eval-v0
npm run eval -- --variant v0-lexical --ref eval-v0 --mode lexical
npm run eval -- --variant v0-vector --ref eval-v0 --mode vector
npm run eval:pool -- --runs v0,v0-lexical,v0-vector               # -> .eval-work/pool-dev.json
# 2. rule pre-grading + packets (one per ~12 queries), single-judge round
npm run eval:judge -- prepare --round r1 --judges claude-opus-5-5
#    -> .eval-work/judging/dev/plain-r1/packets/A-bNN.md: hand each path to one judge run
# 3. collect (validates; reports planted-repeat self-consistency and drift)
npm run eval:judge -- collect --round r1
# 4. merge into qrels (base = the existing qrels file, if any; version bumped)
npm run eval:judge -- merge --round r1                            # -> eval/dev/qrels.json
npm run eval:report -- --run v0                                   # scores with it
# 5. human calibration (dev only)
npm run eval:judge -- calibrate export [--n 150]                  # -> .eval-work/calibration-dev.csv
npm run eval:judge -- calibrate import --csv <filled.csv> --baseline v0 --run <candidate>
# later rounds: new variants' unjudged top-10 plus a 5% drift sample of old pairs
npm run eval:pool -- --runs v0,cand --unjudged
npm run eval:judge -- prepare --round r2 --judges claude-opus-5-5 --drift-from eval/dev/qrels.json
npm run eval:judge -- code-rule [--holdout]                       # code-target rule grades onto the set's qrels (version bumped)
npm run eval:judge -- status --round r1                           # mode, dropped slots, progress
npm run eval:judge -- clean --round r1 [--state]                  # removes the packet directory

# a round prepared with two judges becomes single-judge (B's packets, items, grades removed)
npm run eval:judge -- drop-judge --round r1 --slot B --reason "<why>" [--force]

# two-judge rounds only (refused on a single-judge round)
npm run eval:judge -- prepare --round rX --judges claude-opus-5-5,<idB>
npm run eval:judge -- agree --round rX [--json .eval-work/agree-rX.json]
npm run eval:judge -- adjudicate prepare --round rX --adjudicator <id>
npm run eval:judge -- adjudicate collect --round rX --pass 1     # writes the pass-2 packets
npm run eval:judge -- adjudicate collect --round rX --pass 2
```

Common flags: `--set` / `--holdout` / `--set-dir` as for `npm run eval`; `--work-dir` moves
`.eval-work/judging/<set>/` (tests). `prepare`: `--pool <file>` (default
`.eval-work/pool-<set>.json[.enc]`), `--batch-size 12`, `--repeat-rate 0.05`, `--drift-rate
0.05`, `--seed 20261104` (every shuffle, item id, repeat and drift pick derives from it and is
recorded in the state). `merge`: `--base <qrels>` or `--no-base` (refused over an existing target unless `--force`), `--out`, `--version`.
`drop-judge`: `--slot B` (A cannot be dropped), `--reason <text>` (required), `--force` to drop
a judge that already has collected grades; refused once adjudication has started.

- **Pre-grading.** A pooled candidate breaking its query's hard constraints (`constraints`, else
  `filters`: semester, NG in that semester, level, credits, faculty; `violationReason` in
  `lib/metrics.mjs`) is graded 0 by judge `rule` and left out of the packets.
- **Packets.** One Markdown file per judge per batch, self-contained: the instructions and
  examples from `JUDGING.md` verbatim, then per section the query text, intent and constraints in
  words, each candidate (item id, code, title, level, credits, semesters, NG semesters,
  faculty/department, description), the output path and a JSON template
  `{ itemId: { grade, rationale } }`. In a two-judge round A and B get the same pairs, shuffled
  independently. About 5% of each batch's items come back in a later section under new ids (planted repeats).
- **Collect** validates every section file: valid JSON object, every item graded, no unknown
  ids, grades in {0, 1, 2}, a non-empty rationale, no other keys. A valid file replaces the
  section's grades, an invalid one drops them; problems are listed by file, section and item
  id, and the command exits 1. Re-run after the judge fixes its files. In a two-judge round,
  once `adjudicate prepare` has run, the judges' grades are frozen (`collect` refuses), and pass 1 closes when
  the pass-2 packets are written, so the stored `blind` grade really was given blind.
- Judge ids `rule` and `adjudicator` are reserved. `--mode lexical|vector` runs are pool
  variants: `npm run eval` refuses them with `--baseline`, and every gate refuses them.
- **Quality checks** with one judge: planted-repeat self-consistency and the drift sample
  (`collect`), and Jacob's human calibration. Inter-judge κ and α do not apply.
- **Agreement** (`agree`, two-judge rounds only): raw, Krippendorff's ordinal α, binary κ
  (grade ≥ 1), quadratic κ, overall and per shape with n; `—` when undefined (one category only).
- **Code-target rule** (`lib/code-rule.mjs`, JUDGING.md "Code-target rule"). For code-origin
  queries, judge `rule` grades the target (2), its variants and cross-listings (1), or for a
  partial code every offered module with that prefix (2), from public corpus fields only.
  Pooled or not, hard constraints still give 0. `merge` applies it last, replacing A's grade on
  the pairs it names; `code-rule` applies it to existing qrels (`--qrels`, `--out`, `--version`
  as for `merge`). On an encrypted set it prints counts only (queries affected, pairs added and
  changed by grade, A grades overridden) and takes no look.
- **Final grade** = `rule`, else A's grade (`judged`). In a two-judge round: `rule`, else
  A = B (`agreed`), else the adjudicator's pass-2 grade (`adjudicated`). `merge` refuses while
  any pooled pair lacks one (an ungraded A pair; counts only), refuses pairs already in the base
  qrels, and refuses a base judged on another corpus.
- **Qrels written** (`vnm-eval-qrels/1`): `version` bumped (`qrels-<set>-v1`, then `-v2`, …),
  `corpus` (`moduleInfoSha256`, `ngSha256`) and `embedding` from the pool's runs, the base's
  `groups` kept, a `judging` log of rounds, and per judgment
  `{ grade, source: rule|judged|agreed|adjudicated, round, judges }`, where `judges` maps each
  judge id to `{ slot, grade, rationale }` (the adjudicator's also carries its `blind` pass-1
  grade). A single-judge round's `judging` entry has `mode: "single"`, `judges: { A }`,
  `adjudicator: null` and, after `drop-judge`, `dropped: [{ slot, judge, reason, at }]`; a
  two-judge entry has no `mode`.
- **Calibration** exports ~150 pairs stratified by grade and by shape (rule pairs excluded) as a
  blind CSV (`your_grade` to fill). The import reports agreement of Jacob's grades with A and
  the final grade, and Δ nDCG@10 (candidate − baseline) with its sign under A's, the final and,
  on the calibrated subset, Jacob's grades. On a two-judge qrels it also reports B; a judge the
  qrels hold no grades from gets no row. Refused for encrypted sets.

**Encrypted sets (custodian only).** Pool with `--custodian`, then the same commands with
`--holdout`. The round's state (`.eval-work/judging/holdout/state-<round>.json.enc`) and the
qrels (`eval/holdout/qrels.json.enc`, added to `MANIFEST.json`) are written only as ciphertext.
Packets and judge outputs exist in plaintext only in `.eval-work/judging/holdout/plain-<round>/`
(mode 0700, git-ignored), and `prepare` prints the command that deletes it:
`npm run eval:judge -- clean --holdout --round <round>`. Run it once `merge` has run (collect
stores everything in the encrypted state). Errors print only their class; validation problems
(file, section, item id, value type) and aggregate numbers are printed.

## Embeddings

- `scripts/embed.mjs` calls Workers AI REST `@cf/baai/bge-small-en-v1.5` (default pooling,
  batches of 100) with the token from `wrangler auth token` (per run, never stored or printed)
  and the account from `$CLOUDFLARE_ACCOUNT_ID` or `wrangler whoami`. It estimates neurons from
  token counts (1,841 / M tokens) before any call, refuses above the cap (500 for queries,
  2,500 for `--corpus`), and appends every spend to `docs/evidence/neurons.tsv`. Local only;
  CI never calls Cloudflare.
- Corpus: `emb-bge-small-v0` (release asset; sha256s in `embeddings.json`, verified on every
  download/use): 5,920 unique embedding texts of the pinned corpus, text = `embeddingText()` at
  `eval-v0`. A new embedding text needs a new version:
  `npm run eval:embed -- --corpus --ref <ref> --version <new>`, then
  `gh release create <new> .data/emb/<new>/corpus.* --notes "<sha256s>"` and an entry here.
- **Workers AI is not bit-deterministic across batches.** The same text in two REST calls:
  cosine 0.9994–0.9998 (3 texts); fixture texts embedded in a batch of 31 vs the corpus pass's
  batches of 100: min 0.9797, median 0.9957 (23 texts). Production's own vectors were embedded
  in other batches, so the offline replica can differ from live ranking near ties; the fidelity
  check (2c) measures how much.

## Holdout custody

Procedural, honour-system plus encryption at rest (ADR 0003 states this). The custodian:

```bash
node scripts/holdout.mjs keygen                                   # once; key at ~/.config/vnm/holdout.key
node scripts/holdout.mjs encrypt /secure/queries.json --as queries.json   # also qrels.json, embeddings.json
npm run eval:embed -- --set holdout                               # encrypted query cache
npm run eval -- --holdout --variant v0 --ref eval-v0 --store-only # stored, no verdict, no look
npm run eval -- --holdout --variant cand --baseline v0            # verdict + Δ; one ledger row
npm run eval:pool -- --set holdout --runs v0,cand --custodian     # encrypted pool for judges
```

Ciphertexts (`VNMENC2`) bind the set name and the file name as AES-GCM additional data
(`holdout/qrels.json`), so a file renamed into another slot, or copied into another set's
directory (holdout files read as `test` or `selftest`), fails to decrypt. `holdout.mjs encrypt`
and `decrypt` infer the set for `eval/holdout` and `eval/sealed` and need `--set` anywhere else.
That binding is what lets the `selftest` set keep its ledger in its own directory: real holdout
ciphertexts cannot be read through it.

**What a verdict refuses** (every holdout and test-set verdict, `run` and `report`; all before
a look is reserved or appended, so a refusal uses no look):
- **A baseline that is not the pinned `eval-v0`** (`BaselineError`). ADR 0003 pins `eval-v0` =
  7ac9841 (`lib/baseline.mjs`). The tag must still resolve to that commit, and the baseline
  run file must record ranker ref `eval-v0`, that sha, `dirty: false`, and the `treeHash` of
  that commit's ranker files (`git archive`, the paths `lib/workspace.mjs` hashes). The ledger's
  `baseline ranker` column records the baseline run's ranker sha.
- **A ciphertext the manifest does not vouch for** (`ManifestError`). Every encrypted file a
  verdict reads (queries, qrels, both run files, and for `run` the query-embedding cache) must
  be listed in the set directory's `MANIFEST.json` with its sha256, the check `eval:verify`
  makes; the bytes checked are the bytes decrypted. A `--set-dir` with no manifest, a file it
  does not list, a mismatch, or a run file outside the set directory is refused.
- **A cutoff candidate that is not a truncation** (`CutoffError`, above). On an encrypted set
  the candidate of `npm run eval` does not exist until after its look is reserved, so a cutoff
  verdict is taken on a stored run: `--store-only`, then `eval:report --change-kind cutoff`.

**Stored runs are never overwritten.** `npm run eval` (with or without `--store-only`) refuses
to write an encrypted run file the manifest already lists. Writing a run adds that one file
to the manifest and re-hashes nothing else, so a tampered ciphertext stays flagged by
`eval:verify` (`holdout.mjs manifest` remains the custodian's explicit full rewrite).
Replacing a stored run is a separate, logged command:

```bash
npm run eval -- retire-run --holdout --variant v0 --reason "<why>"
```

It appends a row (date, set, file, the retired ciphertext's sha256, reason) to
`eval/retired-runs.md` (the `selftest` set: `<set-dir>/retired-runs.md`), deletes the
ciphertext and drops its manifest entry; `--store-only` can then write the replacement.
Retiring needs no key and is not a look. Commit the log with the new manifest.

`$VNM_HOLDOUT_KEY_FILE` overrides the key path. The key never enters the repo, CI, logs or
error messages. Plaintext is decrypted in memory; `decrypt` refuses to write inside the repo.
Holdout runs use only the eval reporter, with console output silenced, so no id, text or
per-query error reaches the terminal. Any error in a holdout or test command prints one line,
`eval: holdout run failed (<error class>); details withheld`, and nothing else; the class
(`DecryptionError`, `KeyFileError`, `LookLimitError`, `LedgerTamperError`, `LedgerLockError`,
`CorpusMismatchError`, `QrelsError`, `RunFileError`, `ManifestError`, `BaselineError`,
`CutoffError`, see `lib/errors.mjs`) says what went wrong.
Metrics errors carry no judgment content in any set: a bad grade is reported by its value and
position (`query #3, judgment #2 has grade 7`), never its rationale, query id or code. Every verdict appends a row to `eval/holdout-ledger.md` (with the rule applied and the
baseline's ranker sha);
a 13th holdout look (2nd test-set look) is refused before any retrieval runs. Every table row
except the header and separator lines counts, however it is spaced; a row whose set cell is not
a known set counts against every set. A look is also refused (`LedgerTamperError`) when the
ledger has fewer rows than its copy at `HEAD` or `origin/main`, or is missing while git has it:
the ledger is append-only, so commit it after every look.

**Counts are not looks** (`eval/count.mjs`, ADR 0003 amendment 2026-11-06). `npm run eval:count`
is custodian-only: it refuses without `--custodian`, on dev and the fixture, and with any option
outside `--custodian`, `--set`, `--holdout`, `--set-dir`, `--answerable`, `--emptied-untagged`
and `--run`. It prints one integer and nothing else:
- `--set test --answerable`: the test set's primary answerable queries (untagged, some grade ≥ 1,
  no feature-gap shape), for SC5's stopping rule;
- `--holdout --emptied-untagged --run <variant>`: holdout queries not tagged no-answer that the
  stored run returns empty (status 200, no codes; an error is not empty), for 3G's gate.

Both read their ciphertexts through the manifest check. A run must have been made on the set's
current queries (`RunFileError`). Any failure prints only `eval: <set> count failed
(<ErrorClass>); details withheld`. Each call appends `| date | set | count: <kind> | run | n |`
to `eval/count-log.md` (for `selftest`, `<set-dir>/count-log.md`). Commit it with the work the
count served. The ledger never reads the count log, and it refuses a row carrying a `count: …`
cell (`LedgerTamperError`), so a count can never be recorded or spent as a look.

Parallel looks cannot pass the limit. Check-then-append runs under an exclusive lock,
`<ledger>.lock` (created with `O_EXCL`, removed when done). A second eval waits up to 2 minutes
and then fails with `LedgerLockError`. A lock older than 30 minutes is treated as abandoned and
removed, with a message saying so. `eval:report` checks, computes and appends inside the lock.
`npm run eval` reserves its look before retrieval starts: it appends a `reserved <token>` row,
which counts as a look. It then replaces that row with the verdict, or with `aborted` (the run
failed) or `unjudged` (judged@10 < 100%); either way the look stays counted. CI never has the
key: `npm run eval:verify` checks only that each ciphertext matches its `MANIFEST.json` sha256.

## Fixture set and self-test

`eval/fixtures/`: 23 modules hand-picked from `test/fixtures/corpus.json`, 11 synthetic queries
covering every scoring path (duplicate groups, filters, an NG-semester violation, no-answer, a
non-existent code, a feature-gap query, a > 200-character query that returns 400), complete
synthetic qrels, and real embeddings for all 31 texts (embedded once, 6.7 neurons).
`expected-v0.json` is the golden output at `eval-v0`; regenerate it only on a deliberate harness
or embedding change. `npm run test:eval` runs everything above through the CLI with a throwaway
key; it is in CI.
