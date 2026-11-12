# 0011: Phase 7 ops and architecture plan

Status: accepted. Jacob answered G1–G5 on 2026-11-12 (below), and Phase 7 closed at
`phase7-final` (`docs/evidence/phase7/exit.md`). The plan (`docs/plans/phase7.md`) went through
three critic rounds. Each round had three fresh critics given only the draft: CI and testing; ops,
deploy and data refresh; and a maintainer running next year's refresh alone. The rounds stopped at
three, by rule, and its §6 logs every objection and its resolution. C3-2, the behaviour of a
semester NUS hasn't published yet, was settled by G2 (`ng:unpublished-sem`).

## Context
SC9 asks for four things:
- everything in git;
- CI with tests, lint and an eval gate;
- migrations that rebuild the database from scratch;
- a deployed version traceable to a commit.

Phase 0 built most of this. Measured at `a64a024`, the gaps were these:
- **CI blind spots.** CI ignores `docs/*.md`, `docs/decisions/**` and root `*.md`, though
  `npm test` reads REFERENCE.md, EVAL.md and ADRs 0001 and 0003.
- **No eval gate.** Nothing in CI compares the ranking with the shipped pin.
- **Deploys.** Deploy never checks CI. Rollback targets and remote operations are typed by hand,
  and the evidence shows dates and rows wrong or missing.
- **Fragile manual steps.** The `.dev.vars` swap and the scripts' `localhost:8787` defaults.
- **No production schema check.** The full-chain schema snapshot has never been compared with
  production.
- **Mac-only inputs.** The production corpus and NUS's source documents exist only on the Mac.
- **Stale catalogue files.** `catalogue-codes.json` and `prefixes.json` follow the pinned corpus,
  not production. That is B12-open: 162 codes search calls unknown.
- **The refresh is tied to 2026/27.** A new academic year needs code edits: year literals, a fixed
  transcription path, a hand-written overlay keyed by unstable rule ids, and a one-year oracle. It
  is never rehearsed, and CI tests the pinned year rather than the live one.

## Decisions
- **CI always runs.** `ci.yml` has no path filter. Every job starts, and heavy jobs skip by steps
  under one tested diff rule. On `main` that rule diffs against the last green run, and `main`
  runs never cancel each other.
- **The eval gate is a ranking lock.**
  - `eval/ranking-lock.json` holds the per-query hashes of the status and result codes, from the
    eval runner. It covers the dev set filtered, `ng`-stripped and unfiltered, and the eval
    fixture set.
  - `eval-gate` checks it when the eval's inputs or the lock itself change. The inputs include the
    runner's import closure and the lockfile.
  - Changing the lists needs evidence written after the base lock: a holdout `pass` row, a
    count-log row naming a no-look route, or a revert. The holdout stays with the custodian.
  - The lock guards against accidents; it is not a security boundary.
- **Deploys need green CI and leave a trace.**
  - Deploy refuses a commit whose own `CI` and `Findings` runs aren't green.
  - `deploy --preflight` runs every non-D1 check before any D1 write.
  - Each deploy and rollback leaves an annotated `deploy/*` or `rollback/*` tag carrying the
    version id, the data version and the `catalogueKey`.
  - Rollback checks D1's data version and `catalogueKey` with direct reads. `d1:restore` undoes a
    D1 write from a recorded bookmark.
- **Remote work goes through scripts that record it.**
  - `npm run remote` replaces the `.dev.vars` swap.
  - No script has a default URL.
  - Every remote operation writes one uniquely named run record under `docs/evidence/ops/runs/`.
- **One production corpus, in a manifest.** `data/corpus.json` names sha-checked release assets
  and a `current` entry. Ingest, the bundle and every per-corpus file read only that entry. The
  catalogue codes and prefixes become per-corpus files, which closes B12-open, and the guard
  checks D1's catalogue.
- **CI tests the live year.**
  - `sc1` runs over the production corpus and bundle, with the oracle and a department check.
  - `full-corpus` keeps the pinned corpus for the eval.
  - The eval reads pinned copies of both 2026/27 NG files, so the live files can be revised.
- **The year refresh is a procedure.**
  - **Per-year files:** a source manifest, an overlay module and an oracle per year, behind one
    selector.
  - **Rule ids:** a fixed id scheme mapped against last year's, with overlay roles in place of
    literal ids.
  - **The register:** it carries the oracle's former private decisions as rulings.
  - **Extraction:** keeps only the target year's sections.
  - **`year next` and `year check`:** `year next` scaffolds the year; `year check` has a CI mode
    and a `--full` mode, run on the Mac against the sources archive.
  - **Rehearsal:** the CI `rollover` job.
  - **Docs:** a runbook with briefs, write budget, failure paths and the mid-year revision path.
- **Observability:** a monthly account-wide usage report from GraphQL. Workers Logs keep every
  event unless 7-0 finds the volume billed.

## Jacob's answers (2026-11-12)
- **G1, deploys:** Jacob wants pushes to `main` to deploy, but only once CI is green. Workers
  Builds (connecting the repo in the dashboard) deploys on every push, in parallel with GitHub's CI,
  with no option to wait for it, so the repo is not connected there. Instead a GitHub Actions
  `deploy` job runs on `workflow_run` after CI and Findings pass on a `main` commit, and runs
  `npm run deploy` with an account-owned API token scoped to this one Worker (the dashboard's
  "API token for external CI/CD", Workers role Editor: it can upload and deploy this Worker, not
  delete it or touch any other). The deploy guard's D1 read needs D1 access the Worker-scoped token
  lacks: 7-0 settles the narrowest way (the D1 REST query endpoint with D1 read on the one
  database, rather than `wrangler dev --remote`, which binds Vectorize and Workers AI too), and the
  exact permissions go in the runbook before Jacob creates the token. Re-ingest deploys (D1
  writes) stay on the Mac. If the guard can't run in Actions, every deploy stays on the Mac with
  the green-CI refusal, and the lead reports why.
- **G2, year switch:** July, as recommended: switch once NUSMods has the new year and NUS's Sem 1
  list is out; until NUS's Sem 2 list appears, Sem 2 shows last year's Sem 2 list, labelled
  "On NUS's 2026/27 list; NUS hasn't published 2027/28's yet", counted "to confirm", never open.
- **G3, automatic issues:** (a) only: the weekly NUSMods data-change issue and the monthly reminder.
  No daily live check.
- **G4, ranking findings (the lead):** S2, S3, S4 and S6 stay open as known limits; SC5 passed and
  each ranking change costs a holdout look.
- **G5, NUS's source documents:** Jacob asked whether republishing them is a problem. NUS's legal
  notice (https://www.nus.edu.sg/legal-information-notices) says no part of its web content "may
  be reproduced, licensed, sold, published, transmitted ... without the prior written permission
  of the University", and allows saving a copy "solely for your own information, research or
  study". So the sources are not republished in the clear: they go into the repo's releases
  encrypted (a private copy for the project's own use), with the key beside the holdout key. The
  page's short, attributed quotes of NUS's rules are a separate matter and stay as they are.

## Republishing NUSMods data
The production corpus assets republish NUSMods' JSON, as the pinned corpus asset
(`data-2026-2027-20260904`) already does for CI. The repo's MIT licence covers its code, not this
data. The assets are kept only to make builds reproducible, and the README credits NUSMods as the
source. NUS's own documents are not republished in the clear (G5).

## Dissent
None declined. Every objection in the three rounds changed the plan. C3-2 stays open, for Jacob's
G2 answer.

## Consequences
- **New inputs.** Deploys need GitHub's API and the deployer's `gh` login. Hotfixes don't need the
  sources key. A source change does: its `year check --full` record must be committed.
- **CI minutes.** CI runs on every push, `eval-gate` adds a slow path on ranker changes, and
  `rollover` is a new job.
- **ADR 0003 gains two amendments:** the eval's pinned NG files, and the count log's `route`
  column.
- **New release assets:** production corpora and encrypted source archives.
- **Phase 8** inherits REFERENCE.md sections that describe deploy, rollback, operations and the
  yearly refresh as they are.
