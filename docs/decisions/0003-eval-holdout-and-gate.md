# 0003 — Eval query sets, holdout custody and the pre-committed gate

Status: accepted (Phase 2), written before any Phase 3 change. The SC5 reading below was
signed off by Jacob on 2026-11-06.

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
| dev | `eval/dev/queries.json` (plaintext) | 98 | tuning, open, full per-query output |
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
  planned), version `v2`.
- **Amendment v2.1** (`eval/v2/amend-v2.1.mjs`, PR #10 review), applied before any look:
  - every code query also carries its form as a shape (`code-exact`, `code-space`,
    `code-partial`, `code-nonexistent`), so the exact-code check sees `code-exact`;
  - non-existent-code queries carry `noAnswerByRule: true`, so a judge's grade cannot make them
    answerable;
  - a "typo" query with no word of 4+ letters to edit was a copy of its source and is dropped
    (dev `d-098`; none in the holdout): dev 98 / holdout 81;
  - the holdout's 7 code queries are redrawn, same forms, from a secret seed held in custody
    (`code-seed.v2.1`). The v2 picks came from the committed seed, the committed NG list and the
    released corpus, so anyone could rebuild them. A drawn target may not overlap, as a prefix
    either way, any v2 code pick, any code example persona writers saw (`CS3244`, `CS32`,
    `GEA`) or another draw, so it is never a variant of, or under the prefix of, a dev query's
    target. The partial query is drawn as a code family, not a GE pillar: only six pillars
    exist and three are public, so a pillar could be guessed. Holdout code forms: 1 exact,
    2 space, 1 partial (a family), 3 non-existent.
- **Locks** (v2.1).
  - dev plaintext sha256 `fe7a248f9de3de04ef41af723c8ffd274805c283c8be3c002de026e75bb742ce`.
  - holdout plaintext sha256 `685881afb719558de8f3988af477832c6d050382bd8e4885203139a4f9db946a`
    (verified on decrypting the committed ciphertext).
  - holdout ciphertext sha256 `d7b6af869b8491588622fc27e2a8b13917bf51562a5a6c3d1d1eaf1c4c37e079`,
    recorded in `eval/holdout/MANIFEST.json`.
  - v2, before the amendment: dev `cf33e601…bc3b4`, holdout plaintext `8f653595…f7bdb4`.
  - `test/eval/lock.node.test.js` fails unless the dev file and the holdout ciphertext match the
    hashes above, so changing a set means changing this ADR in the same PR. CI
    (`npm run eval:verify`) fails if a ciphertext differs from the manifest or if any file other
    than `*.enc` and `MANIFEST.json` sits in an encrypted-set directory (`.gitignore` also keeps
    plaintext there out of git). Qrels, query embeddings, run files and judge outputs join the
    manifest as they are made.
- **Test set, pre-registered now.** The sealed test set is written after Phase 3 freezes. It uses
  the same writer prompt, personas and shape-assignment procedure, with fresh writer runs and a
  new seed recorded when it is drawn. Its code queries are drawn from a secret seed held in
  custody (only its sha256 is recorded), with the v2.1 overlap rule against every dev and
  holdout code target and the writer examples, partials as code families, and carry the v2.1
  form shapes and `noAnswerByRule`; typo sources need a word
  of 4+ letters. It is pooled from v0 plus the final ranker and judged under the same protocol.
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
    12) and `test` (max 1), the rule applied and the baseline's ranker sha (amendment
    2026-11-04).
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
| dev (screen) | no exact-code regression (v2.1: the holdout has only one exact-code query, dev has five; a regression is a `code-exact` query whose relevant rank-1 result gets a lower grade or disappears, not an equal-grade swap); and ΔnDCG@10 BCa 95% lower bound > 0; **or**, for a change declaring target shapes, every target's ΔnDCG@10 > 0, overall ΔnDCG@10 ≥ 0, and ≥ 3 distinct answerable queries across the targets. Tripwire on target shapes only: a target whose one-sided 95% upper bound on ΔnDCG@10 is below 0 fails it; with < 3 queries the tripwire uses the point estimate ≥ 0. |
| holdout | ΔnDCG@10 ≥ 0 and ΔP@5 ≥ 0 (point estimates); no exact-code regression: no `code-exact` query's rank-1 result gets a lower grade (or disappears). |
| cutoff change (dev screen, holdout governs) | replaces the Δ rules: correct-empty gain ≥ 0.25, answerable ΔnDCG@10 ≥ −0.01, ≥ 3 no-answer queries. |
| test (SC5) | BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0, final shipped ranker vs `eval-v0` (= 7ac9841, the production ranker), same pinned corpus `data-2026-2027-20260904`. |

Per-change gates are screening. False-positive control for the shipping claim rests on the
sealed test set, evaluated once.

## Replica fidelity (Phase 2c, lead decision)
The pre-registered live check (`docs/evidence/phase2/fidelity.md`) **failed**. The lexical half of
the offline `eval-v0` replica matches production exactly on all 15 queries up to FTS5 tie order,
shown by a direct `mode=lexical&topK=50` comparison (the hybrid-score decomposition alone could
not prove it). But 2 of 15 queries fall one item below their modelled dense-noise envelope (overlap@10
8 vs 9, 7 vs 8). Mean overlap@10 is 8.40, just under the modelled 8.47–9.93: production's dense
half is a little noisier than the replica (Vectorize is approximate, the fake is exact; production
corpus vectors come from unknown ingest batches).

Decision: gating proceeds on the replica, with this limitation stated wherever results are
reported.
- Every gate compares candidate and baseline on the **same** replica, so a replica-vs-production
  dense difference does not bias Δ; it affects how well absolute numbers describe production.
- Dense-only rank differences of 1–2 items in a query's top-10 are below the eval's resolution.
- Reported baselines and SC5 numbers are labelled "offline replica (exact dense search)".
- Re-check after the Phase 1 forced re-ingest, when production's corpus vectors are re-embedded:
  a second 15-call fidelity check against the then-deployed ranker's replica.

This departs from the pre-registered rule ("no gating until investigated"): the investigation is
the analysis above; the residual cause (ANN vs exact search, batch noise) cannot be reproduced
offline within the plan's quotas.

## SC5 reading (Jacob, 2026-11-06)
"The held-out set" in SC5 means the **sealed test set**, written after Phase 3 freezes and
looked at once. Jacob chose it before any holdout look. The holdout is not reported for SC5:
reporting final against v0 on it would print a verdict, which is a look, and none is budgeted.
So the plan's L12 is unused under this reading, and all 5 spare holdout looks stay available
for retries (`docs/plans/phase3.md` §3 and §5).

## Deviations from the plan
- **Encryption.** AES-256-GCM with a hex key file instead of `age`. The key is not in the macOS
  keychain and not a GitHub secret (Final §3: no CI secret). CI checks only ciphertext hashes.
- **Split clustering.** TF-IDF similarity instead of embedding similarity. The embedding tool
  did not exist when the split was made.
- **Dev minimums.** The 10-query floor is overall. The floors on the comparison that decides a
  verdict are 3 for cutoff no-answer queries and 3 for target-shape queries, because dev has 5
  `noanswer` queries and some shapes only 2 (PR #6 review round 2).
- **Exact-code check on dev.** The plan applies it to the holdout only; v2.1 adds it to the dev
  screen, because the holdout has a single exact-code query.
- **Query embeddings.** Since PR #7 the ranker embeds the canonical query, which is trimmed, has
  whitespace collapsed and ASCII letters lowercased. The eval embeds both the raw text (for
  `eval-v0`) and the canonical text. Any `degraded` response fails its query.
- **Prerequisites hidden from judges** (lead decision, PR #15). Plan §3 lists prereqs among the
  judge fields; `eval/JUDGING.md` omits them. An incoming exchange student judges a module from
  its description and is not bound by NUS prerequisite chains in the same way, and a prereq line
  invites judges to grade eligibility, which no query asks about. Revisit if a query shape about
  eligibility is added.

## Amendment 2026-11-04: gate and custody refusals (Phase 2 exit red-team)
Made before the first holdout look. The red-team found three ways to get a verdict the rules
above do not allow; each is now refused mechanically, before a look is reserved or appended.
- **Cutoff rule.** The cutoff rule replaces the Δ rules only for a change that is a cutoff. The
  CLI used to take `--change-kind cutoff` on the operator's word, so a candidate that emptied
  no-answer results and also pushed relevant documents down passed on the holdout where the
  general rule failed it. A cutoff candidate's result list must now be, for every query, the
  baseline's or a prefix of it, with the same status (`assertTruncation`, `CutoffError`). On an
  encrypted set the candidate is checked as a stored run (`--store-only`, then
  `eval:report --change-kind cutoff`), since `npm run eval` reserves its look before retrieval.
  Every verdict prints the rule it applied (`general`, `targeted: <shapes>`, `cutoff`, `sc5`),
  and the ledger records it in a `rule` column.
- **Pinned baseline.** Holdout and SC5 verdicts refuse a baseline that is not `eval-v0` =
  7ac9841 (`eval/lib/baseline.mjs`, `BaselineError`): the tag must still resolve to that commit,
  and the run file must record ref `eval-v0`, that sha, a clean tree and that commit's ranker
  `treeHash`. The ledger records the baseline's ranker sha in a `baseline ranker` column.
  Moving the holdout baseline to a later shipped ranker means changing the pin and this ADR in
  the same PR. A stored encrypted run the manifest lists is never overwritten (by
  `--store-only` or a look). Replacing one is `node eval/cli.mjs retire-run --reason …`, logged
  with the retired ciphertext's sha256 in `eval/retired-runs.md`. Writing a run adds only that
  file to the manifest instead of re-hashing every ciphertext, so the overwrite no longer makes
  `eval:verify` pass.
- **Manifest on read.** A `--set-dir` of ciphertexts the manifest never checked could be scored,
  so two directories differing only in qrels grades gave FAIL and then PASS, both counted. Every
  ciphertext a verdict reads must now match the set directory's `MANIFEST.json` (the
  `eval:verify` check, on the bytes decrypted; `ManifestError`); a set directory with no
  manifest is refused.

## Amendment 2026-11-06: Phase 3 gate rules (P-5, P-5b)
Made before the first holdout look, for the Phase 3 plan (`docs/plans/phase3.md` §3 P-5 and
P-5b, §9). Each rule is in the code and tested.
- **The no-answer set is tagged and unanswered** (A-1, C-3, A2-2, A2-11; lead decision on PR
  #34). For any change, a query is no-answer iff it is tagged `noanswer` or `code-nonexistent`,
  or carries `noAnswerByRule` (`isTaggedNoAnswer`, `eval/lib/metrics.mjs`), **and** no judged
  document has grade ≥ 1. The judges' grades are the ground truth: the tag is necessary, not
  sufficient. A tagged query with a grade-≥1 document is answerable (primary unless it has a
  feature-gap shape), so emptying it is answerable loss.
  - An untagged query with no grade-≥1 document is **unscored**: it is in neither set and in no
    metric.
  - Reports list unscored ids on dev only. Holdout and test verdicts print the count alone
    (`unscored queries: n`).
  - On dev the primary set is unchanged: 83 queries, v0 hybrid nDCG@10 0.712, P@5 0.571, MRR@10
    0.820 (`EVAL.md`). d-013, d-051 and d-065 are tagged `noanswer` but have grade-≥1
    documents, so they stay primary. The no-answer set is d-012 and d-025, and 8 queries are
    unscored (they were no-answer before).
  - Dev's 2 no-answer queries are below the cutoff rule's floor of 3, so a cutoff verdict
    cannot pass on dev. The floor stands: no Phase 3 change takes the cutoff kind on dev (3G
    uses `answerable-floor`).
- **Change kinds `no-loss` and `answerable-floor`** (A2-2, A2-4, C3-8). Both screen on dev only.
  The CLI refuses them on an encrypted set before any look, and `gateFor` throws
  `GateRuleError` if a holdout or test verdict is asked for one.
  - `no-loss` (3F, and 3H's dev screen) replaces the dev CI rule with ΔnDCG@10 ≥ 0 as a point
    estimate.
  - `--exempt <file>` (no-loss only, dev only) names dev ids to leave out of the no-loss
    ΔnDCG@10 and its n, and nothing else: no new errors, the query floor and the exact-code
    check still run over every query. They are 3H's constraint-exempt queries, which a
    committed script computes per candidate. The report prints each exempt id with its Δ.
  - `answerable-floor` (3G) replaces it with answerable ΔnDCG@10 ≥ −0.01, over the primary
    answerable set.
  - The other dev checks still apply to both kinds: no new errors, ≥ 10 queries, judged@10 100%,
    and no exact-code regression.
- **`--gate sc5` on the holdout** (A2-2, A2-10). `eval:report --gate sc5` takes the SC5 rule (the
  test set's row of the gate table) on stored holdout runs, against the pinned baseline, and the
  ledger records rule `sc5`.
  - It is accepted only under the holdout reading of SC5. `SC5_READING` in `eval/lib/gate.mjs`
    is the reading the "SC5 reading" section above records, and `test/eval/gate.node.test.js`
    fails if the two differ.
  - The reading is the sealed test set, so `--gate sc5` is refused on the holdout before any
    look, and L12 is unused.
  - Under a holdout reading, the SC5 look is L12 and the last holdout look. `--gate sc5` is
    refused unless the ledger already holds exactly 11 holdout looks and no `sc5` row; a
    per-change holdout look is refused at 11 looks, and refused at any count once an `sc5`
    row exists.
  - `npm run eval` refuses `--gate`: an SC5 verdict is taken on stored, fully judged runs, as
    every look is (the plan's look procedure, §3).
- **Look definition: counts are not looks** (A3-1, A-N9). `npm run eval:count` (`eval/count.mjs`)
  is custodian-only (refused without `--custodian`, and on dev). It prints one integer and
  nothing else:
  - `--set test --answerable`: the sealed test set's primary answerable count, which §5's
    stopping rule reads;
  - `--holdout --emptied-untagged --run <variant>`: how many holdout queries outside the
    no-answer set the stored run returns empty, which 3G's gate reads. A tagged query with a
    grade-≥1 document is outside the set, so emptying it counts.

  Every call appends a row (date, set, kind, run, count) to `eval/count-log.md`, a separate
  committed file the ledger never reads. The ledger refuses a row copied from it
  (`LedgerTamperError`). Any other option is refused, so no flag can make it print ids or
  metrics, and an error prints only its class. **A count from `eval:count` prints no verdict
  and is not a look, even when a pre-registered gate reads it.** The look definition under
  "Custody" ("any run or report that prints a verdict for an encrypted set") stands, with this
  exception.

- **3G is gated without a look** (A-1, C-3, A2-9, A3-1, A3-2, A3-6). The no-match change passes
  iff all of these hold:
  - the SC4 suite is green with 3G in place. Items owned by a workstream that has not merged, or
    that Jacob dropped, are listed and skipped. The typo, gibberish, non-existent-code and guard
    items are never skipped;
  - ≥ 90% of the gibberish set's gate half returns `count: 0`. τ is derived on the other half;
  - no dev query outside the no-answer tags returns `noMatch.reason` `no-signal`, and the report
    lists any that does (dev is open);
  - `answerable-floor` on dev;
  - the custodian's `eval:count --holdout --emptied-untagged` of the stored candidate is 0. The
    fallback τ gets one count of its own.

  None of these is a look, so 3G spends none.
- **3F is gated without a look** (A2-4). The eval scores only a group's first member, so a
  holdout look could not fail the collapse. 3F passes iff:
  - on dev and the fixture, the collapsed list equals the group-first projection of the
    uncollapsed list, fetched deep enough to fill the page;
  - `no-loss` holds on dev;
  - the S8 finding test is green.
- **Look procedure** (A3-4). For each look the custodian:
  1. stores the candidate with `--holdout --store-only`, and the baseline too, unless it is
     already stored and fully judged;
  2. pools every run stored in step 1, encrypted (`eval:pool --holdout --custodian --unjudged`);
  3. judges the pool and merges, so judged@10 is 100% for both runs;
  4. only then takes the verdict with `npm run eval:report -- --holdout --run <candidate>
     --baseline <shipped>` on the stored runs. `report` runs no retrieval and records a look
     only for a fully judged pair, so no look is spent `unjudged`.

  `npm run eval -- --holdout` is not used for looks, because it reserves its row before
  retrieval. The ledger is committed after each look. Retries are the plan's named ones only.
  `<shipped>` is a stored run of the shipped-ranker pin (next item).
- **Two baseline pins** (A3-4; lead decision on PR #34). The 2026-11-04 pin is split in two
  (`eval/lib/baseline.mjs`):
  - **The SC5 / test-set baseline** (`PINNED_BASELINE`) stays `eval-v0` = 7ac9841 and never
    moves. The test set's verdict and `--gate sc5` compare against it.
  - **The shipped-ranker pin** (`SHIPPED_BASELINE`, a ref name and a full sha) is the baseline
    of every per-change holdout look. It starts equal to `eval-v0`. It moves only in the PR
    that ships a change, and that PR adds a line to "Shipped-ranker pin" below;
    `test/eval/baseline.node.test.js` fails unless the constant equals that section's last line.
  - A baseline run is checked against its pin as before: the ref still resolves to the pinned
    sha, and the run records that ref and sha, a clean ranker and runner, the commit's ranker
    `treeHash`, `config.filters === true` and hybrid mode (`BaselineError`). The ledger's
    `baseline ranker` column still records the baseline run's sha.
- **groups-v1 is the duplicate-group rule** (A-2, C-8) for dev, holdout, test and, from 3F, the
  product: `eval/lib/groups.mjs` over the pinned corpus, committed as `eval/groups.json` (509
  groups). It joins the locks:
  groups-v1 `eval/groups.json` sha256 `aee97d57a7201118601562bc90864dd83a386bf14f3945646abc9ac478878a22`.
  `test/eval/lock.node.test.js` fails if the file differs, so changing the groups means changing
  this ADR in the same PR.
- **SC4 custody and the test-set exclusions** (A-N1).
  - No holdout text enters the SC4 suite. The custodian runs the v2.1 code-overlap rule and the
    query-embedding cosine ≥ 0.9 check of every suite query against the holdout. The check
    prints only the hit count and the hitting suite ids, and those suite queries are replaced.
  - The SC4 suite's texts and code targets, and the gibberish set, join dev and the holdout in
    the sealed test set's exclusion list and its leak filter ("Test set, pre-registered now",
    above): a test query with cosine ≥ 0.9 to any of them, or a shared source, is dropped.

## Amendment 2026-11-07: a target that did not move passes its tripwire (Jacob, at 3B)
- **Rule:** a target-shape tripwire passes when every query of that shape has ΔnDCG@10
  exactly 0. That is a degenerate interval at 0, and no change is no regression.
  - A shape whose queries all moved by the same non-zero amount stays degenerate and fails, as
    before.
  - The fewer-than-3-queries fallback (point estimate ≥ 0) is unchanged.
  - Code: `devGate` in `eval/lib/gate.mjs`; test in `test/eval/gate.node.test.js`.
- **Why:** the tripwire exists to catch a confident regression on a declared target. The general
  guard "a CI-based check never passes on a degenerate interval" stops a degenerate interval from
  showing an improvement. Applied to the tripwire, it turned "nothing changed" into a failure.
- **Found at 3B's dev screen, before its holdout look.** 3B declared four targets. Its
  `abbreviation` queries (5) did not move at all: by design, the collision list keeps `AI`, `js`,
  `pr` and `dsa` topical. So the tripwire failed as degenerate. The overall CI route passed
  (ΔnDCG@10 +0.049 [0.017, 0.108] under `qrels-dev-v5`). The named fallback (3B without
  `stopwords-v2`) is the same ranker, so plan §3 sent the drop question to Jacob (Q4). He chose to
  amend this rule for every change, rather than screen 3B under the general rule or drop the target
  after the fact.

## Shipped-ranker pin
The baseline of per-change holdout looks (`SHIPPED_BASELINE`, `eval/lib/baseline.mjs`). The
last line is the current pin; a PR that ships a change appends one line, with the ranker it
ships, in the same PR as the constant.
- shipped pin: `eval-v0` 7ac984174ded88cb2b6497d9835b456981acdd99 (the Phase 2 baseline; nothing shipped yet)
- shipped pin: `e8a712468b2f59c4d9dcaeef2fe9680a8b8b0f7d` e8a712468b2f59c4d9dcaeef2fe9680a8b8b0f7d (3-0, in-Worker exact vectors, deployed 2026-11-06 as version `343ea371`; ranker-identical to `eval-v0` on dev)
- shipped pin: `45bd7169cd8931294057f409e7bbc2fc311599bc` 45bd7169cd8931294057f409e7bbc2fc311599bc (3A-2, embedding text v1, deployed 2026-11-07 as version `8d1b85be`; L2 pass, holdout look 1)
- shipped pin: `ad8e10caf2d8fa01c34191551a63ac5d64cdaade` ad8e10caf2d8fa01c34191551a63ac5d64cdaade (3B, codes, partial codes and GE pillars, deployed 2026-11-07 as version `8e743876`; L3 pass, holdout look 2)
- shipped pin: `89cb10e9e56b0b3035a063d544fb0b1e16fd2bf1` 89cb10e9e56b0b3035a063d544fb0b1e16fd2bf1 (3C-2, typo correction and prefix terms, deployed 2026-11-07 as version `c402a75d`; L4 pass, holdout look 3)
- shipped pin: `2ce17c66c662c3af29842f9aab7d67499ee76b12` 2ce17c66c662c3af29842f9aab7d67499ee76b12 (3F, groups-v1 collapse with variants, deployed 2026-11-07 as version `6e832483`; no look: identity with the group-first projection and dev `no-loss`, A2-4)
- shipped pin: `47838dbf414d9755e12f470ccb6b614332d765e1` 47838dbf414d9755e12f470ccb6b614332d765e1 (3G, no-signal answer at τ `max`, deployed 2026-11-07 as version `f638992b`; no look: SC4, gibberish gate half, answerable floor and custodian count 0)
- shipped pin: `f004351947cef4909072b4efc7d8782088819ebe` f004351947cef4909072b4efc7d8782088819ebe (3H-0, the intent fields, deployed 2026-11-07 as version `0173bddf`; ranking-neutral: all 98 dev lists equal `47838db`'s)
- shipped pin: `238e7210d65a9ba607f3ad0e44efb2fa15472ea7` 238e7210d65a9ba607f3ad0e44efb2fa15472ea7 (3H, the explicit exam/S-U/workload/prereq params; deployed 2026-11-07 as version `ea066ead`; ranking-neutral with no param set: all 98 dev and 81 holdout lists equal `f004351`'s)

## Interpretations confirmed by the lead
- The tripwire covers target shapes only.
- The cutoff rule screens on dev and governs on holdout.
- A look is any verdict-printing run, counting reserved, aborted and unjudged ones.
- One ledger serves holdout and test, with a set column.
- MRR is MRR@10.

## Dissent
None unresolved. The objections and their resolutions are in `docs/plans/phase2.md` (round 1 and
round 2 objection logs, Final).
