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
