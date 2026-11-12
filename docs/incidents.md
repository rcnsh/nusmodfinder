# Launch and outages

The site is public and unannounced (ADR 0012, G2 (a): no post). This page is for Jacob: what to
check if he ever posts it, what the uptime alert means, and what to do when the site is down. The
commands behind it are in [REFERENCE.md](REFERENCE.md) under "Deploying" and "Operations".

## Before any post

Each of these is what a visitor meets. Check them all on the day.

- **The live site runs `main`.** `curl -s https://nusmodfinder.rcn.sh/health` gives a
  `versionTag` that is a prefix of `git rev-parse origin/main`, and `vectors.corpus` is
  `production`.
- **The latest deploy's smoke passed.** `gh run list --workflow Deploy --limit 1`, then
  `gh run view <id>`: the "Smoke the deployed commit" step is green. A deploy from the Mac has no
  such step; run `npm run smoke` after it instead.
- **The uptime check is up.** The healthchecks.io check for this site shows "up", and
  `gh run list --workflow Uptime --limit 3` shows recent runs.
- **The privacy note is live** on the page, and the retention it states matches the Worker's
  Workers Logs retention in the Cloudflare dashboard (7 days on Workers Paid today; Cloudflare's
  Observability pricing changes on 2026-12-01).
- **This month's NG-source check is done.** This month's `drift:reminder` issue is closed
  (`gh issue list --label drift:reminder --state all --limit 1`), and NUS's "updated as at" dates on
  the Non-Graduating pages match `data/ng-sources-<year>.json`.

**No corpus embed or forced re-ingest in a week with a post.** A forced re-ingest spends about
2,400 of the account's 10,000 daily Workers AI neurons, and on 2026-11-06 the embeds took about
4,300 of the day's 6,805. Visitors' searches need that room: ADR 0004 allows no overage.

## The uptime alert

Once an hour (`.github/workflows/uptime.yml`, minute 37 UTC), GitHub Actions sends three requests
to the site: `/health`, one `/module/<code>` and one uncached `/search`. A failure is checked
again 90 s later. A pass pings the healthchecks.io check; two failures ping its `/fail`.
healthchecks.io then alerts through Pushover.

- **"Down" with a reason** (the `/fail` ping's body, in the check's event log): both checks failed.
  The reason names the route and the status, for example `/search HTTP 502`. Look first at:
  - `/health` failing: the Worker itself. `npx wrangler deployments status`, and the last Deploy
    run (`gh run list --workflow Deploy --limit 3`).
  - `/module/<code>` failing: D1. `/health` doesn't touch D1, so this is usually D1 alone.
  - `/search degraded (…)`: Workers AI or the bundle; search still answers by keyword. Check the
    day's neurons in the dashboard (a re-ingest or embed that day?).
  - `/search HTTP 429`: the rate limit, which an Actions runner shares with other repos. Wait for
    the next run before acting.
- **"Down" with no reason** (the 12 h grace ran out): the runs stopped arriving, not the site.
  `gh run list --workflow Uptime`. GitHub pauses a public repo's schedules after 60 days with no
  activity, and may delay or drop scheduled runs under load.
- **A red Uptime run** in Actions: the ping itself failed, or `HC_UPTIME_URL` is missing. The
  site may be fine; the run's log says which.

## The site is down

In this order:

1. **Check:** `/health`, a search on the page, `npx wrangler deployments status`, and the last
   deploy tag (`git tag --list 'deploy/*' --sort=-creatordate | head -1`).
2. **First stop Actions from redeploying.** Set the repo variable `DEPLOY_FROM_ACTIONS` to
   anything but `true` (`gh variable set DEPLOY_FROM_ACTIONS --body false`), or revert the cause on
   `main`. Otherwise the next push to `main`, even a note about the incident, redeploys it.
3. **Clear the Deploy queue.** `gh run list --workflow Deploy`: wait for, or cancel
   (`gh run cancel <id>`), any queued or running Deploy job. The deploy's concurrency group never
   cancels one, so a job already queued could overwrite the rollback.
4. **Roll back, then smoke:** `npm run rollback`, then the `npm run smoke -- --expect <sha>` it
   prints. If an ingest changed D1 since the target deploy, `npm run d1:restore` comes first
   (REFERENCE.md, "Rollback").
5. **Turn the switch back on before merging the fix**
   (`gh variable set DEPLOY_FROM_ACTIONS --body true`). A merge while it is off is skipped, and
   turning it on starts nothing. Or deploy the fix from the Mac with `npm run deploy`.

## If NUS or NUSMods asks

If NUS or NUSMods asks for a change or a removal: reply, take the text or the feature down
within a day, and record it in an ADR.

## Spending

ADR 0004 stands (ADR 0012, G5 (b)): the project never goes over the account's included
allowances. Jacob sets a Cloudflare budget alert at the lowest amount. It emails the day after a
billed day and caps nothing: nothing in Cloudflare stops Workers AI spending automatically. The
week-with-a-post rule above is what keeps a launch inside the allowance.
