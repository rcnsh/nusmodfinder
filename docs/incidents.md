# Incidents and outages

What the uptime alert means, what to do when the site is down, and what to check before the site
is announced anywhere. The commands behind it are in [operations.md](operations.md).

## The uptime alert

Every 15 minutes the uptime Worker `nusmodfinder-uptime` (ADR 0019) sends three requests to the
site: `/health`, one `/module/<code>` and one uncached `/search`. A failure is checked again
90 s later. A pass pings the healthchecks.io check; two failures ping its `/fail`. healthchecks.io
then alerts through Pushover.

- **"Down" with a reason** (the `/fail` ping's body, in the check's event log): both checks failed.
  The reason names the route and the status, for example `/search HTTP 502`. Look first at:
  - `/health` failing: the Worker itself. `npx wrangler deployments status`, and the last Deploy
    run (`gh run list --workflow Deploy --limit 3`).
  - `/module/<code>` failing: D1. `/health` doesn't touch D1, so this is usually D1 alone.
  - `/search degraded (…)`: Workers AI or the bundle; search still answers by keyword. Check the
    day's neurons in the dashboard (a re-ingest or embed that day?).
  - `/search HTTP 429`: the rate limit. Wait for the next run before acting.
- **"Down" with no reason** (the 20 min grace ran out): the runs stopped arriving or could not
  ping, not necessarily the site. Look at the `nusmodfinder-uptime` Worker's logs in the dashboard
  (Workers Logs mark a run that could not report as failed, with the reason), and check that its
  Cron Trigger and `HC_UPTIME_URL` secret are there
  (`npx wrangler triggers deploy -c workers/uptime/wrangler.jsonc` restores the trigger,
  `npm run deploy:uptime` the Worker). A Cloudflare-wide incident stops both Workers; the grace
  still alerts.

## The site is down

In this order:

1. **Check:** `/health`, a search on the page, `npx wrangler deployments status`, and the last
   deploy tag (`git tag --list 'deploy/*' --sort=-creatordate | head -1`).
2. **Stop Actions from redeploying.** Set the repo variable `DEPLOY_FROM_ACTIONS` to anything but
   `true` (`gh variable set DEPLOY_FROM_ACTIONS --body false`), or revert the cause on `main`.
   Otherwise the next push to `main`, even a note about the incident, redeploys it.
3. **Clear the Deploy queue.** `gh run list --workflow Deploy`: wait for, or cancel
   (`gh run cancel <id>`), any queued or running Deploy job. The deploy's concurrency group never
   cancels one, so a job already queued could overwrite the rollback.
4. **Roll back, then smoke:** `npm run rollback`, then the `npm run smoke -- --expect <sha>` it
   prints. If an ingest changed D1 since the target deploy, `npm run d1:restore` comes first
   ([operations.md](operations.md#rollback)).
5. **Turn the switch back on before merging the fix**
   (`gh variable set DEPLOY_FROM_ACTIONS --body true`). A merge while it is off is skipped, and
   turning it on starts nothing. Or deploy the fix from the Mac with `npm run deploy`.

## If NUS or NUSMods asks

If NUS or NUSMods asks for a change or a removal: reply, take the text or the feature down within
a day, and record it in an ADR.

## Before announcing the site

The site is public but unannounced (ADR 0012). Before any post about it, check each of these on
the day; each is what a visitor meets.

- **The live site runs `main`.** `curl -s https://nusmodfinder.rcn.sh/health` gives a
  `versionTag` that is a prefix of `git rev-parse origin/main`, and `vectors.corpus` is
  `production`.
- **The latest deploy's smoke passed.** `gh run list --workflow Deploy --limit 1`, then
  `gh run view <id>`: the "Smoke the deployed commit" step is green. A deploy from the Mac has no
  such step; run `npm run smoke` after it instead.
- **The uptime check is up.** The healthchecks.io check `nusmodfinder-uptime` shows "up", with a
  ping in the last 15 minutes.
- **The privacy note is live** on the page, and the retention it states matches the Worker's
  Workers Logs retention in the Cloudflare dashboard (7 days on Workers Paid; Cloudflare's
  Observability pricing changes on 2026-12-01).
- **This month's NG-source check is done.** This month's `drift:reminder` issue is closed
  (`gh issue list --label drift:reminder --state all --limit 1`), and NUS's "updated as at" dates
  on the Non-Graduating pages match `data/ng-sources-<year>.json`.
- **No corpus embed or forced re-ingest that week** (ADR 0004). A forced re-ingest spends about
  2,400 of the account's 10,000 daily Workers AI neurons, and on a busy day the account's other
  uses already take about 2,500; visitors' searches need the rest.

## Spending

ADR 0004: the project never goes over the account's included allowances. A Cloudflare budget alert
at the lowest amount emails the day after a billed day and caps nothing: nothing in Cloudflare
stops Workers AI spending automatically. The no-embed week above is what keeps an announcement
inside the allowance. The numbers are in [cost.md](cost.md).
