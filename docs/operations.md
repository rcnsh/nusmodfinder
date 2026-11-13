# Operations

Setting up, CI, deploying, rolling back, the remote-session tooling, run records, the scheduled
checks and the live checks. What to do when the site is down is [incidents.md](incidents.md);
re-ingesting is [data.md](data.md); why deploys work this way is ADR 0011.

## Setup

```bash
nvm use            # Node 22.12+
npm ci
npx wrangler login
```

Resources (already created for this deployment; do not re-run these against it):

```bash
npx wrangler d1 create nusmods-apac --location apac   # APAC primary (ADR 0005)
npx wrangler vectorize create nusmods-modules --dimensions=384 --metric=cosine
```

The schema lives only in `migrations/` (`0001_init.sql` onwards); there is no separate
`schema.sql`, and a migration file is never renamed or edited once applied (ADR 0001).
`wrangler d1 migrations apply` records what it ran in a `d1_migrations` table. The production
database `nusmods-apac` was created empty and built with
`npx wrangler d1 migrations apply nusmods-apac --remote`, so its `d1_migrations` table is complete
for 0001–0006; 0007–0010 were applied with `scripts/remote-migration.mjs` (the body and its
`d1_migrations` row in one file), 0008 before 0007. A local database needs no bootstrap:
`npx wrangler d1 migrations apply nusmods-apac --local`.

`npm run db:rebuild-check` rebuilds the schema three ways, locally, and diffs each (ADR 0001).
`node scripts/schema-snapshot.mjs --compare-remote <dir-or-file>` builds nothing: it diffs a saved
production capture (the `wrangler d1 execute nusmods-apac --remote --command … --json` output of
the pragma query, `sqlite_master`, `index_xinfo` and the `d1_migrations` names) against the
full-chain snapshot, offline, comparing the migrations as a set.

Then the eight filterable metadata indexes. **These can't be added to an index that holds
vectors**, so they must exist before any vector is written:

```bash
for spec in sem1:boolean sem2:boolean sem3:boolean sem4:boolean level:number credits:number faculty:string ng:boolean; do
  npx wrangler vectorize create-metadata-index nusmods-modules --property-name="${spec%%:*}" --type="${spec##*:}"
done
```

Adding a ninth filterable property means **recreating the index and re-ingesting**. Vectorize
allows at most 10 metadata indexes, and only the first 64 bytes of a string property are
filterable.

`.dev.vars.example` lists the local vars; nothing in this repo writes `.dev.vars`
(`npm run remote` and `npm run dev` pass a one-off secret in a temp env file).

## CI

`.github/workflows/ci.yml` runs on every push to `main`, every ready PR and by hand, with no path
filter: every job starts, so a change that only touches docs still runs `npm test` (whose tests
read README.md, EVAL.md, the docs here and under `eval/`, `docs/year-refresh/` and
`docs/decisions/`; `test/docs-facts.node.test.js` holds them to the system), and a red `main`
shows. Draft PRs run nothing.

| Job | Runs | Skips |
|---|---|---|
| `changes` | `scripts/ci-changes.mjs`: the diff rule below | never |
| `check` | lint, typecheck, types drift, `npm test`, `test:eval`, `eval:verify`, `db:rebuild-check` | never |
| `eval-gate` | the ranking lock ([EVAL.md](../EVAL.md#the-ranking-lock)): fast path, else a recompute | never |
| `full-corpus` | `test/full` over the pinned corpus and bundle; the lexical grid in full or a 1-in-10 sample | by steps, when `code` is false |
| `oracle` | `test/oracle` (Vitest projects `oracle` and `oracle-node`) over production: `current` restored from its release asset, the production bundle and data files, after `npm run corpus -- check`; fails on any skipped test. Two pinned-corpus facts (the standby's recall floor, the no-signal ruling) run in `full-corpus` (`test/full/oracle-pinned.test.js`) | by steps, when `code` is false |
| `ui (chromium 1/3)` … `ui (webkit 3/3)` | the Playwright suite in Playwright's image, three shards per browser | by steps, when `ui` is false |
| `rollover` | the year-switch rehearsal (`scripts/rollover.mjs`): the pinned corpus relabelled as next year's in a temp copy, then `year next`, the builders, `year check`, a local Worker switched by `ingest --d1-only --allow-year-change --write-budget 80000`, `verify --pre-deploy`, the oracle against next year's, and the variant with Sem 2 unpublished | by steps, when `rollover` is false |

`scripts/ci-changes.mjs` diffs a PR against its base, and a push to `main` against the newest
`main` commit whose CI run succeeded and which HEAD contains (`gh run list`, hence
`actions: read`). `code` is any change outside `docs/` and the root `*.md` files; `ui` and `grid`
are the paths those suites cover; `rollover` follows `code`. A manual run, an API error, no green
run, an unreachable base, a failed diff, or a change to `ci.yml` or the script itself runs
everything. A heavy job whose `changes` failed runs in full (a missing output is not `false`), and
every heavy job's check name always reports. Runs on `main` are grouped per sha, so none cancels
another; a PR's new push cancels its superseded run. `test/ci-workflow.node.test.js` holds this
shape.

## Deploying

```bash
npm run deploy                    # preflight, guard, upload, startup gate, promote, tag, triggers
npm run deploy -- --preflight     # the preflight alone: before any D1 write (runbook step 3)
npm run deploy -- --behind-ok     # a HEAD behind origin/main's tip (logged; see below)
```

This is the only supported way to deploy, from the Mac or from GitHub Actions (below). Plain
`npx wrangler deploy` would ship the fixture bundle. `scripts/deploy.mjs`:

1. **The preflight** (`scripts/preflight.mjs`), every check but D1's, stopping at the first that
   fails:
   - `git`: the working tree is clean (new, untracked run records under `ops/runs/` aside; a
     modified tracked file there still refuses), nothing is hidden by assume-unchanged or
     skip-worktree, and `HEAD` is on `origin/main` at its tip. A `HEAD` behind the tip refuses
     unless `--behind-ok` (for when D1 was already written for `HEAD` and an unrelated PR merged
     since); the flag is logged in the run record;
   - `ci`: `HEAD`'s own `CI` push run succeeded (`gh api …/actions/runs?head_sha=`). A run in
     progress names `gh run watch <id> --exit-status`; a failed or cancelled one,
     `gh run rerun <id>`;
   - `vars`: `wrangler.jsonc`'s vars hold only `DENSE_BACKEND`. The file is read as JSONC
     (`scripts/jsonc.mjs`), so an object-valued var counts like any other, and a file or `vars` it
     can't read fails the check;
   - `bundle`: the production bundle `data/vectors.json` records (downloaded from its release if
     absent), sha256-checked, at `src/data-version.json`'s data version; never the fixture or
     pinned bundle;
   - `corpus manifest` (`scripts/corpus.mjs`): restores `current` (`npm run corpus -- restore`,
     sha-checked), then `npm run corpus -- check`: `src/data-version.json`, the bundled catalogue
     file's `catalogueKey` and the catalogue files follow it;
   - `year check` in its CI mode (`scripts/year.mjs` `preflight()`): the year's sources agree (the
     three year places, the data files' years and dates against the source manifest), no stub
     remains, the per-corpus files are production's, the counts, an oracle for the year, and every
     indexed NUS quote still in its file;
   - `source inputs`: when `HEAD` changes a source-derived input (`data/ng-*` but
     `data/ng-unscheduled.json`, which follows the corpus; `scripts/ng-overlay/`; a quoted NUS
     sentence counts through the quote index) since the live commit (the newest `deploy/*` or
     `rollback/*` tag), a committed `year check --full` run record whose
     `details.sourceInputsHash` is those inputs' hash at `HEAD` and whose
     `details.ngList.result` is `byte-identical` (`sourceInputsHash` in `scripts/preflight.mjs`:
     sha256 over their `git ls-tree` lines). A hotfix that touches none needs no sources key;
   - `startup`: `wrangler check startup` locally with the bundle aliased in;
2. **The guard** (`scripts/guard.mjs`): reads D1 over the D1 REST query endpoint
   (`scripts/d1-rest.mjs`, about 6.8k module and 14.4k catalogue rows read, the count taken from
   the answers' `meta.rows_read`) and computes what `GET /admin/hashes` would answer, with the same
   code (`src/admin-hashes.js`). Every row is read with every column and its hash recomputed from
   them with the functions ingest writes it with (`src/rowhash.js`), never taken from the stored
   `row_hash`; D1 bills rows, not columns, so the read costs the same. It refuses unless D1's
   (code, `text_hash`) pairs hash to the bundle's `rowsKey`, D1's data version (over the
   recomputed hashes) is the committed one, every `modules` row's stored `row_hash` is its
   columns' hash (`rowHashes`), D1's `catalogueKey` is the bundled catalogue file's
   (`data/catalogue-codes.json`), and every `catalogue_only` row's stored `row_hash` is its
   columns' hash, the year included (`catalogueRows`). No Worker session starts and no secret is
   bound. The checks are a list (`GUARD_CHECKS`); one with a `field` (`dataVersion`,
   `catalogueKey`) also goes into the deploy tag and rollback's data check, and one marked
   `integrity` (`rowHashes`, `catalogueRows`) runs in rollback's data check too;
3. `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`, and refuses to
   promote a version whose reported startup time is missing or over 200 ms;
4. **the intent record**: the version id, the previous one (`wrangler deployments status
   --json`), the data version and the startup time, printed and put in the run record before the
   promote. If the live deployment can't be read, it doesn't promote;
5. `wrangler versions deploy <id>@100%`, then **the tag**: an annotated
   `deploy/<UTC yyyymmddThhmmssZ>-<version id, first 8>` on `HEAD`, one `key: value` paragraph per
   field (`versionId`, `previousVersionId`, `commit`, `dataVersion`, the guard's fields,
   `startupMs`, and `actionsRun` from Actions), pushed to origin. A failed push prints the command
   to retry; the version is live either way. Then `wrangler triggers deploy` for the Custom Domain.
   A SIGINT, SIGTERM or SIGHUP after the promote finishes the tag and the record, skips the
   triggers (it prints the command) and exits 130, 143 or 129.

Every run, refused or live, writes one run record (below) with the preflight's checks, the guard's
read, the version ids, the tag and the outcome; `--preflight` writes a `deploy:preflight` record,
which `ingest` looks for. The tags are the deploy trace in git: `/health`'s `versionTag` is the
commit of the newest `deploy/*` or `rollback/*` tag. The oldest deploy tags were made by hand after
the fact and carry `backfilled: true` (`scripts/deploy-tag.mjs` reads both kinds).

**The D1 REST reads.** The client sends one statement per request and refuses, in code and before
anything leaves, any statement but one `SELECT` or one schema-reading `PRAGMA` (`table_info`,
`index_list` and the like, never an `=` form). After comments and literals are stripped, no write
keyword (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP`, `ALTER`, `ATTACH`, `DETACH`,
`VACUUM`, `REINDEX`, `RETURNING`) may appear anywhere, and no `$`, `@`, `:` or `#` at all:
SQLite's named and TCL-style parameters can swallow a quote and hide a second statement. Every
caller sends a constant with `?` parameters. The token is `CLOUDFLARE_API_TOKEN`, else
`npx wrangler auth token --json` captured in-process (the Mac's wrangler login); it is never
printed, logged, put in an error or recorded. The account is `CLOUDFLARE_ACCOUNT_ID`, else the
account wrangler cached (`node_modules/.cache/wrangler/wrangler-account.json`), else the one
account `wrangler whoami` lists; set the variable if none gives one. The database is the
`d1_databases` entry bound as `DB` in `wrangler.jsonc`, wherever it is listed; none, or two, is
refused. Rollback and `d1:restore` read through the same client.

### Deploying from GitHub Actions

`.github/workflows/deploy.yml` runs on `workflow_run` when `CI` completes on `main`, and
`scripts/deploy-gate.mjs` lets it deploy only when that sha's `CI` push run succeeded, the sha is
still `main`'s tip (otherwise the newer commit's run deploys it), and no `deploy/*` tag names it
yet (a re-run of CI completes again; a later run finds the earlier one's tag). It checks out
exactly that sha and runs `npm run deploy`, the same command as above, in the `deploy-production`
concurrency group (never cancelled mid-run). Then it smokes the deployed commit
(`npm run smoke -- --expect <sha>`), and a failed smoke fails the job, which GitHub reports. The
smoke step has no secret and no token: the deploy step has already put the production bundle in
`.data/vectors/` and restored `current` to `.data/prod/`, so smoke's own restores are no-ops (if
the step ever moves before the deploy, it needs `GH_TOKEN`). Permissions: `contents: write` (the
tag push) and `actions: read`. Only the deploy step sees `CLOUDFLARE_API_TOKEN` (a secret) and
`CLOUDFLARE_ACCOUNT_ID` (a repo variable). The run records (the deploy's and the smoke's) are kept
as an artifact for 90 days and the deploy writes a job summary; nothing is ever committed to
`main` from CI, which would start CI and then a deploy in a loop. The pushed tag is the durable
trace. Re-ingests (D1 writes) stay on the Mac: if the guard finds D1 differs from the bundle, the
job fails, says the re-ingest runs on the Mac through the runbook, and deploys nothing; that
deploy then runs on the Mac.

**The kill switch:** the job runs only when the repo variable `DEPLOY_FROM_ACTIONS` is `true`.
Set it to anything else (`gh variable set DEPLOY_FROM_ACTIONS --body false`) to stop Actions
deploys at once; the Mac's `npm run deploy` is unaffected. With it on, every push to `main`
deploys once its CI is green, a docs-only one too (the guard's ~21k rows read each time). A merge
while it is off is skipped, and turning it back on starts nothing.

**The deploy token** (an account-owned API token, the dashboard's "API token for external
CI/CD"), stored as the repo secret `CLOUDFLARE_API_TOKEN`:
- Workers Scripts: Edit, on the `nusmodfinder` Worker only (`versions upload`, `versions deploy`,
  `deployments status`);
- Workers Routes: Edit, on the `rcn.sh` zone (`wrangler triggers deploy`, the Custom Domain);
- D1: Read, for the account (the guard's REST query).

## Rollback

```bash
npm run rollback                         # to the deployment before the live one
npm run rollback -- --to <version id>    # or its first 8
```

`scripts/rollback.mjs` takes the target's commit and data version from its `deploy/*` tag, reads
D1 directly over the REST query (no Worker session, no working-tree code; ~21k rows) and refuses
unless every tagged field (`dataVersion`, `catalogueKey`) equals D1's and every row's stored
`row_hash` is its columns' hash (the guard's `integrity` checks); a tag without one of the fields
is refused too. A deliberate mismatch needs `--accept-data-mismatch`, which prints the risk; the
usual path across a data change is `npm run d1:restore` first, then rollback. It asks before
acting (or `--yes`), runs `wrangler rollback <id> --message "rollback to <tag>" -y`, tags
`rollback/<time>-<id8>` on the target's commit and pushes it (a failed tag is reported, not
fatal), and prints `npm run smoke -- --expect <target sha>`. It needs no clean tree and no CI. The
Vectorize standby is not rolled back: if it matters (a `DENSE_BACKEND` flip), rerun
`npm run remote -- vectors standby` from the target commit. Wrangler leaves bound resources alone,
so a rollback is code only. No version before `59986aa3` is a target (the Worker's history starts
under its current name).

Before rolling back with Actions deploys on, follow [incidents.md](incidents.md): turn the kill
switch off and clear queued Deploy runs first, or the next push redeploys the cause.

## D1 bookmarks and restores

```bash
npm run d1:bookmark                      # D1's current Time Travel bookmark, recorded (a read)
npm run d1:restore                       # back to the newest recorded bookmark (a D1 write)
npm run d1:restore -- --bookmark <id>
```

`d1:bookmark` runs `wrangler d1 time-travel info nusmods-apac --json` and records the bookmark;
the next `ingest` copies it into its own record. `d1:restore` takes the newest bookmark record
(or `--bookmark`), prints it, its age and the ingest it came before, asks (or `--yes`), runs
`wrangler d1 time-travel restore nusmods-apac --bookmark <id> --json`, records the restore with
the bookmark that undoes it, and re-reads D1's data version over the REST query. The code stays
where it is: this undoes "ingest done, deploy refused". Bookmarks reach back 30 days, and an older
one is refused. A restore rewrites the database in place but isn't billed as rows written.

## Smoke

```bash
npm run smoke                            # against HEAD's files
npm run smoke -- --expect <sha>          # after a rollback, the target's
```

`scripts/smoke.mjs` sends five requests, one at a time, each at least 4 s after the last answer:
`/health` (the tag is a prefix of the commit, the data version is its `src/data-version.json`, the
bundle is `production`), `/` (200 with the CSP header), `/module/<code>` for a code in no group
whose title is unique in that commit's corpus and bundle, `/search` for the title `/module` gave
(`cache;desc=miss`, not degraded, the code in the top 5) and `/facets`. The data version, the
groups and the bundle's codes come from the expected commit's files; titles come from its
production corpus, `current` in its `data/corpus.json` (restored and sha-checked; a commit without
the manifest uses the working tree's, and says so). The URL is `wrangler.jsonc`'s Custom Domain at
that commit, or `--url`. Every Actions deploy runs it as its last step; after a deploy or a
rollback from the Mac, run it by hand. It costs 5 GETs and one uncached search (about 0.03
neurons).

## Checking what's live

Every Worker response carries `x-app-version` (the tag, else the version id), and `GET /health`
returns `{ ok, versionId, versionTag, dataVersion, vectors }` without touching D1. `vectors` is
the bundle's `{ corpus, count, dataVersion }`, so after a deploy it must say `production`. The
page (`/` and the files in `public/`) is static assets, answered without running the Worker, so it
carries no `x-app-version`: `GET /health` is the version trace for `/`, and a deploy ships the page
and the Worker as one version.

## Live checks

Two scripts check the live site in real browsers, from the deployed commit on `main`, after the
smoke: run `live-check` after a deploy that changes `public/`, and `live-shortlist` after one that
changes the shortlist or export. Against a live URL each writes a run record (`live-check`,
`live-shortlist`) listing every request it sent. Every request starts at least 4 s after the last.

```bash
node scripts/live-check.mjs --dry-run       # the draw; sends nothing
node scripts/live-check.mjs                 # about 7 min; exit 0 only if every check passes
node scripts/live-shortlist.mjs --plan      # the draw and the 12 calls; sends nothing
node scripts/live-shortlist.mjs             # about 4 min; exit 0 only if every check passes
```

**`live-check`** checks the live page in Chromium (and WebKit for the iPhone 13 fold):
- the full detail on 20 codes drawn with seed 5 from `current` (`data/corpus.json`, restored into
  `.data/prod/<sha256>.json`), normalised as ingest does, 4 each with exams in two semesters, a
  cohort-only prerequisite, no workload, two or more notes, and none of those;
- axe (every rule but AAA's 7:1) on the first screen, an open detail and a hidden code, light and
  dark, at 1280 and 390×664;
- the 390×664 fold, in Chromium and as an iPhone 13 in WebKit;
- the hidden-code explanation for 3 drawn closed codes (off the NG list, listed for the other
  semester only, closed by a restriction: line, stamp and switch as the page's rules give them
  from each code's `/module` answer) and 1 drawn partial code;
- `/health`: `versionTag` is a prefix of `HEAD`, the data version is `src/data-version.json`'s,
  and the bundle is `production`.

It sends about 100 requests. The page's files, `/facets` and any answer already fetched are
fetched once and then served to the browsers from memory. Each request, sent or served from
memory, is a line in the JSONL log (`--log`, default `.data/live-check.jsonl`), with a summary
line at the end. A 429 is waited out and re-sent twice at most. Against `npm run dev`,
`--url http://127.0.0.1:<port>` draws from the fixture and expects no version tag.

**`live-shortlist`** first fetches, from Node, every answer the check needs: `/facets`, the
shortlist's 8 `/module` answers and 3 404 codes' (one `ng-listed`, one `catalogue-only`, `CS9999`
as `unknown`), one call in flight. Then Chromium and WebKit load the page, their `/module` and
`/facets` calls served from that memory (any other API call is refused and fails the run), so the
page's 10 s timeout never fires and nothing is sent twice. The page's files come from the network
through the same queue, once each. The shortlist is drawn with seed 6 from the
production-normalised modules: 6 picks and 2 backups over Sem 1 and Sem 2 at `ug2`, with a
counted, a to-confirm, a Business ("only if invited") and a closed entry, no two in one group.
Each entry's standing comes from the independent reference
(`test/web/shortlist-reference.node.mjs`, which the shortlist's property test also runs) and its
status from the oracle. Checks: the view's rows and stamps; the view's totals equal the
reference's, and the downloaded CSV's equal the view's; the CSV reads back strictly; Chromium's
tagged PDF holds every description; axe on the view, light and dark, in both engines; the 390×664
fold on the view (header, search bar, the view's heading and its export buttons), in Chromium and
as an iPhone 13; each 404 answers its kind. Every call, sent or served from memory, is a line in
the log (`--log`, default `.data/live-shortlist.jsonl`) with a summary line at the end. Against
`npm run dev`, `--url http://127.0.0.1:<port>` draws from the fixture.

## Remote sessions

**`npm run remote -- [--port <n>] <command…>`** (`scripts/remote.mjs`) runs one command against
production D1, Vectorize and Workers AI through a fresh `wrangler dev --remote` session
(`scripts/remote-session.mjs`; the deploy guard doesn't use one, it reads D1 over REST):

- `wrangler dev --remote --ip 127.0.0.1` on a free port; 8787 and 8799 belong to other projects on
  the dev Mac and are never used;
- a one-off `INGEST_SECRET` in a 0600 env file in a fresh temp dir, passed with `--env-file`, so
  wrangler never loads `.dev.vars` (and neither does the script);
- `/health` polled until it answers; Cloudflare's `code 10021` (a session that failed to generate
  its D1 binding) is retried every 30 s for up to 30 minutes, each try logged;
- the command runs with `WORKER_URL` and `INGEST_SECRET` set; `ingest`, `verify` and `vectors`
  name `scripts/<name>.mjs`, anything else runs as given, without a shell;
- the session is stopped (its process group, SIGKILL after 5 s) and the temp dir deleted when the
  command ends, on a throw, and at exit. A first Ctrl-C goes to the command, which stops cleanly
  (ingest records its in-flight mutations), and the session stays up until it has; a SIGTERM sent
  to `npm run remote` alone is passed on to the command. A second signal, or a SIGHUP (a closed
  terminal), stops the session and the command at once.

The exit code is the command's (1 when the session never answered, 2 on a usage error).

**No default URL.** `ingest`, `verify` and `vectors standby` refuse to run without `--url` or
`WORKER_URL`, and refuse ports 8787 and 8799, before sending anything.

## Run records

Every script that touches a remote writes one JSON file per run, on every exit path, at
`ops/runs/<UTC yyyymmddThhmmssZ>-<script>-<4 hex>.json` (`scripts/run-record.mjs`). Unique names
mean two worktrees never conflict. Commit them with the change they belong to; `npm run deploy`
ignores new, untracked ones when it checks the tree is clean. They are read back: `d1:restore` and
`ingest` find the newest bookmark, `ingest` the preflight for `HEAD`, the deploy preflight a
`year check --full` record, `ops:requests` the request totals.

Writers: `deploy` (and `deploy:preflight`), `remote`, `ingest`, `verify`, `vectors standby`,
`smoke`, `rollback`, `d1:bookmark`, `d1:restore`, `eval:embed` (its neurons), `ops:report`,
`live-check` and `live-shortlist` against a live URL (not `localhost`), `corpus publish`,
`sources publish` (the archive's release and sha256) and `year check --full` (mode `full`, the
source-derived inputs' hash, the archive's sha256; the deploy preflight reads it). An Actions
deploy's record is a workflow artifact, not a commit.

The record (schema `vnm-run/1`):

| Field | What |
|---|---|
| `time`, `finishedAt` | ISO UTC; `time` is the start and names the file |
| `script`, `args` | e.g. `ingest`, `["--d1-only"]` (never a secret) |
| `commit` | `{ sha, dirty, diffSha256 }`: HEAD, whether the tree is dirty (new run records aside), and when it is, the sha256 of `git diff HEAD --binary` |
| `target` | the URL, the Worker or the service the run touched |
| `read`, `written` | lists of `{ what, estimate, actual }` (D1 rows, Vectorize vectors, neurons) |
| `requests` | live requests sent, by path (no query string, no account id), plus one `wrangler <command>` entry per wrangler command that calls Cloudflare's API (each try of a `wrangler dev --remote` session, `versions upload`, each `vectorize list-vectors` page) |
| `versions` | version id, tag, data version, mutation id: whatever the run made or saw |
| `bookmark` | a D1 Time Travel bookmark, or null |
| `details` | anything else (the session's port and tries, a mode) |
| `outcome`, `exitCode`, `message` | `ok`, `refused` (stopped at a check before writing), `failed`, `partial` (stopped part-way, resumable) or `interrupted`; the exit code; one line |

A writer starts the record once it reaches for the remote (a usage error before that leaves none)
and finishes it on every return:

```js
import { startRun } from './run-record.mjs';
const run = startRun('d1:bookmark', { target: 'nusmods-apac', args: argv });
run.guardExit();                         // at exit, or on SIGINT/SIGTERM/SIGHUP (then exits 130/143/129),
                                         // writes it if nothing else did; { signals: false } if the
                                         // script handles signals itself (ingest)
run.read('D1 Time Travel info', { estimate: 0, actual: 0 });
run.setBookmark(bookmark);
run.finish('ok', { exitCode: 0 });       // once; a second call is a no-op
```

`run.countingFetch(fetch)` counts each request by path; `run.request(path)` counts one by hand.
`recordedLiveRun` wraps a live-check script. Records go to `$VNM_RUNS_DIR` when it is set (the node
test project sets a temp dir), and the module refuses the repo's dir under Vitest.
`test/run-record.node.test.js` validates every committed record (`checkRunRecords`): the schema,
an ISO UTC time (and `finishedAt`) not in the future, an outcome, every field above with its type,
and a name matching the record.

**`npm run ops:requests`** prints live-call totals from the run records, by script and path: every
request a record lists is one call.

## The monthly usage report

**`npm run ops:report -- [--month <yyyy-mm>]`** (`scripts/ops-report.mjs`) writes the month's
usage report to `ops/reports/<month>.md`, with a run record. Run it on the Mac monthly (the
monthly reminder issue asks for last month's) and after a deploy that changes the search path,
then commit both files. The month defaults to the current UTC one.

- **What it reads.** Cloudflare's GraphQL Analytics API: two calls, one combined query for the
  month and one for the month before, at least 4 s apart. Account-wide Worker requests and CPU
  (`workersInvocationsAdaptive`), D1 rows read and written (`d1AnalyticsAdaptiveGroups`) and
  Workers AI neurons by day (`aiInferenceAdaptiveGroups`), each against Workers Paid's allowance
  (`ALLOWANCES` in the script, which cites the pricing pages). Then this Worker's share: requests,
  CPU, CPU per request p50 and p99, exceptions, requests by HTTP status, and `nusmods-apac`'s rows.
- **Flags:** anything above 25% of its allowance, and anything that grew on the month before: the
  account-wide measures, and this Worker's requests, CPU, CPU p50 and p99, exceptions, 4xx and 5xx
  responses and database rows. Totals in a month in progress are projected over the whole month
  before they are compared; the busiest neuron day and the quantiles are not.
- **Missing is not zero.** A dataset GraphQL couldn't answer is written as `missing: <why>`, and
  the run exits 1 with outcome `failed`; an empty dataset is zero.
- **The month is the calendar month.** The subscription's renewal date, which starts the billing
  month, isn't readable with these scopes, and the report says so.
- **Auth,** as the deploy's D1 reads (`scripts/d1-read.mjs`): the token is
  `CLOUDFLARE_API_TOKEN`, else `npx wrangler auth token --json`; the account is
  `CLOUDFLARE_ACCOUNT_ID`, else wrangler's cached account, else the one `wrangler whoami` lists.
  The token goes only in the `Authorization` header: never into the report, the record, a log line
  or an error (an API error that echoes it is redacted). Neither the token nor the account id is
  recorded; the record counts each call as `/client/v4/graphql`.

Workers Logs keep every event (`head_sampling_rate` unset), 7 days. Paid includes 20 million
events a month; from 2026-12-01 Workers Logs move to Cloudflare Observability pricing (50 GB of
ingestion and 10 GB-month of storage included a billing cycle). This Worker's volume is far inside
either. The privacy note states that retention
([architecture.md](architecture.md#what-is-kept-about-visitors)).

## Drift and reminder issues

`.github/workflows/drift.yml`, `scripts/drift.mjs`. The workflow has `contents: read` and
`issues: write`, reads only NUSMods' public API, and makes no Cloudflare or live-site call. It
needs no secret but the run's `GITHUB_TOKEN`.

- **Weekly (Monday 01:17 UTC).** A conditional GET of this year's `moduleInfo.json`, with the last
  copy and its ETag kept by `actions/cache` (`.data/drift-cache/`; a miss costs one full fetch),
  and a GET of next year's `moduleList.json`. It computes the data version offline as ingest does
  (`offeredModules` over HEAD's NG files, `rowHash`, `dataVersion`) and compares it with
  `src/data-version.json`.
  - **`drift:pending`:** one issue, kept updated while they differ, with a row per check: courses
    added, removed and changed against the copy the check before saw, the D1 columns that changed,
    and catalogue-only counts. The check closes it once production's data version matches. The
    issue links the corpus-only refresh in `docs/year-refresh/README.md`.
  - **`drift:next-year`:** opened once when next year's list appears. The check never closes it.
  - **`drift:failure`:** its own failure (a NUSMods shape change, an HTTP error, or a failed step
    before the check). Repeats comment on the open one; the next good run closes it.
- **Monthly (the 1st, 01:41 UTC), `drift:reminder`:** one issue a month to check the Registrar's
  NG list and restrictions and YST's pages, and to run last month's usage report. When the last
  commit is more than 45 days old it adds that GitHub stops a public repo's schedules after 60 days
  with no activity; committing the usage report keeps the repo active. A monthly run alone can miss
  the window between day 45 and day 60, so the weekly run also opens that warning as its own
  `drift:reminder` issue, once per quiet stretch (keyed by the last commit).

Issues are found by their label and a hidden marker in the body (`<!-- vnm-drift:… -->`), never by
title. NUSMods controls the codes the pending issue names, so only codes of the course-code shape
(`MODULE_CODE_RE`) are shown; any other is counted ("N codes not in the course-code shape"). The
issue's history is read from the last `vnm-drift:state` block of its body, keeping only entries of
the shape the check writes, and is written with `<` and `>` escaped, so no value can forge it. To
see what a check would do without touching GitHub, run `node scripts/drift.mjs weekly --dry-run`
(it does fetch NUSMods) or `monthly --dry-run`. The crons in `drift.yml` must match `SCHEDULES` in
the script; `test/drift-workflow.node.test.js` checks that.

## The uptime check

`.github/workflows/uptime.yml`, `scripts/uptime.mjs` (ADR 0012). Hourly at minute 37 UTC, and by
hand (`workflow_dispatch`). Each run sends three GETs to `wrangler.jsonc`'s Custom Domain, each at
least 4 s after the last answer, since Actions runners share addresses and the site's limit is per
address:

- `/health`: 200 with `ok: true`;
- `/module/<code>`: 200 with that code. The code is drawn by the hour from the checkout's
  `data/groups.json`, so no course is named in the script. `main` can be ahead of the deploy (a
  refresh is merged before D1 is re-ingested; a rollback), so a 404 that names its kind of miss
  (`unknown`, `catalogue-only`, `ng-listed`) passes too, with a note: the Worker read D1 to give
  it, and a D1 failure is a 502;
- `/search` for a plain-English topic from `QUERIES` in the script, rotating by the hour: 200,
  `cache;desc=miss` (as smoke requires), not `degraded`, at least one result. On a cache hit it
  takes the next query, up to 3. Checking the miss and `degraded` catches the keyword-only
  fallback, which still answers 200.

A failure is checked again 90 s later, with queries not yet sent; nothing is kept between runs. A
pass pings the healthchecks.io check; two failures ping its `/fail` with a one-line reason as the
body: the route and the status (`/search HTTP 502`, `/search degraded (workers-ai-timeout)`), never
a visitor's data. healthchecks.io alerts the owner through Pushover, at once on `/fail`, and after
the check's 12 h grace when runs stop arriving (GitHub may delay or drop scheduled runs, and pauses
a public repo's after 60 quiet days). The check (period 1 h, grace 12 h) is in the owner's
healthchecks.io account; its ping URL is the repo secret `HC_UPTIME_URL`, the workflow's only
secret, with `contents: read` and nothing else. The script never prints the URL: every line shows
it as `<HC_UPTIME_URL>`. The run exits 0 once the report reached healthchecks.io, up or down (a red
run every hour of an outage would only add emails), 1 when the ping itself failed, and 2 on a
missing or non-https `HC_UPTIME_URL`, before any request. It writes no run record: the history is
healthchecks.io's. `node scripts/uptime.mjs --dry-run [--url <url>]` checks a site and prints what
it would ping, pinging nothing. The cron must match `SCHEDULE` in the script;
`test/uptime.node.test.js` checks it, the permissions and the secret.

What each alert means and what to do is [incidents.md](incidents.md).
