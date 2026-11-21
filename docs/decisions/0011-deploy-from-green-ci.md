# 0011: Deploys follow green CI and leave a trace; remote work goes through recording scripts

Status: accepted. The commands are in [docs/operations.md](../operations.md).

## Context
A deployed version must be traceable to a commit, a deploy must not ship a commit CI hasn't
passed, and every remote operation must be estimated and logged (ADR 0004). Hand-typed rollback
targets, a `.dev.vars` swap for remote sessions and scripts with a `localhost` default are each a
way to touch production by accident.

## Decision
- **CI always runs.** `.github/workflows/ci.yml` has no path filter: every job starts on every
  push to `main` and every ready PR, and heavy jobs skip by steps under one tested diff rule
  (`scripts/ci-changes.mjs`). On `main` that rule diffs against the last green run, and `main`
  runs never cancel each other. A docs-only change still runs `npm test`, because tests read the
  docs.
- **A push to `main` deploys once its CI is green**, from GitHub Actions
  (`.github/workflows/deploy.yml`), running `npm run deploy`, the same command the Mac runs.
  Workers Builds was not used: it deploys on every push in parallel with CI, with no option to
  wait for it. The job runs only while the repo variable `DEPLOY_FROM_ACTIONS` is `true` (the kill
  switch), deploys only the sha that is still `main`'s tip, and smokes the deployed commit.
- **The deploy token is narrow:** an account-owned API token with Workers Scripts Edit on this
  Worker only, Workers Routes Edit on the zone, and D1 Read for the guard's REST query. It can
  upload and deploy this Worker, not delete it or touch any other.
- **D1 writes stay on the Mac.** A re-ingest is a runbook step with a bookmark before it. If D1
  doesn't hold a commit's data yet, the Actions deploy fails and deploys nothing.
- **`npm run deploy` refuses** a dirty tree, a `HEAD` off `origin/main`'s tip, a commit whose CI
  push run didn't succeed, any wrangler var but `DENSE_BACKEND`, a bundle that isn't production's
  or doesn't match D1, a stale corpus or year check, and a version whose startup time is missing or
  over 200 ms. `deploy --preflight` runs every non-D1 check before any D1 write.
- **Each deploy and rollback leaves an annotated tag** (`deploy/*`, `rollback/*`) with the
  version id, the commit, the data version and the `catalogueKey`. `/health`'s `versionTag` is
  the newest tag's commit. Rollback checks D1's data version and `catalogueKey` with direct reads;
  `d1:restore` undoes a D1 write from a recorded bookmark.
- **Remote work goes through scripts that record it.** `npm run remote` starts a fresh
  `wrangler dev --remote` session with a one-off secret in a temp env file (never `.dev.vars`).
  No script has a default URL. Every remote operation writes one uniquely named run record under
  `ops/runs/`, committed with the change it belongs to.
- **Detection is scheduled; refreshes are not.** A weekly GitHub Actions check opens an issue
  when NUSMods' data no longer matches production's or next year appears, and a monthly issue
  reminds the maintainer to check NUS's sources and run the usage report. No daily live check, and
  no scheduled re-ingest: a refresh writes D1 and runs on the Mac.
- **A monthly usage report** (`npm run ops:report`) reads account-wide usage from GraphQL against
  the allowances and flags growth.

## Consequences
- Deploys need GitHub's API and, from the Mac, the deployer's `gh` login. A hotfix doesn't need
  the sources key; a change to a source-derived input does (ADR 0014).
- Every merge to `main` redeploys and empties the search cache.
- Nothing is committed to `main` from CI, which would start CI and then a deploy in a loop; an
  Actions deploy's run records are a workflow artifact.
- GitHub pauses a public repo's schedules after 60 days with no activity, so the reminder warns
  when the repo has been quiet for 45 days.

## In the code
**CI** (`.github/workflows/ci.yml`)
- Every job always starts: `check` and `eval-gate` carry only the draft guard, and the heavy jobs
  skip by steps on `scripts/ci-changes.mjs`'s outputs, so a failed `changes` job (a missing output,
  which is not `'false'`) runs them in full instead of skipping them. The UI job's Playwright image
  tag moves with the locked `@playwright/test`, or every UI test fails to launch.
- `changedFiles` (`scripts/ci-changes.mjs`) diffs with `--no-renames`, so a moved file counts at
  its old and new path; with rename detection, moving a file out of a suite's paths would list only
  the new path and skip the suite that lost it.
- No unquoted one-line `run`, `name` or `if` value in a workflow holds `: ` or ` #`: GitHub rejects
  the whole file, and the push shows one failed run with no jobs. `test/ci-workflow.node.test.js`
  checks it as text because the repo has no YAML parser.

**Deploy and trace**
- `scripts/deploy-gate.mjs` matches deploy tags on the peeled `^{}` lines of `git ls-remote`:
  deploy tags are annotated, and the unpeeled line names the tag object, never a commit, so every
  sha would look undeployed and deploy twice. When it can't read GitHub or origin it fails the job
  with an `::error` annotation instead of writing `deploy=false`: nothing deploys either way, but a
  quiet skip would hide a broken gate.
- `fetchTraceTags` (`scripts/deploy-tag.mjs`) fetches `deploy/*` and `rollback/*` with `--force`,
  so a tag moved on origin replaces the local copy; rollback and `/health` read the commit from
  these tags.
- `deploy()`'s exec wrapper (`scripts/deploy.mjs`) records every `npx wrangler` call as a
  Cloudflare request except `wrangler check` and `wrangler auth`, which never reach the API, so the
  run record lists exactly the remote calls. `summarize` swallows a failed write to
  `GITHUB_STEP_SUMMARY`: by then the version may be live, and a convenience must not turn a
  finished deploy into a failure.
- `wranglerVars` (`scripts/deploy.mjs`) parses `wrangler.jsonc` as JSONC; a pattern match over the
  text would answer `{}` for an object-valued var and let the vars check pass blind.
- `scripts/preflight.mjs` writes the startup check's CPU profile to `STARTUP_PROFILE` in the OS
  temp dir, so `wrangler check startup` never dirties the tree the git check just found clean.

**Driving wrangler**
- A flag whose value can start with `-` goes as one argv entry: `--args=--alias
  vectors-bundle:<shim>` for `wrangler check startup` (`scripts/preflight.mjs`; as two entries,
  wrangler reads `--alias` as its own unknown flag), and `--cursor=<value>` in
  `scripts/verify.mjs` `listVectorIds` (base64url cursors can start with `-`, and yargs reads a
  separate word starting with `-h` as `--help` and exits 0).
- JSON output is parsed from its first `{` (`jsonOf`, `scripts/d1-time-travel.mjs`), because
  `wrangler d1 time-travel` may print a banner first. `processedUpToDatetime` is accepted as an ISO
  string (as `wrangler vectorize info` prints it) or a number (as workers-types declares it).
- `scripts/remote-session.mjs` and `scripts/ui-server.mjs` spawn wrangler detached in its own
  process group, stop the whole group (SIGTERM, then SIGKILL) and wait until none of it is left,
  because workerd outlives its parent and keeps writing into the state directory. Readiness is
  polled, since wrangler offers nothing to wait on, and each `/health` poll ends at its own timeout,
  the 10021 line, the child's exit or a signal, because wrangler's proxy holds requests until the
  session is ready; after the child exits, the session reads the rest of its output before deciding
  why.
- `credentials()` (`scripts/embed.mjs`) runs `wrangler auth token` and `wrangler whoami` from the
  OS temp dir, so wrangler reads no project `wrangler.jsonc` or `.dev.vars`.

**Scripts that touch production**
- `scripts/d1-rest.mjs`, `scripts/guard.mjs`, `scripts/ingest-core.mjs` and `scripts/jsonc.mjs`
  import no Node APIs; fetch, the admin API, the clock and the text are injected, so the workerd
  Vitest harness runs the exact guard, REST-client and ingest code against real routes and local D1
  (`test/admin-hashes-rest.test.js`, `test/ingest.test.js`). Node-only work lives in their wrappers
  (`d1-read.mjs`, `deploy.mjs`, `ingest.mjs`); a `node:` import in the four breaks those tests.
- `scripts/d1-rest.mjs` refuses a non-read statement before a request leaves rather than relying
  on the token's permissions; `test/d1-rest.node.test.js` pins a probe that would have written had
  the token allowed it.
- `askYes` (`scripts/ask.mjs`) answers no when stdin is not a terminal, so `rollback` and
  `d1:restore` never change production unattended; a non-interactive run passes `--yes`.
- `scripts/run-record.mjs` `gitState` counts untracked files as dirt, though the dirty tree's hash
  (`git diff HEAD --binary`) leaves them out. `guardExit` handles SIGINT, SIGTERM and SIGHUP by
  default, finishing the record `interrupted` and exiting 130, 143 or 129, because a signal's
  default action exits with no `exit` event and the record would be lost; a script with its own
  signal handling (ingest) passes `signals: false`.

**Live checks**
- `draw` (`scripts/live-check-plan.mjs`) sorts candidates by code before the seeded shuffle
  (`rng`, mulberry32), so a `--seed` picks the same codes whatever order the corpus loads in, and a
  run can be repeated and compared with its dry run.
- The expected stamps for hidden codes come from the drawn kind (`CLOSED_KINDS`, `drawHidden`), the
  independent oracle (`test/oracle/oracle.mjs`) and the stored bit, never from the live `/module`
  answer, so an answer that lost its reasons can't pass by being explained the same wrong way on
  both sides.
- `createSite`'s `route()` (`scripts/live-check.mjs`) ignores a failed `route.fulfill`/`abort`: the page may have
  moved on (a superseded search) while the request waited its turn.

**The drift check** (`scripts/drift.mjs`)
- `quietNote` compares the last commit's time plus 45 days (`QUIET_WARN_DAYS`) with now by the
  clock, not by whole days, so 45 days and an hour already warns; rounding would delay the warning
  a day closer to GitHub's 60-day cut-off.
- `githubRest` sends `GITHUB_TOKEN` only in the `authorization` header, never in a URL or an error
  message, so a failed request's message (method and path) can go into a log or a failure issue.
