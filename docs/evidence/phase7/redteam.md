# Phase 7 red team: the ops surface

A fresh-eyes attack on what Phase 7 added (PRs #102, #103, #106, #107, #108, #109 and the commits
after them, `80b9093..0b5b1e1`). It was written to the brief "find real ways the ops surface can be
made to do harm or to lie, and prove each". Nothing here is fixed; the lead triages.

## Method

- Read the workflows (`.github/workflows/{ci,deploy,drift,findings}.yml`) and the scripts they and
  the runbook run: `deploy`, `deploy-gate`, `preflight`, `guard`, `d1-rest`, `d1-read`, `rollback`,
  `deploy-tag`, `drift`, `corpus`/`corpus-manifest`, `sources`, `year`, `run-record`,
  `remote-session`, `ci-changes`, `eval/lib/ranking-lock.mjs`, and the ingest and admin-hashes code
  they lean on.
- Every finding has a reproduction that was run. Each one is a vitest file in the repo's style under
  `test/redteam-*.test.js`. A case asserts the safe behaviour and is marked `it.fails`, so it passes
  in CI while the gap is open and fails, asking to be flipped, once the gap is fixed. Cases marked
  "(evidence)" are plain passing tests that show a supporting fact.
- Local only. There were no Cloudflare calls, no GitHub writes beyond this branch and its PR, and no
  requests to `api.nusmods.com`, the live site or `*.workers.dev`. Fixtures, fake NUSMods and GitHub
  clients, a throwaway sources key, fake documents, local D1 (the Worker test harness) and in-memory
  SQLite stand in. The only GitHub reads were public GETs: deploy runs, `main`'s protection, its
  rulesets and the fork-approval policy.
- Workflow semantics that can't run locally are marked *reasoned from docs* and cite GitHub's
  documentation.

Run them all with `npx vitest run test/redteam-*.test.js`. At `0b5b1e1` that gives 7 files, 3 passed
and 11 expected fail (also with `CI=1`). Lint, typecheck and check:findings pass.

## Personas

1. **An outside contributor with a fork**: PRs from a fork, no push access.
2. **A hostile or broken NUSMods API**: controls what `drift.yml` and `corpus fetch` read.
3. **A maintainer in a hurry**: honest, but hand-edits, hand-patches and takes the documented flags.

## Findings

| ID | Severity | Persona | One line |
|---|---|---|---|
| H-1 | high | 3 | A hand-edited `data/ng-courses-<year>.json` passes `year check --full` and the preflight's record rule |
| M-1 | medium | 3 | The deploy guard trusts D1's stored `row_hash`: rows changed under it deploy as matching |
| M-2 | medium | 2 | NUSMods module codes reach the drift issue raw: @mentions, links, HTML, and a forged hidden state |
| M-3 | medium | 3 | `assertReadOnly` accepts `SELECT $$(');UPDATE …` and the REST client sends it |
| L-1 | low | 2, 3 | `catalogue_only` has no mass-delete guard: a corpus missing it empties the table unasked |
| L-2 | low | 3 | An object-valued var makes the preflight's `vars` check see no vars at all |
| L-3 | low | 3 | The guard reads the first `d1_databases` entry, not the `DB` binding |
| L-4 | low | 3 | Source manifest file names are paths: `../` reads outside `--from` and restores outside the output dir |
| L-5 | low | 3 | Text extractions in the sources archive are pinned to nothing; `--full` trusts them over the PDF |

Totals: 1 high, 3 medium, 5 low, 0 critical.

### H-1 (high): a hand-edited NG course list passes `year check --full` and the record rule

- **What.** The preflight's "source inputs" check promises that a hand edit to a source-derived input
  can't pass: such an edit needs a committed `year check --full` record for the new hash, and `--full`
  is meant to fail on hand edits. But `--full` only rebuilds `data/ng-restrictions-<year>.json`
  byte for byte. It never compares `data/ng-courses-<year>.json` with `ng-courses.pdf`. That file is
  the Registrar's list of courses offered to exchange students, and it decides `ng`, `ng_semesters`
  and every exchange-mode answer. CI mode only checks its `updatedAsAt`, which semesters are present
  and a ±25% count tolerance.
- **Where.** `scripts/year.mjs:239-312` (`yearCheckFull`: quotes and the restrictions rebuild only),
  `scripts/year.mjs:113-170` (CI mode's checks on the courses file), `scripts/preflight.mjs:57`
  (`isSourceInput` counts the file) and `:99-123` (`sourceInputsCheck`).
- **Reproduction.** `test/redteam-year.node.test.js`: the year-full fakes, with `MED9999X` added by
  hand to Sem 1 and `allCodes`, committed. Then `--full` runs, its record is committed, and
  `sourceInputsCheck` runs.
- **Result.** `--full` gives `ok: true` with no problems, and its record says `outcome: ok`.
  `sourceInputsCheck` gives `ok: true` ("… covers them"). The assertion `r.ok && pre.ok === false`
  fails, so `it.fails` passes.
- **Impact.** The control's stated purpose ("a hand-edited rules file has a hash no record names, so
  it can't pass") holds for the restrictions file only. A careless fix to the NG list, such as adding
  a code the extraction "missed", gets a green record and deploys. The site would then tell
  exchange students that a course is open to them.

### M-1 (medium): the guard trusts D1's stored `row_hash`, not the rows

- **What.** The guard reads `code, title, description, text_hash, row_hash, acad_year` and hashes the
  stored `row_hash` values into `dataVersion`. No other column is read or recomputed. The guard is
  the deploy's D1 check, and rollback's data check and `verify --pre-deploy`'s dataVersion use the
  same values. `catalogueKey` covers `catalogue_only` codes, not titles or descriptions. A row
  changed without its `row_hash` changes nothing the guard sees. Ways that happen: a hand
  `wrangler d1 execute --remote` fix, an older or partial writer, or a one-table restore.
- **Where.** `src/admin-hashes.js:41` (`HASHES_SQL`) and `:153-157`; `scripts/guard.mjs:49-58`
  (dataVersion from the stored hashes) and `:63-73` (catalogueKey from codes).
- **Reproduction.** `test/redteam-guard.test.js` (Worker harness): seed through `/admin/ingest`, read
  the guard values over the real REST client, then
  `UPDATE modules SET ng = 0, ng_allow = 0, ng_semesters = '[]', semesters = '[]', credits = credits + 99`
  and `UPDATE catalogue_only SET title = 'wrong title'`, and read them again.
- **Result.** The `rowsKey`, `dataVersion` and `catalogueKey` values are identical before and after
  ("Compared values have no visual difference").
- **Impact.** `npm run deploy`, from the Mac or from Actions, ships over a D1 that no longer holds the
  committed rows. Rollback's data check passes the same way. `verify --pre-deploy` compares the
  bundle's filter fields with D1 and would catch part of this, but it runs on the Mac by hand: it is
  not part of `npm run deploy` or the Actions deploy.

### M-2 (medium): NUSMods controls text in the drift issue, and can forge its stored state

- **What.** `pendingIssue` writes the added and removed module codes into the body as-is ("Latest
  check. Added: …"), and `scripts/lib.mjs` never checks a `moduleCode`'s shape. The hidden state is
  escaped (`>` becomes `>`), but the visible codes line comes before it, and `parseState` takes
  the first `<!-- vnm-drift:state … -->` it finds.
- **Where.** `scripts/drift.mjs:212-216` and `:236` (codes into the body), `:60` and `:186-195`
  (`STATE_RE`, first match), `:529` (the next run reads it); `scripts/lib.mjs:397-398` (any non-empty
  string is a code).
- **Reproduction.** `test/redteam-drift.node.test.js`: a fake NUSMods serves an honest corpus in week
  0 and adds one record in week 1 whose `moduleCode` is
  ``CS9999 @octocat [refresh here](https://evil.example/x) <img src=https://evil.example/p.gif> <!-- vnm-drift:state {"history":[{"date":"1999-01-01","dataVersion":"forgedforged","comparison":null}]} -->``.
  `weeklyCheck` runs twice against a fake GitHub.
- **Result.** The issue body holds `@octocat`, the markdown link and the `<img>` verbatim, and
  `parseState(body).history[0].dataVersion` is `forgedforged`.
- **Impact.** A hostile or compromised NUSMods (or anything between it and the runner) can make the
  bot @mention any GitHub user from this repo, put phishing links in a trusted-looking "refresh
  pending" issue, and rewrite the check's history table, which the next run carries forward. Codes
  have no length cap, so one code past GitHub's 65,536-character body limit should make the update
  fail every week. That last effect was reasoned and not run against GitHub.

### M-3 (medium): `assertReadOnly` lets a write through

- **What.** The client claims "only SELECT and read-only PRAGMA statements are sent … anything else
  is refused in code, whatever the token would allow". SQLite reads `$`, `@`, `:` or `#` followed by
  an identifier character as a parameter, and a TCL-style `(…)` after it runs to the next `)` or
  space, swallowing quotes. The check refuses only `[$@:#][A-Za-z0-9_]`. SQLite's identifier
  characters also include `$` and every byte ≥ 0x80, so `$$(')` or `@é(')` is a parameter that eats
  a quote. `skeleton()` takes that quote as the start of a string, which hides the `;` from the
  one-statement check.
- **Where.** `scripts/d1-rest.mjs:27-57` (`skeleton`) and `:63-84` (`assertReadOnly`, in particular
  the regex on `:75`).
- **Reproduction.** `test/redteam-d1-rest.node.test.js` with
  `SELECT $$(');UPDATE modules SET title='pwned';--')` and the `@é` variant.
- **Result.** `assertReadOnly` doesn't throw on either. The client posts the string unchanged
  (`sent` holds it). In-memory SQLite, given the string as a batch, runs the SELECT and then the
  UPDATE, and every title becomes `pwned` (evidence cases pass).
- **Impact.** No current caller builds SQL from untrusted input; every statement is a constant in
  `src/admin-hashes.js`. So this breaks a promise rather than opening a hole today. The next caller
  that interpolates a value, such as a code or a tag field, gets a write path with a token that can
  write to D1 (the Actions deploy token, or the Mac's wrangler OAuth token). Whether D1's REST query
  endpoint runs the second statement of such a body was not tested here, because no Cloudflare call
  was made.

### L-1 (low): `catalogue_only` has no mass-delete guard

- **What.** Ingest refuses to delete more than 5% of D1's modules without `--allow-mass-delete`.
  Step 4b deletes every `catalogue_only` code the corpus lacks, with no guard. The corpus-only
  runbook publishes with `--new-data-version`, which skips the only data check
  `corpus publish` has. `corpus check` and the guard's catalogueKey then agree with whatever the
  corpus says, because the bundled catalogue file is rebuilt from the same corpus.
- **Where.** `scripts/ingest-core.mjs:533-549` (no ratio check; compare `:352-357` for modules);
  `scripts/corpus-manifest.mjs:251-254`; `docs/year-refresh/README.md` "A corpus-only refresh".
- **Reproduction.** `test/redteam-catalogue.test.js` (Worker harness): ingest with 200 catalogue
  codes, then with 1.
- **Result.** `status: 'done'`, 199 rows deleted, 1 left. The module side of the same run would
  have been refused.
- **Impact.** A truncated or hostile NUSMods answer, refreshed by the book, empties the table behind
  the "not offered this year" answers. Nothing stops it or asks first.

### L-2 (low): an object-valued var hides every var from the preflight

- **What.** `wranglerVars` matches `"vars"\s*:\s*(\{[^{}]*\})`. Wrangler accepts JSON values in
  `vars` (Cloudflare docs, Environment variables: "define text and JSON via the `[vars]`
  configuration", with `"SERVICE_X_DATA": { … }` as the example). One object value puts a `{` inside
  the block, so the regex matches nothing and the function returns `{}`.
- **Where.** `scripts/deploy.mjs:61-65`; `scripts/preflight.mjs:183-187`.
- **Reproduction.** `test/redteam-config.node.test.js` with
  `"vars": { "DENSE_BACKEND": "bundle", "TEST_FAKE_AI": "1", "LIMITS": { "perMinute": 30 } }`.
- **Result.** `wranglerVars` returns `{}`, so the check's extra-keys list is empty and it would
  report "only DENSE_BACKEND".
- **Impact.** The gate that keeps test-only switches out of production ("test-only switches never
  deploy") turns off silently as soon as anyone adds a structured var.

### L-3 (low): the guard reads the first D1 database listed, not the `DB` binding

- **What.** `d1Config` takes the first `database_id` in `d1_databases`, whatever its `binding`.
- **Where.** `scripts/d1-read.mjs:30-37`.
- **Reproduction.** `test/redteam-config.node.test.js`, with an `ANALYTICS` database listed before
  `DB`.
- **Result.** It returns `nusmods-analytics` and `1111…`, not `nusmods-apac`.
- **Impact.** The guard, rollback's data check and `d1:restore`'s re-read would all read the other
  database. That usually fails closed (a schema mismatch), but a database that is a copy of
  production, such as a staging or preview one, would pass the guard while the Worker binds a
  different `DB`.

### L-4 (low): source manifest file names are paths

- **What.** `manifestProblems` never checks a document's `file` or `text`. `sources publish` reads
  `join(from, name)` and `sources restore` writes `join(dir, name)`. Restore checks archive names
  against the manifest's names, but those can hold `../`.
- **Where.** `scripts/ng-sources.mjs:124-167`; `scripts/sources.mjs:206-211` and `:274-276`.
- **Reproduction.** `test/redteam-sources.node.test.js`: one document's `file` is set to
  `../escaped.png`, the rules file's `sourceSha256` key follows it, then publish and
  `restore --out <dir>/restore/out` run.
- **Result.** CI mode names no problem. Publish reads the file from outside `--from` and succeeds.
  Restore writes `<dir>/restore/escaped.png`, outside its output dir.
- **Impact.** This needs a committed manifest entry and an archive sealed with the key, so it is a
  slip rather than an outside attack. The guarantee that restore writes only inside its temp dir
  rests on the manifest being well-formed, and nothing checks that.

### L-5 (low): text extractions are pinned to nothing

- **What.** `archivedFiles` gives each document's `text` extraction `sha256: null`, so the manifest
  pins only the PDFs and HTML. `year check --full` looks for every quote in the extraction first,
  and the restrictions builder reads the `.txt` lists, such as the self-funded and YST lists.
  Nothing ties an extraction to its PDF.
- **Where.** `scripts/sources.mjs:164-172`; `scripts/year.mjs:212-219` and `:286-287`.
- **Reproduction.** `test/redteam-sources.node.test.js`: the committed 2026/27 manifest has 6
  unpinned extractions, starting with `ng-courses.txt`. An evidence case shows the repo's own
  year-full fakes pass the rule E quote check while the fake PDF holds none of the sentence.
- **Result.** As stated: `unpinned` is non-empty, and the evidence case passes.
- **Impact.** A hand-"fixed" extraction published in a new revision changes what `--full` accepts as
  NUS's words and what the builder writes. The archive's AES-GCM tag and pinned sha256 then vouch
  for it.

## Not reproduced (what was tried)

Persona 1, the fork. Nothing found. *Reasoned from docs*, plus a public read of past runs.

- **Deploy from a fork.** `deploy.yml` runs on `workflow_run` of CI and Findings with
  `branches: [main]`, and the job's `if` requires
  `github.event.workflow_run.event == 'push' && github.event.workflow_run.head_repository.full_name == github.repository`.
  A fork PR's runs have event `pull_request` and the fork as head repository, so the job skips, even
  for a fork branch named `main`, which the `branches` filter alone would let through. GitHub runs
  `workflow_run` from the workflow file on the default branch only ("This event will only trigger a
  workflow run if the workflow file exists on the default branch", *Events that trigger workflows:
  workflow_run*), so a PR can't change `deploy.yml`'s condition. All 10 public deploy runs read are
  `workflow_run` from `main` and `skipped` (`DEPLOY_FROM_ACTIONS` is off).
- **Secrets.** `ci.yml` and `findings.yml` use `pull_request`, not `pull_request_target`. "With the
  exception of `GITHUB_TOKEN`, secrets are not passed to the runner when a workflow is triggered from
  a forked repository. The `GITHUB_TOKEN` has read-only permissions in pull requests from forked
  repositories" (*Events that trigger workflows: pull_request*). `CLOUDFLARE_API_TOKEN` appears only
  in `deploy.yml`'s deploy step. Fork PRs from first-time contributors also need approval
  (`approval_policy: first_time_contributors`, public read).
- **Deploying other code.** The job checks out `head_sha` of a push-to-`main` run. `deploy-gate.mjs`
  requires `sha == main's tip` (by `git ls-remote`), and the preflight fetches origin/main and checks
  again.
- **Cache poisoning.** The drift cache and the CI corpus caches can't be written for `main` from a PR:
  "workflow runs can restore caches created in either the current branch or the default branch …
  cannot restore caches created for child branches" (*Caching dependencies: restrictions for
  accessing a cache*).
- **Tags and issues.** Only `deploy.yml` (`contents: write`) and `drift.yml` (`issues: write`) can
  write, and neither runs on a fork event.
- **Observation, not a fork issue.** `main` is unprotected: `protected: false`, no required checks,
  no rulesets. A collaborator can push to `main` directly. The deploy still waits for that commit's
  own push CI and Findings, so CI on `main` is the gate, and it is advisory on PRs.

Persona 2, beyond M-2 and L-1:

- The failure issue fences error text and turns ```` ``` ```` into `'''`, so its body stays inert.
- Wrong shapes after the 50-record shape sample throw, for example a non-string `title` on `.trim()`.
  That opens the failure issue rather than writing data.
- The UI has no `innerHTML`, `insertAdjacentHTML` or `outerHTML` sinks (`grep public/*.js`), so a
  hostile title or code in D1 is not XSS.

Persona 3, beyond the findings:

- **eval-gate.** The fast path is refused on any lock edit (`canonical(headLock) !== canonical(baseLock)`).
  `test/eval/ranking-lock.node.test.js` recomputes the import closure. Evidence reuse is refused
  (`lockHistory` and `sameEvidence`). The workspace's filesystem reads stay inside `LOCK_INPUTS`
  (`data/`, `eval/pinned`, `eval/embeddings.json`); `docs/decisions/0003…` affects compliance, not
  the lists. No file outside `LOCK_INPUTS` was found that changes the eval's lists. Production-only
  config such as `wrangler.jsonc`'s `DENSE_BACKEND` changes production's ranking without touching
  the lock, which is by design (the standby switch).
- **Rollback across a data change.** `compareWithTag` checks every tagged field against D1 and
  refuses on a mismatch or a missing field. The only gap found is M-1, which it inherits.
- **Secrets in run records, logs and artifacts.** `args` are recorded verbatim, but no ops script
  takes a secret as an argument. The D1 token is captured, never streamed, and kept out of errors
  (`d1-read.mjs:44-54`, `d1-rest.mjs:114-117`). `INGEST_SECRET` is a one-off in a 0600 file inside a
  `mkdtemp` dir and is passed only in the child's env. The deploy artifact is
  `docs/evidence/ops/runs/`, which holds run records only.
- **Remote session cleanup.** The secret dir is removed in `finally`, on `exit` and on
  SIGINT/SIGTERM/SIGHUP, and the process group is SIGTERMed and then SIGKILLed. This was read, not
  run: `wrangler dev --remote` is out of bounds.
- **Nonce reuse.** `seal` draws `randomBytes(12)` per archive, and the year and revision are the GCM
  AAD. Nothing reuses a nonce.
- **The holdout key.** `keyPath` and `readKey` refuse the name `holdout.key` in any case, a symlink
  to it, and the file `VNM_HOLDOUT_KEY_FILE` names (by inode). A hard link or copy of the default
  holdout key under another name is not refused when that variable is unset. That is the documented
  scope ("or the file VNM_HOLDOUT_KEY_FILE names"), and it wasn't tested against any real key.
