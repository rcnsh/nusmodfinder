# 0003: Eval query sets, holdout custody and the pre-committed gate

Status: accepted. The rules are in code (`eval/lib/`) and tested; this record says why they are
what they are and holds the hashes that lock the sets. How to use them is in
[EVAL.md](../../EVAL.md) and [`eval/README.md`](../../eval/README.md).

## Context
A ranking change has to be shown to help on queries it wasn't tuned on. Reusing one held-out set
adaptively inflates the false-positive rate: a simulation put it at 14% after 9 changes against
2.5% nominal. So the held-out data is split into a per-change holdout with a fixed look budget
and a sealed test set looked at once, both encrypted, and every rule a verdict uses is written and
committed before the look it governs.

## Query sets
| set | where | size | role |
|---|---|---|---|
| dev | `eval/dev/queries.json` (plaintext) | 98 | tuning; open; full per-query output |
| holdout | `eval/holdout/queries.json.enc` (encrypted) | 81 | per-change gate; verdict only; at most 12 looks |
| test | `eval/sealed/` (encrypted) | 195 primary answerable | the final measurement against `eval-v0`; one look, spent |
| fixture | `eval/fixtures/` | 11 synthetic | the self-test and the ranking lock |

- **Provenance.** 180 queries: 147 written by six persona writers (subagents with no corpus or
  tool access, each given persona cards and seeded shape quotas), 18 mechanical code queries and
  15 noise-model typos. The queries are written for student personas, not taken from real
  searches.
- **Split.** A derived typo or code variant follows its source. Then topic clusters (TF-IDF over
  the query text and its relevance narrative, single-link union at cosine ≥ 0.35, the lowest
  threshold in 0.30–0.50 that leaves every shape at least 2 queries per split), then
  stratification by shape: dev 98, holdout 81.
- **Code queries carry their form as a shape** (`code-exact`, `code-space`, `code-partial`,
  `code-nonexistent`), so the exact-code check sees them. A non-existent code carries
  `noAnswerByRule: true`, so no judge's grade can make it answerable. The holdout's 7 code
  queries are drawn from a secret seed held in custody, and a drawn target may not overlap, as a
  prefix either way, any dev code target, any code example the writers saw (`CS3244`, `CS32`,
  `GEA`) or another draw. Its partial query is a code family, not a GE pillar: only six pillars
  exist and three are public, so a pillar could be guessed.
- **Locks.** `test/eval/lock.node.test.js` fails unless the files match these hashes, so
  changing a set means changing this record in the same PR.
  - dev plaintext sha256 `fe7a248f9de3de04ef41af723c8ffd274805c283c8be3c002de026e75bb742ce`.
  - holdout plaintext sha256 `685881afb719558de8f3988af477832c6d050382bd8e4885203139a4f9db946a`
    (checked on decrypting the committed ciphertext).
  - holdout ciphertext sha256 `d7b6af869b8491588622fc27e2a8b13917bf51562a5a6c3d1d1eaf1c4c37e079`,
    recorded in `eval/holdout/MANIFEST.json`.
  - groups-v1 `eval/groups.json` sha256 `aee97d57a7201118601562bc90864dd83a386bf14f3945646abc9ac478878a22`
    (509 duplicate groups, below).

## The sealed test set
Written after the ranker it measures was frozen, with the same writer prompt, personas and
shape procedure, fresh writer runs and a new seed. Its code queries come from a secret seed whose
sha256 alone is recorded, under the same overlap rule against every dev and holdout code target.
It was pooled from `eval-v0` and the frozen ranker and judged under the same protocol.
- **Leak filter.** A test query is dropped when its query-embedding cosine to any dev, holdout,
  query-suite or gibberish query, or to an earlier kept test query, is ≥ 0.9, or when it shares a
  source query with one. The verdict is on the filtered set.
- **Size.** Writing continued until at least 160 primary answerable queries remained; the
  custodian's count read 195.
- **Its one look is spent** (`eval/holdout-ledger.md`, the `test` row). It is never looked at
  again, so the number stands as the measurement of that ranker.

## Custody
Procedural custody with encryption at rest: an honest custodian, not technical isolation.
- **The key** is a 32-byte hex file at `~/.config/vnm/holdout.key` (mode 600;
  `$VNM_HOLDOUT_KEY_FILE` overrides). It is never in the repo, CI, a log or an error. The
  custodian keeps the holdout plaintext beside it under `~/.config/vnm/custody/` (mode 700), so
  the key is never the only copy.
- **Encryption.** Queries, qrels, query embeddings and run files of an encrypted set are
  committed only as AES-256-GCM ciphertexts (`VNMENC2`) whose additional authenticated data is
  `<set>/<file>`, so a file moved into another slot or set fails to decrypt. A hex key file was
  chosen over `age` and the keychain so no CI secret is needed: CI checks ciphertext hashes only.
- **Manifests.** Every ciphertext a verdict reads must match its directory's `MANIFEST.json`
  (`ManifestError`); a set directory with no manifest, or holding any file but `*.enc` and the
  manifest, is refused. `npm run eval:verify` checks this in CI without the key. Writing a run
  adds that one file to the manifest; a stored run is never overwritten, and replacing one is
  `node eval/cli.mjs retire-run`, logged with the retired ciphertext's sha256 in
  `eval/retired-runs.md`.
- **Output.** Holdout and test commands print only the verdict, the overall Δ lines with their
  CIs and counts. Any error prints `eval: <set> run failed (<ErrorClass>); details withheld`.
  Retrieval runs in a child process whose output is discarded.
- **Isolation.** Whoever tunes a ranker never decrypts and never holds the key.

## Looks
A look is any run or report that prints a verdict for an encrypted set.
- `eval/holdout-ledger.md` holds one row per look (set, commit, variant, baseline, verdict, Δs,
  rule, the baseline's ranker sha). `holdout` allows 12 and `test` 1; there is no 13th holdout
  look.
- A run reserves its row before retrieval, and a reserved row counts even when the run is
  aborted or unjudged. A lock file serialises check-then-append. A look is refused when the
  ledger has fewer rows than git's copy at `HEAD` or `origin/main`.
- **The look procedure.** The custodian stores the candidate (`--holdout --store-only`), and the
  baseline too unless it is stored and fully judged; pools the stored runs' unjudged documents,
  encrypted; judges and merges so judged@10 is 100% for both; and only then takes the verdict with
  `npm run eval:report -- --holdout` on the stored runs. `report` runs no retrieval and records a
  look only for a fully judged pair, so no look is spent `unjudged`. The ledger is committed after
  each look.
- **Each further look needs its rule committed first**: what is compared, the metric, the pass
  condition, and how exchange-mode removals are scored. Without one, no look is taken.
- **Counts are not looks.** `npm run eval:count` is custodian-only (refused without
  `--custodian`, and on dev) and prints one integer: the test set's primary answerable count; the
  holdout queries outside the no-answer set a stored run returns empty
  (`--emptied-untagged`); or how many holdout lists differ between two stored runs
  (`--lists-differing`, by status and codes in order, or with `--by-group` by status and sequence
  of duplicate-group keys). Every call appends a row to `eval/count-log.md`, which the ledger
  never reads and refuses a row copied from (`LedgerTamperError`). No option makes it print ids
  or metrics.

## Metrics
- nDCG@10 (gain 2^g − 1, discount log2(rank + 1)), P@5 (grade ≥ 1, divisor 5) and MRR@10, macro
  means over the primary answerable queries.
- **Duplicate groups** (groups-v1, `eval/groups.json`, built from public corpus fields so the
  same groups score every set): variant families (same prefix letters and four digits, differing
  only in suffix letters, same title) and exact cross-listings (same title and description). Only
  the first member of a group to appear earns gain, in DCG, IDCG, P@5 and MRR. The product
  collapses by the same rule (ADR 0006).
- **The no-answer set is tagged and unanswered.** A query is no-answer iff it is tagged
  `noanswer` or `code-nonexistent`, or carries `noAnswerByRule`, **and** no judged document has
  grade ≥ 1. The judges' grades are the ground truth: the tag is necessary, not sufficient. A
  tagged query with a grade-≥1 document is answerable, so emptying it is a loss. An untagged query
  with no grade-≥1 document is **unscored**, in no metric; holdout and test verdicts print only
  the count of those.
- No-answer queries are scored by correct-empty rate and false positives. A non-200 response is
  an error, never correct-empty and never relevant.
- judged@10 must be 100% for any run a gate uses.
- Intervals: the paired BCa bootstrap (10,000 resamples, seeded) governs; a sign-flip test and a
  persona-clustered bootstrap are reported beside it.

## The gate (`eval/lib/gate.mjs`)
Every rule fails a candidate that has more errored (non-200) queries than its baseline, that is
compared over fewer than 10 primary answerable queries, or whose either run is below 100%
judged@10. A CI-based check never passes on a degenerate interval (one query, or every delta
equal). Every verdict prints the rule it applied, and the ledger records it.

| rule | where | a change passes iff |
|---|---|---|
| general | dev | no exact-code regression, and the ΔnDCG@10 BCa 95% lower bound > 0 |
| targeted (`--target-shapes`) | dev | every target's ΔnDCG@10 > 0 and overall ΔnDCG@10 ≥ 0, over ≥ 3 distinct answerable target queries; the tripwire fails a target whose one-sided 95% upper bound is below 0 (point estimate ≥ 0 under 3 queries) |
| holdout | holdout | ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates); no exact-code regression |
| cutoff (`--change-kind cutoff`) | dev screen, holdout governs | correct-empty gain ≥ 0.25 and answerable ΔnDCG@10 ≥ −0.01, over ≥ 3 no-answer queries; every candidate list must be the baseline's or a prefix of it with the same status (`CutoffError`) |
| no-loss | dev only | ΔnDCG@10 ≥ 0 (point estimate); `--exempt <file>` leaves listed ids out of that one figure |
| answerable-floor | dev only | answerable ΔnDCG@10 ≥ −0.01 |
| compliance | dev and holdout | below |
| test-set | test | BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, against `eval-v0` |

- **Exact-code regression:** a `code-exact` query whose relevant rank-1 result gets a lower
  grade or disappears. An equal-grade swap is not one. It applies on dev too, because the holdout
  has a single exact-code query and dev has five.
- **The tripwire passes a target that did not move:** when every query of a target shape has
  ΔnDCG@10 exactly 0, nothing regressed. A shape whose queries all moved by the same non-zero
  amount stays degenerate and fails. The tripwire exists to catch a confident regression on a
  declared target, and "nothing changed" is not one.
- **Dev-only kinds** (`no-loss`, `answerable-floor`) are refused on an encrypted set before any
  look (`GateRuleError`).
- **Cutoff is checked, not declared.** The cutoff rule is looser than the Δ rules, so a
  candidate that also pushed relevant documents down would pass it; `assertTruncation` refuses
  any candidate that reorders or adds. On an encrypted set it is taken on stored runs.
- Per-change gates are screening. False-positive control for the overall claim rests on the
  sealed test set, evaluated once.

## Pinned baselines (`eval/lib/baseline.mjs`)
- **The test-set baseline** (`PINNED_BASELINE`) is `eval-v0` = 5c5cce4, the first hybrid
  version, and never moves.
- **The shipped-ranker pin** (`SHIPPED_BASELINE`, a ref and a full sha) is the baseline of every
  per-change holdout look. It moves only in the PR that ships a ranking change, and that PR
  appends a line to "Shipped-ranker pin" below; `test/eval/baseline.node.test.js` fails unless
  the constant equals the last line.
- A baseline run must record that ref and sha (the ref must still resolve to it), a clean ranker
  and runner, the commit's ranker `treeHash`, the queries' filters (`config.filters === true`),
  the study map and hybrid mode (`BaselineError`). The ledger's `baseline ranker` column records
  the baseline run's sha.

## No-look routes
Some changes can't be measured by a relevance look, or are fully checked without one. Each route
below is a pre-registered rule; none reads the holdout beyond a count, so none spends a look.
`eval/count-log.md`'s `route` column names the route a row was taken for (`eval:count --route`,
or `eval:representatives --route`, which writes one row on a pass), and the ranking lock (ADR
0013) cites such a row as a ranking change's evidence. A route row says the custodian, or the
open-set check, ran under that route's rule; whether every other check the rule names passed
stays with the PR's evidence.

- **The routes:** `representative-only` (which group member stands for a group),
  `answerable-floor` (the no-match answer), `group-first` (the duplicate collapse),
  `gated-without-a-look` (exchange-mode correctness). `eval/lib/count-log.mjs` `NO_LOOK_ROUTES`
  holds the same four; `test/eval/lock.node.test.js` ties the list to this line.
- **group-first: the duplicate collapse.** The eval scores only a group's first member, so a
  look could not fail a collapse. It passes iff the collapsed list equals the group-first
  projection of the uncollapsed list on dev and the fixture, fetched deep enough to fill the page,
  and `no-loss` holds on dev.
- **answerable-floor: the no-match answer** (a query with no signal answers no results). It
  passes iff the query suite is green, ≥ 90% of the gibberish set's gate half returns `count: 0`
  (τ is derived on the other half), no dev query outside the no-answer tags is answered
  `no-signal`, `answerable-floor` holds on dev, and the custodian's
  `eval:count --holdout --emptied-untagged` of the stored candidate is 0.
- **gated-without-a-look: exchange-mode correctness.** Exchange mode removes courses a student
  can't take, by design. The judges graded relevance and never saw NG semesters or restrictions,
  so a relevance look would score correct removals as loss. Three gates decide instead:
  1. the oracle and path tests (`test/oracle/oracle.node.test.js`, `test/oracle/paths.test.js`,
     the `oracle` CI job): `src/eligibility.js` agrees with an independent oracle on every module
     × semester × study level, and every search path shows exactly the oracle's open ∪ note set;
  2. per-list identity on dev (`test/oracle/identity.test.js`): each internal list of every dev
     query, run with the allow-mask bit ignored at full depth (the test-only `ORACLE_TRACE`,
     honoured only with `TEST_MIGRATIONS` bound; `npm run deploy` refuses any var but
     `DENSE_BACKEND`), projected by the oracle and cut at the pipeline's depth, equals the
     filtered list, and the page equals the fusion of the filtered lists;
  3. the unfiltered guard: dev with `ng` stripped (`--strip ng`), dev `--unfiltered` and the
     fixture with `ng` stripped give byte-identical results to the shipped ranker's.
- **representative-only: which member stands for a group.** A change that alters only which
  member of a duplicate group is shown, never which groups or their order, passes iff:
  1. on dev (filtered, `--strip ng`, `--unfiltered`) and the fixture (`--strip ng`), every list
     has the pin's status and sequence of group keys, and every code that differs shows a member
     offered in the semester the request named where the pin's was not
     (`npm run eval:representatives`);
  2. `no-loss` holds on dev;
  3. `npm run test:oracle` and `npm run test:full` are green;
  4. the custodian's `eval:count -- --holdout --lists-differing --by-group` is 0.

  A look would grade the swapped-in member as it graded the one it replaced (members share their
  text, and judges never see timetables), so it would measure judging noise, not the change.
- **A ranking-neutral change** needs no route: the lock shows no list moved (ADR 0013). When the
  shipped pin moves for one, the custodian's `eval:count --lists-differing` of the holdout lists
  against the previous pin is 0.

**Study levels.** Exchange mode needs `study`. The runner adds it to every `ng` query from
`eval/study-map.json` by persona, so the locked query files never change; it throws on an `ng`
query whose persona is unmapped and records the map's sha256 in each run.

## The compliance rule (parsed constraint phrases)
A phrase such as *no final exam* removes results by design, and the judges never see the
constraint fields, so a relevance-only look scores intended removals as loss. A change to the
constraint phrases is gated by `--change-kind compliance` (`eval/lib/compliance.mjs`,
`complianceGate`), on dev and on the holdout, never the test set. On an encrypted set it runs
only through `eval:report` on stored runs.

- **The frozen reference parse** decides each query's constraints for scoring, independent of
  the candidate: pass A of the parser at tag `parse-reference` = `fbfae1012af3556a49b67ac4bec1bee88d863b8f`,
  over the vocabulary its own builder makes from the run corpus, with prerequisite semantics
  (ii) (no prerequisite, or cohort-only). The verdict refuses (`ReferenceParseError`) when the
  tag no longer resolves to that commit or the reference parses no query of the set.
- **The candidate's parse** is what its Worker echoed (`intents` in the run file). Any
  difference from the reference throws `ParseMismatchError` before the ledger row is written, so
  a mismatch spends no look. A run without `intents` is refused.
- **Constraint fields** come from the pinned snapshot normalised by the candidate's own code;
  the runner records a digest of every module's fields, and a verdict whose source gives other
  fields or text throws `CorpusMismatchError` before the ledger row.
- **Filtered qrels.** A query is constrained when the reference parses a phrase in it or it is
  an exchange-mode query. A judged document counts as relevant only if it satisfies every
  constraint of its query (including the allow bit); otherwise its grade becomes 0, in DCG and
  IDCG alike. Candidate and pin are scored on the same filtered qrels. This is also how
  exchange-mode removals are scored in any future look.
- **Pass iff:** primary ΔnDCG@10 and ΔP@5 ≥ 0 on the filtered qrels; the constraint block's
  ΔnDCG@10 ≥ 0 (a block with no scored query is a recorded vacuous pass); no exact-code
  regression on the raw qrels; every result shown for a parsed query satisfies its constraints;
  every unparsed query's top 10 equals the pin's; no new errors, in total and per query.
- **Output** on the holdout: the verdict line, the primary Δs with intervals, the block's Δ and
  the counts (scored, unscored, parsed). Never an id, a query or which check failed.
- **The dev screen** (`npm run eval:phrases -- screen`) runs the same rule with per-query detail
  first; the holdout verdict is taken only if it passes. `npm run eval:phrases -- list` lists every
  dev query the reference parses; `test/full/compliance.node.test.js` pins that list (10 queries:
  prerequisites d-011, d-023, d-048, d-080, d-099; no exam d-024, d-037, d-049, d-050, d-081).
- **Accepted risk.** No one checks the reference parse on the holdout, so a phrase it misread
  there would remove relevant documents from both lists unseen. The dev hand-check and the query
  suite bound it. A parse-mismatch refusal costs no look and reveals only its class.

## The eval's pinned NG files
The eval stays on the pinned 2026/27 corpus, because its qrels were judged on it. It normalises
that corpus with byte-identical copies of that year's NG list and restrictions in `eval/pinned/`,
never the live `data/` files, so a Registrar revision moves neither the eval nor the ranking
lock. `test/eval/pinned-ng.node.test.js` ties both files to these hashes:
- pinned NG list sha256 `092d021db4ccff2ea45e75bfc073623fa502aace082a8d5bd627f41d79c3f169`
  (`eval/pinned/ng-courses-2026-2027.json`, the qrels' `ngSha256`)
- pinned NG restrictions sha256 `eb3462ef4e2ef5524f04d9148ff7c6d5d03125353918f369f38e785231fd3132`
  (`eval/pinned/ng-restrictions-2026-2027.json`)

A run records both sha256s; a report checks the list against the qrels and the restrictions
against the pinned copy. The copies change only with a new eval corpus, which needs new qrels and
a new record here.

## Replica fidelity
A run is an offline replica: the actual Worker in workerd over local D1 with the pinned corpus,
committed query vectors and no Cloudflare call. It is not production. A pre-registered live check
of the replica against production found the lexical half identical up to FTS5 tie order, and the
dense half slightly noisier in production (mean overlap@10 8.40 against a modelled 8.47–9.93),
because Workers AI is not bit-deterministic across batches. Gating proceeds on the replica:
- every gate compares candidate and baseline on the same replica, so the difference does not
  bias Δ; it limits how well absolute numbers describe production;
- dense-only rank differences of 1–2 items in a top 10 are below the eval's resolution;
- reported numbers are labelled as the offline replica.

## Other choices
- **Query embeddings.** The ranker embeds the canonical query (trimmed, whitespace collapsed,
  ASCII lowercased); the eval embeds both the raw text (for `eval-v0`) and the canonical text. Any
  `degraded` response fails its query.
- **Prerequisites are hidden from judges.** An exchange student judges a course by its
  description, and a prerequisite line invites judges to grade eligibility, which no query asks
  about. Revisit if a query shape about eligibility is added.
- **Dev minimums.** The 10-query floor is overall; the comparison that decides a verdict has its
  own floor of 3 (cutoff no-answer queries, target-shape queries), because dev has few of each.
- **The tripwire covers target shapes only. MRR is MRR@10. One ledger serves holdout and test,**
  with a set column.
- **Query-suite custody.** No holdout text enters the query suite: the custodian runs the
  code-overlap rule and a cosine ≥ 0.9 check of every suite query against the holdout
  (`node eval/suite-custody.mjs --custodian`), which prints only the hit count and ids.

## Shipped-ranker pin
The baseline of per-change holdout looks (`SHIPPED_BASELINE`, `eval/lib/baseline.mjs`). The
last line is the current pin; a PR that ships a ranking change appends one line, with the ranker
it ships, in the same PR as the constant. A pin line is written after the merge, so it is never
ranking-lock evidence.
- shipped pin: `eval-v0` 5c5cce441bd33c8f66bb2857e4d7f5584cbc20ed (the first hybrid version)
- shipped pin: `8adb476c3f51e7a2e67dc39b02aa96ff918cf362` 8adb476c3f51e7a2e67dc39b02aa96ff918cf362 (in-Worker exact vectors, version `343ea371`; identical lists to `eval-v0` on dev)
- shipped pin: `42c25b11db3a7fa818a17933a175f644d39fada6` 42c25b11db3a7fa818a17933a175f644d39fada6 (embedding text v1, version `8d1b85be`; holdout look 1, pass)
- shipped pin: `a1867ea42dff6026f3971919f30f830e43a43bda` a1867ea42dff6026f3971919f30f830e43a43bda (codes, partial codes and GE pillars, version `8e743876`; holdout look 2, pass)
- shipped pin: `91f11b979c71a31ae7122bb318896b7f383fbdbf` 91f11b979c71a31ae7122bb318896b7f383fbdbf (typo correction and prefix terms, version `c402a75d`; holdout look 3, pass)
- shipped pin: `06413886fbbfda5190d2e84dd5dbc6599549c325` 06413886fbbfda5190d2e84dd5dbc6599549c325 (the duplicate collapse with variants, version `6e832483`; group-first route)
- shipped pin: `b7650f6d47a65e274ac3b595a2a79ae8bd19840a` b7650f6d47a65e274ac3b595a2a79ae8bd19840a (the no-signal answer at τ `max`, version `f638992b`; answerable-floor route)
- shipped pin: `1ad4086d3fb30f94e082c0586641688ef4a6645b` 1ad4086d3fb30f94e082c0586641688ef4a6645b (the intent fields, version `0173bddf`; ranking-neutral)
- shipped pin: `4041c332e63318efdcdafa1f5cbdacfd5ecf8c7d` 4041c332e63318efdcdafa1f5cbdacfd5ecf8c7d (the explicit exam, S/U, workload and prerequisite params, version `ea066ead`; ranking-neutral with no param set)
- shipped pin: `610e734712731609c7a7f1c6d8e83669dcebde8f` 610e734712731609c7a7f1c6d8e83669dcebde8f (exchange mode by semester and year of study, version `efd3dc25`; gated-without-a-look route)
- shipped pin: `072b208617148444c762d75a97008f380ba8d735` 072b208617148444c762d75a97008f380ba8d735 (exam dates and the `/module` detail fields, version `b9f7e0e4`; ranking-neutral, holdout count 0)
- shipped pin: `f64ccecbc7c38119cae19bff4a8130a0ffd32530` f64ccecbc7c38119cae19bff4a8130a0ffd32530 (the page and its `/search` and `/module` fields, version `810c903b`; ranking-neutral, holdout count 0)
- shipped pin: `04a118a2c6f305cffcca059668c31662c85a439f` 04a118a2c6f305cffcca059668c31662c85a439f (the semester representative, version `91c09381`; representative-only route, by-group holdout count 0)
- shipped pin: `6c1ed1cbc81fb06d2927395f09683397a5d972ce` 6c1ed1cbc81fb06d2927395f09683397a5d972ce (parsed constraint phrases, version `78a2672a`; holdout look 8 under the compliance rule, pass)
- shipped pin: `669fe7f69f4587b294b5389894a3cd49e5263de7` 669fe7f69f4587b294b5389894a3cd49e5263de7 (the year-of-study note and page fixes, version `0b81c82e`; ranking-neutral, holdout count 0)
- shipped pin: `8e24b21ddfcacc5cc67edf4a7cd07c41aaa5a690` 8e24b21ddfcacc5cc67edf4a7cd07c41aaa5a690 (the shortlist and export, with `ng-unscheduled.json`, version `f8aefeab`; ranking-neutral, holdout count 0)
- shipped pin: `b75ac19016a2073e77d37c2c44485c9a5d8c99a2` b75ac19016a2073e77d37c2c44485c9a5d8c99a2 (the level-4000 note and shortlist wording, version `b0834844`; ranking-neutral, holdout count 0)

## In the code
Constraints the code keeps that a tidy-up would break.

**Looks and the ledger**
- `eval/cli.mjs` `fail()` calls `process.exit`, so it serves only checks that run before the
  ledger lock is taken (`changeOf`, `assertRunSlotFree`). Code under the lock throws instead
  (`assertGateable` throws `RunFileError`), so `withLedgerLock`'s `finally` releases the lock. A
  `process.exit` under the lock leaves a lock file that refuses every look until it is 30
  minutes old.
- `cmdRun` runs every check that can refuse a holdout run (the key, a free run slot,
  `precheckCorpus`: a hybrid baseline at the pin on the qrels' corpus, judged qrels, groups for
  that corpus, every ciphertext against its manifest) before `reserveLook`. A reserved row
  counts even when the run aborts, so a check moved after it spends a look on a refusal.
- `eval/lib/ledger.mjs` counts looks so a hand edit can only add to them: every table row but
  the header and separators counts, a row whose set cell names no known set counts against every
  set, and a look is refused when any known set has fewer looks than at `HEAD` or `origin/main`
  (so moving a row to another set is caught). `finaliseLook` appends the final row when its
  reserved row is gone, so deleting a reserved row never uncounts a look.
- `withLedgerLock` is an `O_EXCL` lock file holding a random token. The holder calls
  `assertHeld()` directly before each synchronous append and removes the lock only while its
  token is still there; a lock older than 30 minutes is broken only under a second
  `<ledger>.lock.break` lock, so two processes that saw the same stale lock can't have one delete
  the lock the other just took. Loosening either step lets two parallel looks both pass the limit.
- A run's slot is taken when `MANIFEST.json` lists it, not when its ciphertext exists
  (`assertRunSlotFree`), so deleting the file never frees it. Writing a run, and `eval:embed`
  writing a query cache (`recordInManifest`), adds only that file's entry and re-hashes no other,
  so a tampered ciphertext stays flagged by `eval:verify` instead of being blessed by the next
  write.
- Stored runs can't be rewritten without a retire, so the readers accept fields older runs lack:
  no `config.mode` is hybrid (`assertGateable`), and no `corpus.ngRestrictionsSha256` is skipped
  by `assertComparable`'s restrictions check. Making them required refuses committed holdout runs.
- `eval:count --lists-differing` (`eval/count.mjs`) refuses two runs whose `config` differs: a
  filtered run against an unfiltered one, or hybrid against lexical, counts the settings, not
  the ranker, and a wrong count would block (or hide) a pin move.

**Keeping holdout text out of the terminal**
- Retrieval for an encrypted set runs in a forked child (`eval/runner/vitest-child.mjs`) whose
  stdout and stderr `runInChild` in `eval/runner/run.mjs` discards, because workerd prints a
  Worker's uncaught exceptions itself and no in-process setting stops it. The child's failure
  message can carry query text, so only plain sets show it.
- `--embed-missing` is opt-in and refused in CI, so a run never calls Workers AI unasked (ADR
  0004). It embeds the missing texts with `scripts/embed.mjs` and reruns once; on an encrypted
  set that child's output is discarded (stack traces and Workers AI error bodies can carry query
  text) and its failure throws `EmbeddingError`, so the reserved look is aborted and only the
  class prints. `eval:embed --corrected-from-ref` likewise logs counts, never a text.
- Error messages are written to be safe if printed, though an encrypted set prints only the
  class: the compliance errors (`ParseMismatchError`, `ConstraintFieldsError` and the rest) name
  counts; `gradeOf` in `eval/lib/metrics.mjs` names a bad grade by value only, never the judgment
  (it can carry a rationale) or the query; `eval/lib/judging.mjs` names item ids only, never a
  key a judge wrote. `eval/judge.mjs` prints a `UsageError` in full even on an encrypted set,
  because usage messages name only flags and paths; one that interpolates a query id, text or
  rationale leaks through that exception.
- `scripts/holdout.mjs` takes the set name for the AAD from `--set`, which defaults to `holdout`
  under `eval/holdout` and `test` under `eval/sealed` and is required anywhere else, so a
  ciphertext can't be decrypted or verified as another set. `eval/lib/sets.mjs` binds custody to
  set names, not directories: the `selftest` set alone keeps its ledger beside its files, and its
  ciphertexts carry `selftest` in their AAD, so real holdout files can't be read through it to
  dodge the real ledger.
- `assertInManifest` in `eval/lib/crypto.mjs` hashes the bytes the caller already read, so the
  ciphertext checked is the one decrypted; re-reading the file opens a swap window.
  `verifyManifest` skips macOS Finder files (`.DS_Store`, `._*`), which are git-ignored and can't
  be committed; any other unlisted file still fails.
- A plaintext set directory with a `MANIFEST.json` (a pinned diagnostic set) has its queries and
  qrels checked against it on every read; `eval/dev` has none.

**Scoring**
- `scoreRun` in `eval/lib/metrics.mjs` takes a document that breaks its query's hard
  constraints out of its duplicate group for that query. Groups ignore level, semester, NG,
  credits and faculty, so without this a member graded 0 by rule takes its group's slot and
  hides a relevant sibling's gain.
- The compliance rule (`eval/lib/compliance.mjs`) mirrors `/search` instead of re-deriving it:
  `failedConstraint` reads `exam=0` with a semester as "no exam in that semester", as
  `src/search.js` does; an exchange-mode query in a special term, where `ngBit` throws, gets
  bit 0, as `/search` refuses it; and `candidateParse` passes the echoed values through unnormalised, so an
  unexpected value is a parse mismatch, not forgiven. A candidate error where the baseline
  answered 200 fails the rule per query, since the error also hides its parse from the mismatch
  check.
- Every "point estimate ≥ 0" in `eval/lib/gate.mjs` compares against `-EPS` (1e-12), so
  summation noise in a Δ that is really 0 can't fail a verdict. In `bcaInterval`
  (`eval/lib/stats.mjs`), resampled means within a relative 1e-12 of the estimate count half
  toward z0, so a discrete bootstrap distribution (nDCG deltas over few queries) isn't pushed to
  one side.
- `serialiseGroups` in `eval/lib/groups.mjs` writes one group per line for readable diffs; the
  file's bytes are the groups-v1 hash above, so any serialiser change, whitespace included, needs
  a new groups version.
- The run file (`eval/runner/reporter.mjs`) keeps each query's echoed parse under `intents`,
  outside `results`, because the ranking-identity checks (the lock, `--lists-differing`, the
  compliance identity check) hash `results`; there a parse-only change would read as a ranking
  change.

**The runner and its workspace**
- `eval/runner/harness.js` is overlaid onto every ranker the eval runs, `eval-v0` included, so
  it uses only what every ranker has: the default export's `fetch` and `/admin/ingest`
  (`test/eval/workspace.node.test.js` checks its imports). Each `/search` goes through the
  Worker's `caches.default` as in production; the lookup AI and fake Vectorize make a hit's body identical
  to a miss's.
- The test Worker config (`test/wrangler.test.jsonc`) is part of the ranker (`HASHED` in
  `eval/lib/workspace.mjs`): a run takes it from the ref when the ref has one, so an old ranker
  runs under its own compatibility date and flags, and a config change moves `ranker.treeHash`.
- `writeBundle` in `eval/runner/run.mjs` gives a ranker that has `src/vector-bundle.js` a vector
  bundle built from the run's corpus by that ranker's own encoder; an older ranker keeps the fake
  Vectorize, which does the same exact cosine with an id tiebreak, so a Δ between them measures
  the ranker, not the index.
- `vitest.eval.config.mjs` aliases the vocabulary, groups and bundle to the workspace's copies,
  which `eval/lib/corrected.mjs` rebuilds from the run's corpus, never the repo's `data/`, so no
  ranker is scored against production vocabulary. The NG-unscheduled file is the workspace's
  committed copy, because only the no-match answer reads it. `rankerIntentParser` there sets
  `isOffered: () => false`, so it pins no code: its callers read only the dense text, the
  corrected text and the constraints.
- `eval/lib/embeddings.mjs` hands vectors to workerd as one base64 Float32 string plus keys in
  row order (`packLookup`), because nested arrays crash the Vitest pool's provide/inject
  transport; `base64ToF32` copies the decoded Buffer, because a pooled Buffer can sit at an
  offset a `Float32Array` can't align to.
- `queryTextForms` (`eval/lib/query-forms.mjs`) returns both query forms ("Other choices"), and
  every set's cache holds both, because a query vector missing mid-run trips the dense circuit
  (`src/upstream.js`, three failures) and hides later misses instead of failing the run.
  `test/eval/query-forms.test.js` runs it in workerd beside the Worker's own parser, so the
  module has no imports.
- `eval:embed --corpus` takes the embedding text from the `--ref` workspace's `scripts/lib.mjs`,
  so the corpus vectors match the ranker they are pinned for.

**Rule data, candidates and the open sets**
- The rule lists the Worker reads (`eval/query-rules/cohort-only-prereq.json`, the constraint
  phrases) are copied into `data/` by `scripts/build-catalogue-data.mjs`, because neither the
  Worker nor a run's workspace reads `eval/`; `test/intents-data.node.test.js` holds the copies
  and the two readings (`src/cohort-only.js`, `eval/query-rules/cohort-only.mjs`) equal.
- `STOPWORDS_V2` in `src/fts-query.js` (the current list plus catalogue words such as `course`,
  `module`, `nus`) is a pre-registered candidate, screened alone under the general rule and put
  in force only if it passes dev alone. Each list equals its `eval/query-rules/stopwords.json`
  entry (`test/stopwords.node.test.js`).
- `scripts/no-signal-cosines.mjs` derives the τ candidates from the gibberish set's derivation
  half and the dev tags only, never labels, with committed embeddings and the product's own
  parse, so it makes no remote call and is no look. The gibberish set holds at least 40 strings,
  split by the seed in `eval/gibberish-split.mjs` into halves of at least 20;
  `test/query-suite/gibberish.node.test.js` requires the split to reproduce, so τ is never checked
  on the strings that tuned it.
- The query suite carries dev text only in the four items of `ALLOWED_DEV`
  (`test/query-suite/suite-files.node.mjs`), verbatim and in their rows; every other suite or
  gibberish text is held off dev by the token rule and query-embedding cosine ≥ 0.9, so the
  suite measures understanding, not dev memorisation. `needs-embedding.txt` lists every text
  exactly, so `embeddings.json` covers each form. `test/query-suite/suite.node.test.js` pins
  `queries.json` by `SUITE_SHA256`, so an edit to the acceptance set shows in the PR that makes
  it.
- The Worker tests (`test/regressions/` and neighbours) run the fixture with a hash embedder, so
  they check query handling, filtering and exchange mode, never ranking quality; an asserted
  ranked order there pins the fake embedder.

**Tests of custody**
- Tests that take looks or counts never touch the real `eval/holdout-ledger.md`,
  `eval/count-log.md` or a real holdout file: they build sets from dev-derived data with a
  throwaway key, `selftest` keeps its ledger and count log in its own directory, and test-set
  looks run in a temporary clone (`test/eval/clone.node.mjs`) whose empty ledger is committed at
  its `HEAD` and `origin/main`, with this checkout's working-tree `eval/` and `scripts/` copied in.
  Look limits and the tamper check never depend on this checkout's looks.
- `test/eval/pins.node.mjs` takes both pins from this record's text, the shipped pin from the
  last `- shipped pin:` line, and builds tree hashes with its own `git archive`, never from
  `eval/lib`, so a bug in the pin code can't agree with itself, and a ship needs no test edit.
