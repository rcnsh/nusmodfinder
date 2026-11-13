# 0019: The uptime check runs every 15 minutes from its own Worker's Cron Trigger

Status: accepted. Changes where and how often ADR 0012's uptime check runs; what it checks is
unchanged. Operations: [docs/operations.md](../operations.md#the-uptime-check).

## Context
ADR 0012's check ran hourly from a scheduled GitHub Actions workflow. GitHub delays and drops
scheduled runs under load: in its first day the hourly workflow ran 3 times, 5 to 9 hours apart.
The healthchecks.io check therefore needed a 12 h grace to avoid false alarms, so an outage could
go unnoticed for more than 13 hours, and the "hourly" check was not one.

## Decision
- **A separate Worker, `nusmodfinder-uptime`, runs the check from a Cron Trigger every 15
  minutes** (`workers/uptime/`). Cloudflare's Cron Triggers fire on schedule; a run may take up to
  15 minutes of wall time, so the 90 s retry fits.
- **Its own Worker, not a cron on `nusmodfinder`:** a broken deploy, a bad config or an exception
  in the site's Worker must not stop the check that reports it. It has no routes, no bindings and
  no address, and requests the site through its public Custom Domain like a visitor.
- **One check, two callers.** The check lives in `scripts/uptime-check.mjs`, which imports nothing
  so the Worker can bundle it; `scripts/uptime.mjs` runs the same check by hand.
- **The period is 15 minutes.** The module code and the first query are drawn by the period, so
  four runs an hour don't meet the search cache's earlier answers.
- **healthchecks.io stays the alert**, as a cron check (`*/15 * * * *` UTC) with a 20 min grace:
  a failure alerts at once through `/fail`, and silence alerts within about 35 minutes. A
  Cloudflare-wide outage stops both Workers, and the silence still alerts.
- **Deployed from the Mac** with `npm run deploy:uptime`. The Actions deploy token can edit only
  `nusmodfinder`, and the uptime Worker changes rarely.
- The GitHub Actions workflow and its repo secret are removed.

## Consequences
- About 290 requests, 25k D1 rows read and 4 neurons a day ([docs/cost.md](../cost.md)), inside
  ADR 0004's allowances.
- The uptime Worker bundles `data/groups.json` when it is deployed; the codes go stale after a
  corpus refresh until it is redeployed, which the check tolerates (named 404s pass).
