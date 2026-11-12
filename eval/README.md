# Eval harness

How a ranking change is checked. This directory holds the graded query sets, the tooling that
runs the real Worker over them, and the gate a change must pass before it ships. ADR 0003 records
why the rules are what they are; [`JUDGING.md`](JUDGING.md) is the grading protocol.

Where things stand:

- The shipped ranker beats the baseline (`eval-v0`, 5c5cce4) on the sealed test set by
  **+0.120 nDCG@10 (95% BCa CI 0.083 to 0.161)** and +0.059 P@5 (0.036 to 0.090), over 195 primary
  answerable queries. That look is spent: the test set allows one, so the number stands.
- The holdout has had 8 of its 12 looks (`eval/holdout-ledger.md`). Each further per-change
  look spends one.
- The dev set (`eval/dev/`, 98 queries, qrels `qrels-dev-v11`) and the fixture (11 synthetic
  queries) are open and unlimited.
- CI runs the self-test, the ciphertext check and the ranking lock on every PR.

## Checking a ranking change

A ranking change is any change to what `/search` returns for some query: `src/`, `data/`,
`migrations/`, `scripts/lib.mjs` or the test Worker config (`lib/workspace.mjs` `HASHED`).

1. **Find out whether it changes rankings at all.** Commit, then
   `npm run eval:lock -- --check`. It recomputes every dev and fixture list (three filter modes
   each) and compares them with `eval/ranking-lock.json`. If they are equal the change is
   ranking-neutral: nothing else to do, and the lock stays as it is (a neutral change never
   rewrites it). CI's `eval-gate` job runs the same check.
2. **Screen it on dev.** Run the shipped ranker and the candidate, then compare:
   ```bash
   npm run eval -- --variant shipped --ref <SHIPPED_BASELINE sha>   # lib/baseline.mjs
   npm run eval -- --variant cand --baseline shipped [--target-shapes <a,b>] [--change-kind <kind>]
   ```
   This prints the metrics table, the CIs, the per-shape breakdown and the dev gate's verdict.
   Iterate here as often as needed; dev has no look limit.
3. **Take one holdout look** (custodian only, needs the key). Store the candidate's run, then
   take the verdict on stored runs:
   ```bash
   npm run eval -- --holdout --variant cand --store-only
   npm run eval:report -- --holdout --run cand --baseline shipped-<sha7> [--change-kind <kind>]
   ```
   The verdict appends one row to the ledger, pass or fail. Commit the ledger at once: it is
   append-only and a look is refused when it has fewer rows than git's copy.
4. **Rewrite the lock with its evidence**, in the PR that ships the change:
   `npm run eval:lock -- --evidence holdout-pass <ledger row>`. A change that a no-look route
   covers (below) cites its count-log row instead: `--evidence no-look <row>`. Reverting to an
   earlier lock's lists cites that commit: `--evidence revert <commit>`.
5. **Move the shipped pin** in the same PR: set `SHIPPED_BASELINE` in `lib/baseline.mjs` to the
   shipped commit and append a `` - shipped pin: `<ref>` <full sha> `` line to ADR 0003's
   "Shipped-ranker pin" section (`test/eval/baseline.node.test.js` ties the two). After the
   merge, the custodian stores the new baseline's holdout run with
   `npm run eval -- --holdout --variant shipped-<sha7> --ref <sha> --store-only` before the next
   look.

**No-look routes.** Some changes are gated without spending a look (ADR 0003). The custodian
takes a count, which prints one integer and is logged in `eval/count-log.md`, not the ledger:

- a change that moves no holdout list: `eval:count --holdout --lists-differing --run <cand>
  --baseline <shipped>` is 0;
- a representative-only change (which member stands for a duplicate group, never which groups
  show or their order): `eval:representatives` passes on dev and
  `eval:count --holdout --lists-differing --by-group` is 0;
- `--route <route>` names the route in the count log's `route` column, so the lock can cite it.

## Commands

```bash
# runs and reports
npm run eval -- --variant <name> [--ref <git ref>] [--baseline <variant>]    # dev by default; prints the gate when --baseline is given
npm run eval -- --variant <name> --embed-missing                               # embed missing query texts first (cap 500); local only
npm run eval -- --variant <name> --unfiltered | --strip ng                     # filters dropped, or one dropped (the unfiltered guard)
npm run eval -- --variant <name> --ref eval-v0 --embedding emb-bge-small-v0 --mode lexical|vector   # pool variant: one retrieval half; never gated
npm run eval:report -- --run <cand> [--baseline <variant>] [--change-kind <kind>] [--target-shapes <a,b>] [--exempt <file>]
npm run eval:pool -- --runs <a,b,...> [--unjudged [--qrels <file>]]            # blind pool for judges

# the ranking lock (CI's eval gate)
npm run eval:lock -- --check [--base <rev>]                                    # recompute and compare (fast path when nothing it reads changed)
npm run eval:lock -- --diff-ref <ref>                                          # which lists <ref> changes against HEAD's lock
npm run eval:lock [-- --evidence <kind> <ref>]                                 # rewrite the lock at HEAD

# constraint phrases (the compliance rule)
npm run eval:phrases -- list                                                   # every dev query the frozen reference parse reads
npm run eval:phrases -- screen --candidate <ref>                               # the dev screen for a phrase change

# custodian only (encrypted sets)
npm run eval:count -- --custodian --holdout --lists-differing --run <A> --baseline <B> [--by-group] [--route <route>]
npm run eval:count -- --custodian --holdout --emptied-untagged --run <variant>
npm run eval:count -- --custodian --set test --answerable
node eval/cli.mjs retire-run --holdout --variant <name> --reason "<why>"       # replace a stored run (logged)
node eval/suite-custody.mjs --custodian                                         # no holdout text in the query suite

# other
npm run eval:representatives -- --set dev --run <cand> --baseline <pin> [--route representative-only]
npm run eval:judge -- <command>                                                # judging, below
npm run eval:embed                                                             # embed dev query texts missing from the cache
npm run eval:groups [-- --check]                                               # rebuild (or check) eval/groups.json
npm run eval:verify                                                            # ciphertext sha256s vs manifests (CI, no key)
npm run test:eval                                                              # end-to-end self-test on the fixture (CI)
```

`--set dev|holdout|test|fixture` (default `dev`; `--holdout` is `--set holdout`). `--set-dir
<dir>` points a set at another directory (tests). It never moves a custody set's ledger:
`holdout` and `test` always count looks in `eval/holdout-ledger.md`, so a copy of the
ciphertexts cannot start a fresh count. `--embedding <version>` picks a corpus embedding
(default from `embeddings.json`). Dev run files go to `eval/runs/<variant>.json` (git-ignored).

## What a run is

A run executes the actual Worker (the default export of `src/index.js`) inside workerd under
`vitest.eval.config.mjs`, which is not part of `npm test`:

- a local D1 built from the ranker's own `migrations/`, seeded with the pinned corpus (release
  `data-2026-2027-20260904`, sha-checked) through the Worker's own `/admin/ingest`;
- the pinned corpus is normalised with the eval's own copies of that year's NG list and
  restrictions (`eval/pinned/`), never the live `data/` files, so a Registrar revision moves
  neither the eval nor the lock;
- the ranker's typo vocabulary, duplicate groups, catalogue codes and prefixes are built from
  the run's corpus by the ranker's own code (`lib/corrected.mjs`, `lib/corpus.mjs`), never the
  production files a ref commits;
- dense search over real `bge-small-en-v1.5` corpus vectors, and a fake AI
  (`runner/lookup-ai.js`) that returns real precomputed query vectors by
  `sha256(model + "\n" + text)` and throws, naming `npm run eval:embed`, for a text without one;
- one `/search` per query with production defaults plus the query's `filters` as params, and
  `study` from `eval/study-map.json` for an exchange-mode query. One test per query, named by its
  opaque id.

No Cloudflare call is made during a run. Results leave workerd through `runner/reporter.mjs`,
which writes the run file (ciphertext only for an encrypted set).

`--ref <git ref>` builds a workspace in `.eval-work/` from that ref's ranker files with the HEAD
runner overlaid; without it the working tree is the ranker. `ranker.treeHash` is a content hash
of the ranker files that actually ran (`treeHash()` in `lib/workspace.mjs`, over `HASHED`), so a
run file says which code ran whatever `git rev-parse` said.

## Sets and files

| set | where | format | output |
|---|---|---|---|
| `dev` | `eval/dev/{queries,qrels,embeddings}.json`, `gibberish.json` | plaintext | full table, CIs, per-shape, dev gate |
| `holdout` | `eval/holdout/*.enc` | AES-256-GCM | verdict and overall Δ with CI; ledger; 12 looks |
| `test` (sealed) | `eval/sealed/*.enc` | AES-256-GCM | verdict and Δ; ledger; 1 look (spent) |
| `fixture` | `eval/fixtures/` (its own 23-module corpus) | plaintext | synthetic; the self-test and the lock |
| `selftest` | the self-test's throwaway encrypted copy of the fixture | AES-256-GCM | holdout rules; its own ledger |

Other files: `groups.json` (duplicate groups, below), `embeddings.json` (corpus embedding
versions and their release sha256s), `study-map.json` (persona to year of study for
exchange-mode queries; its sha256 is recorded in every run, so editing it invalidates the stored
baseline runs), `pinned/` (the NG files the pinned corpus is normalised with), `query-rules/`
(the phrase lists, collision list, GE pillars and cohort-only rule the parser's `data/` files
are built from, and the query suite's typo threshold), `ranking-lock.json`,
`holdout-ledger.md`.

`queries.json` (`vnm-eval-queries/1`): per query an opaque `id` (never text), `text`, `filters`
(`sem`, `ng`, `level`, `credits`, `faculty`: the UI state, sent to `/search`), optional
`constraints` (the hard constraints for violations@10; default `filters`), `shapes` tags,
`persona`, a `narrative` (relevant / partially relevant / not relevant) and, for a derived typo
or code variant, `source`. Shape tags: `topical`, `home-course`, `alternatives`, `language`,
`sea-content`, `level-equivalence`, `jargon`, `typo`, `code-exact`, `code-space`,
`code-partial`, `ge-pillar`, `level-intent`, `constraint` (a feature-gap block), `noanswer`,
`code-nonexistent`. `noAnswerByRule: true` marks a non-existent code.

`qrels.json` (`vnm-eval-qrels/1`): `version`, `corpus` (`moduleInfoSha256`, `ngSha256`),
`embedding`, optional extra `groups`, and per query `judgments` (code to grade 0/1/2, or an object
with `grade`, `source`, `round` and per-judge grades and rationales). A run or groups file built
on another corpus than the qrels is refused (`CorpusMismatchError`).

Run file (`vnm-eval-run/1`): `variant`, `set`, `ranker` (ref, sha, dirty, treeHash, runner sha),
`corpus`, `embedding`, `queries` (version, sha256, count), `config`, `results` (id to status and
the top 20 codes), `docs` (metadata of every returned code), `intents` (each query's echoed
constraint parse). No query text.

**Duplicate groups** (`eval/groups.json`, built by `npm run eval:groups` from public corpus
fields only, so the same groups score every set): a variant family is codes with the same prefix
letters and four digits differing only in suffix letters, with the same title (TR3202I/S/T); a
cross-listing is different codes with the same title and description (never on an empty or `Not
Available` description). Groups are transitive. `test/full/groups.node.test.js` checks the
committed file is what the builder produces.

## Metrics (`lib/metrics.mjs`, `lib/stats.mjs`)

- nDCG@10, gain 2^g − 1, discount log2(rank + 1), duplicate-group aware: only the first member
  of a group to appear earns gain, and the ideal ranking holds one document per group. A
  returned member breaking the query's constraints belongs to no group for that query.
- P@5 and MRR@10 over group-first documents with grade ≥ 1. Unjudged counts as 0; gates need
  judged@10 = 100%.
- Each query is in one of three sets: **answerable** (some grade ≥ 1; primary metrics are macro
  means over those without a feature-gap shape, which report as their own block),
  **no-answer** (tagged `noanswer` or `code-nonexistent`, or `noAnswerByRule`, and no grade ≥ 1;
  scored on correct-empty rate) and **unscored** (untagged with no grade ≥ 1; in no metric).
- A non-200 response is an error, never an answer: never correct-empty, nothing relevant.
- violations@10: top-10 documents breaking the constraints (NG means NG in that semester).
- Paired over the primary set: BCa bootstrap 95% CI (10,000 resamples, seed 20261104, checked
  against scipy in `test/eval/stats.node.test.js`), sign-flip randomisation p, and a
  persona-clustered bootstrap. Dev adds a per-shape breakdown with a one-sided 95% upper bound.

## The gate (`lib/gate.mjs`)

Every verdict compares the candidate with the shipped ranker (the test set: with `eval-v0`).
Every rule also fails a candidate with **more errored queries** than its baseline, and any
comparison over **fewer than 10** primary answerable queries. A CI-based check never passes on a
degenerate interval (zero variance).

- **general, dev:** no exact-code regression, and the ΔnDCG@10 BCa 95% lower bound > 0.
- **targeted, dev** (`--target-shapes a,b`): every target's ΔnDCG@10 > 0 and overall Δ ≥ 0, over
  at least 3 target queries; fails if a target's one-sided 95% upper bound is below 0.
- **holdout:** ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates), no exact-code regression (a
  `code-exact` query whose relevant rank 1 gets a lower-graded rank 1), judged@10 100%.
- **cutoff** (`--change-kind cutoff`, both sets): correct-empty gain ≥ 0.25 and answerable
  ΔnDCG@10 ≥ −0.01. Taken only if every candidate list is the baseline's or a prefix of it with
  the same status (`CutoffError` otherwise): a cutoff truncates, never reorders.
- **no-loss** (dev only): ΔnDCG@10 ≥ 0 (point estimate); `--exempt <file>` leaves listed dev ids
  out of that one figure.
- **answerable-floor** (dev only): answerable ΔnDCG@10 ≥ −0.01.
- **compliance** (`--change-kind compliance`, dev and holdout, for a change to the constraint
  phrases; `lib/compliance.mjs`): a frozen reference parse (tag `parse-reference`, fbfae10) decides each
  query's constraints; the candidate's echoed parse must equal it on every query
  (`ParseMismatchError` before any look); relevant documents failing a constraint drop to grade 0
  for both runs. Passes iff primary ΔnDCG@10 and ΔP@5 ≥ 0, the constraint block's ΔnDCG@10 ≥ 0,
  no exact-code regression on the raw qrels, every shown result of a parsed query satisfies its
  constraints, and every unparsed query's top 10 equals the baseline's. On the holdout it is
  taken on stored runs with `eval:report`.
- **test set:** BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, judged 100%.

The rule applied is printed with every verdict and recorded in the ledger's `rule` column
(`general`, `targeted: <shapes>`, `cutoff`, `compliance`, `test-set`).

## Holdout and test-set custody

The held-out sets are protected by encryption, manifests, a look ledger and pinned baselines.
It is procedural (an honest custodian), not adversarial security.

- **Encryption.** Ciphertexts (`VNMENC2`, AES-256-GCM) bind the set and file name as additional
  data, so a file moved into another slot or set fails to decrypt. The key lives at
  `~/.config/vnm/holdout.key` (`$VNM_HOLDOUT_KEY_FILE` overrides) and never enters the repo, CI,
  logs or error messages. Plaintext exists only in memory; `holdout.mjs decrypt` refuses a path
  inside the repo.
- **Manifests.** Every ciphertext a verdict reads must be listed with its sha256 in its
  directory's `MANIFEST.json` (`ManifestError` otherwise). `npm run eval:verify` checks this in
  CI without the key. Writing a run adds that one file to the manifest and re-hashes nothing
  else; a stored run is never overwritten (retire it first with `retire-run`, which logs it).
- **The ledger.** Every verdict appends a row to `eval/holdout-ledger.md`; a look past the limit
  is refused before any retrieval. `npm run eval` reserves its row before retrieval and then
  fills it in (or marks it `aborted` / `unjudged`; the look stays counted). Check-then-append
  runs under an exclusive lock file. A look is refused when the ledger has fewer rows than its
  copy at `HEAD` or `origin/main`.
- **Pinned baselines** (`lib/baseline.mjs`). The test set compares with `PINNED_BASELINE`
  (`eval-v0`); a holdout look with `SHIPPED_BASELINE`. The baseline run must record that ref and
  sha, a clean ranker and runner, the commit's `treeHash`, the queries' filters and hybrid mode.
- **Output.** Holdout and test commands print only the verdict, the Δ lines and counts. Any
  error prints `eval: holdout run failed (<ErrorClass>); details withheld` and nothing else.
- **Counts are not looks** (`eval:count`): one integer, logged in `eval/count-log.md` (created
  on first use), which the ledger refuses to read.

Custodian setup:

```bash
node scripts/holdout.mjs keygen                                        # once
node scripts/holdout.mjs encrypt <plain.json> --as queries.json        # also qrels.json, embeddings.json
npm run eval:embed -- --set holdout                                    # encrypted query cache
node scripts/holdout.mjs verify                                        # = npm run eval:verify
```

## The ranking lock (`lib/ranking-lock.mjs`, `eval/lock.mjs`)

`eval/ranking-lock.json` holds, for every dev and fixture query in three filter modes
(filtered, `--strip ng`, unfiltered), the sha256 of its status and ordered codes, plus the
embedding version, corpus release, `inputsHash` (the git objects of `LOCK_INPUTS`: `HASHED`, the
runner's import closure, the open sets, the study map, `package-lock.json`) and the evidence for
the lists.

`npm run eval:lock -- --check` takes a fast path when the lock equals the base's and the inputs
equal the lock's or the base's; otherwise it recomputes the lists and requires them to equal the
lock. Lists that differ from the base lock's need evidence written after it: `holdout-pass <row>`,
`no-look <row>`, `revert <commit>`, or `bootstrap` (only when the base has no lock). It reads
committed content only, so commit before running it; it needs the pinned corpus in `.data/` and
downloads the corpus embeddings release asset.

**Re-pinning.** Nothing to do for a neutral change: `npm run eval:lock` on it reports that the
lock stays as it is, and CI recomputes and passes. For a change to the lists, see step 4 above.
`test/eval/ranking-lock.node.test.js` fails when a file in the runner's import closure is outside
`LOCK_INPUTS`.

## Judging

Protocol, grades, judge instructions and worked examples: [`JUDGING.md`](JUDGING.md). One judge
(A, `claude-opus-5-5`); the final grade is `rule`'s where it applies, else A's. The tooling makes
no model or Cloudflare call; a person hands each packet to a judge run.

```bash
npm run eval:pool -- --runs shipped,cand --unjudged                   # -> .eval-work/pool-dev.json
npm run eval:judge -- prepare --round r1 --judges claude-opus-5-5 [--drift-from eval/dev/qrels.json]
#    -> .eval-work/judging/dev/plain-r1/packets/A-bNN.md: hand each path to one judge run
npm run eval:judge -- collect --round r1                              # validates; repeats and drift
npm run eval:judge -- merge --round r1                                # -> eval/dev/qrels.json, version bumped
npm run eval:judge -- code-rule [--holdout]                           # code-target rule grades onto existing qrels
npm run eval:judge -- calibrate export [--n 150]                      # human calibration (dev only)
npm run eval:judge -- calibrate import --csv <filled.csv> --baseline shipped --run cand
npm run eval:judge -- status --round r1
npm run eval:judge -- clean --round r1 [--state]
```

Common flags: `--set` / `--holdout` / `--set-dir`, `--work-dir`. `prepare` takes `--pool`,
`--batch-size 12`, `--repeat-rate 0.05`, `--drift-rate 0.05` and `--seed 20261104` (every
shuffle and pick derives from it and is recorded). `merge` takes `--base <qrels>` or `--no-base`,
`--out`, `--version`. Two-judge rounds (`agree`, `adjudicate`, `drop-judge`) are supported and
described in JUDGING.md; the current protocol does not use them.

Before any judge sees a pooled candidate, one breaking its query's hard constraints is graded 0
by judge `rule` and left out of the packets. `collect` refuses a section file with a missing,
unknown or out-of-range grade or an empty rationale, and lists each problem. `merge` refuses
while any pooled pair lacks a grade, pairs already in the base qrels, and a base judged on
another corpus.

On an encrypted set the custodian pools with `--custodian` and runs the same commands with
`--holdout`: state and qrels are written only as ciphertext, packets exist in plaintext only in
`.eval-work/judging/holdout/plain-<round>/` (mode 0700, git-ignored), and `clean --holdout`
removes them once `merge` has run.

## Adding queries

- **Query suite** (`test/query-suite/queries.json`, the query-understanding acceptance suite run
  by `test/full/query-suite.test.js`): add items with the existing `row` and `rule` shapes,
  update the row counts in `test/query-suite/suite-files.node.mjs` and the pinned sha256 in
  `test/query-suite/suite.node.test.js`, list each new text in
  `test/query-suite/needs-embedding.txt`, embed every form `queryTextForms` gives into
  `test/query-suite/embeddings.json` (`npm run eval:embed -- --texts <file.json> --out
  test/query-suite/embeddings.json`), then have the custodian run
  `node eval/suite-custody.mjs --custodian` (exit 0: no holdout text or code target overlaps).
- **Dev or fixture set:** a new query changes the ranking lock's lists, and the lock has no
  evidence kind for a set change, so `eval:lock` refuses it. Extend `checkEvidence` first. Then
  embed (`npm run eval:embed`), pool, judge and merge as above. A new exchange-mode query must
  use a persona already in `eval/study-map.json`.
- **Holdout:** custodian only, through `holdout.mjs encrypt`, and only with texts no one has
  tuned against.

## Embeddings

- `scripts/embed.mjs` calls Workers AI `@cf/baai/bge-small-en-v1.5` over REST (batches of 100)
  with the token from `wrangler auth token` (never stored or printed). It estimates neurons from
  token counts before any call, refuses above the cap (500 for queries, 2,500 for `--corpus`),
  and writes a run record (`ops/runs/`). Local only; CI never calls Cloudflare.
- Corpus embedding versions are release assets with their sha256s in `embeddings.json`; the
  lock records the one in use (`emb-bge-small-v1`). A new embedding text needs a new version:
  `npm run eval:embed -- --corpus --ref <ref> --version <new>`, then
  `gh release create <new> .data/emb/<new>/corpus.* --notes "<sha256s>"` and an entry in
  `embeddings.json`. A run refuses a ranker whose corpus texts are not all in its `--embedding`
  version.
- A ranker that embeds corrected or phrase-stripped query text needs those texts embedded too:
  `npm run eval:embed -- --set <set> --corrected-from-ref <ref>` (`--suite` for the query suite).
- Workers AI is not bit-deterministic across batches (cosine 0.98 to 0.9998 between batches), so
  the offline replica can differ from live ranking near ties.

## Self-test

`npm run test:eval` (in CI): runs everything above through the CLI on the fixture set with a
throwaway key, including the encrypted rules on the `selftest` copy and a `--ref eval-v0` run
whose `treeHash` must equal `git archive eval-v0`'s. `eval/fixtures/expected-v0.json` is the
golden output at `eval-v0`; regenerate it only on a deliberate harness or embedding change. It
needs a clean runner (`eval/runner`, `eval/lib`, `test/fakes.js`, `vitest.eval.config.mjs`
committed), as baseline runs record `runner.dirty`.
