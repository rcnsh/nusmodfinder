# 0012: Public-site safeguards: what is logged, rate limits, outage alerts, docs held to the code

Status: accepted.

## Context
The site is public and findable but unannounced. A visitor, a script or another site's page can
reach it; an outage should reach the owner, not wait to be noticed; and the docs must keep
describing the system as it is.

## Decision
- **Logging stays as it is, and the privacy note says so.** Workers Logs keep an invocation log
  for every Worker request (the URL, so the search text, and the headers, the IP among them) for 7
  days on Workers Paid, beside the site's own `search` line. `public/privacy.html` states that,
  what stays on the device (the year of study and the last shortlist in `localStorage`) and that
  there are no cookies or trackers. A change to any of these changes the note in the same PR.
- **No contact.** The site names no contact; the privacy note says who runs it and names no
  address. If NUS or NUSMods asks for a change or a removal, the change is made within a day and
  recorded in an ADR.
- **Rate limits are generous for people and stop scripts:** 40 searches per 10 s per IP (a class
  behind one address) and 200 per 60 s per IP (a sustained script). Both are burst guards, per
  colo and eventually consistent.
- **`/search` refuses other sites' pages.** A request with `Sec-Fetch-Site: cross-site` and any
  `Sec-Fetch-Dest` but `document` gets a 403, so another site's fetch, image or iframe can't
  spend this account's neurons through its visitors' browsers. A followed link still works.
- **Visitor basics:** an HTML 404 for browsers (the JSON 404 stays for API callers), carrying the
  page's security headers; `favicon.ico`; a `<noscript>` line; the academic year at every width;
  and a cache hit re-sent with its own TTL, since the zone's Browser Cache TTL would otherwise keep
  a keyword-only answer for 4 hours.
- **Outages reach the owner through healthchecks.io and Pushover.** Every 15 minutes the uptime
  Worker (ADR 0019) sends three GETs (`/health`, one `/module`, one uncached `/search`), pings the
  check on success and its `/fail` after two failures, so a failure alerts at once and a run that
  stops arriving alerts after the grace. The ping URL is the uptime Worker's secret
  `HC_UPTIME_URL`.
- **Rollbacks hold.** The outage runbook turns off Actions deploys and clears queued ones before a
  rollback, since the next push to `main` would otherwise redeploy the cause.
- **No announcement post is drafted.** [docs/incidents.md](../incidents.md) holds the checks to
  run before one and the outage runbook.
- **The docs are held to the system by a test.** `test/docs-facts.node.test.js` checks the
  deliberate facts in README.md, EVAL.md and the docs (holdout and test-set looks, the test
  set's Δ, year labels against `DEFAULT_ACAD_YEAR`, the NG list's counts), keeps volatile values
  (corpus counts, sizes, the shipped pin) out of prose as pointers, and fails on retired claims
  and broken commands.

## Consequences
- The uptime check costs about 290 requests and 4 neurons a day ([docs/cost.md](../cost.md)).
- A rate-limited visitor sees a plain sentence and a retry time; traffic spread over many
  addresses is not limited (ADR 0004's rules are what protect the daily neurons).
