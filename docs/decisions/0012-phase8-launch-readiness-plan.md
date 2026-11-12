# 0012: Phase 8 launch readiness plan

Status: accepted for work: Jacob answered G1–G6 on 2026-11-12 (below); final at Phase 8's exit. The plan (`docs/plans/phase8.md`) went through
three critic rounds. Each round had three fresh critics given only the draft and the repo:
- a skeptical maintainer checking SC10 claims against the code;
- launch ops and cost;
- a first-time visitor and an exchange student.

The rounds stopped at three, by rule. Its §6 logs every objection and its resolution.

## Context
Phase 8's exit gate is SC10 (README, EVAL.md and the vault page describe the system as it is) and
the name and domain gate, which ADR 0009 already settled. Measured at `2fa2558`:
- **The docs.**
  - README.md omits the shortlist and exports, the browser install step and the academic year.
    It asks for the year of study "at home" where the page asks "during your exchange", and it
    misstates how ranking changes are gated.
  - EVAL.md opens on the Phase 2 baseline as "current", on `qrels-dev-v2` while HEAD has `qrels-dev-v11`, and its
    reproduce commands are refused as written. It says no holdout look was taken (8 were). It
    doesn't describe the ranking lock, SC5 or ADR 0003's later amendments.
  - REFERENCE.md's Phase 7 sections are current. Its older sections keep the old working title,
    the reversed v1 conclusion, a free-tier warning, pre-3-0 cost arithmetic and stale counts.
- **Cost of a launch.**
  - A typical uncached search costs 0.033 neurons, or 0.066 with a corrected typo.
  - 10,000 uncached searches a day cost 330–660 of the account's 10,000 daily neurons.
  - Paid bills overage rather than refusing it, but ADR 0004 allows none.
  - The month's busiest day used 68% of the shared daily neurons, about 4,300 of them this
    project's own corpus embeds. With no embed that day, about 110,000 uncached searches fit.
- **What a visitor sees.**
  - A mistyped URL answers raw JSON.
  - The page says nothing without JavaScript.
  - The academic year is hidden on phones.
  - There is no privacy note and no way to report a problem.
  - A keyword-only answer can stay in a browser for 4 hours, because the zone's Browser Cache TTL
    overrides a cache hit's TTL.
- **Operations.**
  - Actions deploys run no smoke.
  - A rollback is undone by the next push to `main`.
  - Nobody is told of an outage (ADR 0011 G3).

## Decisions
- **SC10 is held by a test.** `test/docs-facts.node.test.js` checks the deliberate facts (holdout
  looks, SC5, year labels against `DEFAULT_ACAD_YEAR`, the NG list), keeps volatile values (corpus
  counts, the pin sha) out of prose, and fails on retired claims and broken reproduce commands. A
  fresh reviewer re-reads the three docs at exit.
- **EVAL.md leads with the current state.**
  - First the shipped ranker and how changes ship, then SC5.
  - Then the Phase 2 baseline, re-scored on today's qrels, with the old numbers as labelled
    history.
  - The v1 eval moves to `eval/v1/README.md`.
- **Visitor fixes stay small:**
  - an HTML 404 for browsers (the JSON 404 stays for API callers), carrying `_headers`' headers;
  - `favicon.ico` and a `<noscript>` line;
  - the year at every width;
  - the restrictions link;
  - a privacy note (no contact link, G6 (d));
  - generous per-IP rate limits (G5): 40 per 10 s and 200 per 60 s;
  - the hit's own TTL;
  - a 403 for cross-site `/search` requests that aren't a top-level page (`Sec-Fetch-Dest`), so
    other sites can't spend the account's neurons.
- **Deploys smoke themselves** in Actions. The outage runbook turns off Actions deploys and clears
  running ones before a rollback.
- **No spending code.** Launch week has no corpus embed or re-ingest. G5 settles ADR 0004's
  wording and a Cloudflare budget alert, which emails and caps nothing.
- **No launch post (G2 (a)).** `docs/launch.md` holds the preconditions to check if Jacob ever
  posts, and the outage runbook.
- **Outages reach Jacob through healthchecks.io and Pushover (G4).**

## Jacob's answers (2026-11-12)
- **G1, name and address:** keep "NUS Mod Finder (unofficial)" at nusmodfinder.rcn.sh (ADR 0009
  stands).
- **G2, launch:** (a) no post. The site stays public and findable. `docs/launch.md` keeps the
  preconditions and the outage runbook, and drafts no posts.
- **G3, what the site keeps:** (a) keep everything as it is (Workers Logs with invocation logs, 7
  days on Workers Paid, and the site's own `search` line), and say so in a privacy note. No logging
  change.
- **G4, outages:** a health check that alerts through Pushover. As every scheduled job in Jacob's
  setup does, it reports to healthchecks.io (project `projects`), whose Pushover integration alerts
  him: an hourly GitHub Actions run checks the site, pings the check on success and pings `/fail`
  after two failures, so a failure alerts at once and a run that stops arriving alerts after the
  grace. No GitHub issue. The ping URL is the repo secret `HC_UPTIME_URL`; the lead creates the
  check through the healthchecks.io API.
- **G5, spending:** (b) ADR 0004 stands: no overage. A Cloudflare budget alert at the lowest amount
  says so the day after if it is ever broken. Rate limits are generous for people and stop
  scripts: `SEARCH_LIMIT` goes to 40 per 10 s per IP (a class behind one address), a second limit of
  200 per 60 s per IP caps a sustained script, and the cross-site refusal stops other sites
  spending neurons through their visitors.
- **G6, contact:** (d) none. The site names no contact; the privacy note says who runs it and
  names no address.

## Dissent
None declined: every objection in the three rounds changed the plan. A2-2 (audit the vault page)
was applied in part, as a claim-by-claim audit assigned to the lead, per the phase brief. r4, the
revision after round 3, had no critic; the plan's §6 lists what is untested.

## Consequences
- **Each merge redeploys and empties the search cache.** Phase 8's three or four PRs each
  redeploy from Actions, and after 8C each deploy smokes itself.
- **G4** adds an hourly workflow: about 70 requests and 1 neuron a day, and one healthchecks.io check.
- **G5 (b)** keeps ADR 0004; a budget alert at the lowest amount, and two per-IP rate limits.
- **The vault page** is audited and updated by the lead.
