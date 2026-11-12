# 0012: Phase 8 launch readiness plan

Status: draft, pending Jacob's answers to G1–G4. The plan (`docs/plans/phase8.md`) went through
three critic rounds. Each round had three fresh critics given only the draft and the repo:
- a skeptical maintainer checking SC10 claims against the code;
- launch ops and cost;
- a first-time visitor and an exchange student.

The rounds stopped at three, by rule. Its §6 logs every objection and its resolution.

## Context
Phase 8's exit gate is SC10 (README, EVAL.md and the vault page describe the system as it is) and
the name and domain gate, which ADR 0009 already settled. Measured at `2fa2558`:
- **The docs.**
  - README.md is mostly right. It omits the shortlist and exports and the browser install step.
  - EVAL.md still opens on the Phase 2 baseline as "current" and says no holdout look was taken
    (8 were). It doesn't describe the ranking lock, SC5's result or ADR 0003's later amendments.
  - REFERENCE.md's Phase 7 sections are current. Its older sections keep the old working title,
    the v1 eval's "vector half unproven", a free-tier "until midnight UTC" warning and pre-3-0
    Vectorize arithmetic.
- **Cost of a launch.** A typical uncached search costs 0.033 neurons, 0.066 with a corrected
  typo. 10,000 uncached searches in a day cost 330–660 of the account's 10,000 daily neurons. On
  Workers Paid, going over is billed, not refused. The search cache and the keyword-only fallback
  already exist.
- **What a visitor sees.**
  - A mistyped URL and `/favicon.ico` answer raw JSON 404s.
  - The page says nothing without JavaScript.
  - There is no privacy note. Cloudflare's per-request Workers Logs keep the URL, search text
    included, for 7 days.
- **Who notices an outage.** Nobody, automatically (ADR 0011 G3 declined a daily check). Before
  launch the only visitors were Jacob and the tests.

## Decisions (the plan; final once G1–G4 are answered)
- **SC10 is held by a test, not by care.** `test/docs-facts.node.test.js` checks each volatile
  number the docs keep against its source file, and fails on retired claims. Numbers that need not
  be in prose are replaced by pointers to the file.
- **EVAL.md leads with the current state:** the shipped ranker and how changes ship (the ranking
  lock, holdout looks), SC5, then the Phase 2 baseline. The v1 eval moves to `eval/v1/`.
- **Visitor fixes stay small:**
  - an HTML 404 for browsers, keeping the JSON 404 for API callers;
  - a `favicon.ico`;
  - a `<noscript>` line;
  - a privacy note linked from the footer;
  - `og:site_name` with "(unofficial)".
- **Launch is a checklist and a draft post, never an action of the project.**
  - `docs/launch.md` lists what must hold before any post, the launch-week checks, a "site is
    down" runbook and a takedown line.
  - Jacob decides whether, where and when to post (G2), and posts himself.
- **No new infrastructure for cost.** The spike is cents. The burst limiter, the cache and the
  fallback stay as they are.

## Jacob's answers
Pending: G1 (name and address), G2 (what launch means), G3 (what the site keeps about visitors),
G4 (who notices an outage). The questions and recommendations are in the plan's §5.

## Dissent
Pending the critic rounds (§6 of the plan).

## Consequences
- **Each merge redeploys and empties the search cache.** Phase 8's three or four PRs each
  redeploy from Actions.
- **G4 (b), if chosen,** adds a scheduled workflow and about 50 requests a day.
- **G3 (b) or (c), if chosen,** changes `wrangler.jsonc`'s observability, and for (c) the search
  log line.
- **The vault page** gains the launch state, the privacy stance and the outage check (the lead).
