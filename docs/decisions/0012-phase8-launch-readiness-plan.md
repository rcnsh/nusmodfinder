# 0012: Phase 8 launch readiness plan

Status: draft, pending Jacob's answers to G1–G6. The plan (`docs/plans/phase8.md`) went through
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

## Decisions (the plan; final once G1–G6 are answered)
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
  - a contact link (G6) and a privacy note;
  - the hit's own TTL;
  - a 403 for cross-site `/search` requests that aren't a top-level page (`Sec-Fetch-Dest`), so
    other sites can't spend the account's neurons.
- **Deploys smoke themselves** in Actions. The outage runbook turns off Actions deploys and clears
  running ones before a rollback.
- **No spending code.** Launch week has no corpus embed or re-ingest. G5 settles ADR 0004's
  wording and a Cloudflare budget alert, which emails and caps nothing.
- **Posts wait only on what a visitor meets.** EVAL.md, REFERENCE.md and the vault page can follow
  a post.
- **Launch is a checklist and draft posts, never an action of the project.** Jacob decides whether,
  where, when and for whom to post (G2), and posts himself.

## Jacob's answers
Pending:
- G1, the name and address;
- G2, what launch means and for whom;
- G3, what the site keeps about visitors, asked after the lead's three dashboard reads;
- G4, who notices an outage;
- G5, spending against ADR 0004's no-overage rule;
- G6, how visitors reach him.

The questions and recommendations are in the plan's §5.

## Dissent
None declined: every objection in the three rounds changed the plan. A2-2 (audit the vault page)
was applied in part, as a claim-by-claim audit assigned to the lead, per the phase brief. r4, the
revision after round 3, had no critic; the plan's §6 lists what is untested.

## Consequences
- **Each merge redeploys and empties the search cache.** Phase 8's three or four PRs each
  redeploy from Actions, and after 8C each deploy smokes itself.
- **G4 (b) or (c)** adds a scheduled workflow: about 70 requests and 1 neuron a day.
- **G3 (b) or (c)** changes `wrangler.jsonc`'s observability, and for (c) the search log line.
- **G5 (a)** amends ADR 0004. Either option adds a budget alert.
- **The vault page** is audited and updated by the lead.
