# 0009: Phase 6 shortlist and export plan

Status: draft, accepted by the lead (2026-11-11) pending Jacob's answers to G1–G5 and the 6-0
design gate. The plan (`docs/plans/phase6.md`) went through twelve critic rounds (frontend and
accessibility; data, export and ops; the product for exchange students), each with fresh
critics given only the draft; the lead stopped the rounds at 12. Round 12 raised nothing
blocking, and its majors were fixed in r13, which has not itself been critiqued. Its §7 logs
every objection and where it landed. The objections declined are listed under Dissent below;
one item is open for the lead (B12-open: 162 catalogue-only codes the search calls unknown).

## Context
SC3 wants a shortlist with primary and backup picks and a running units total, held in the URL
with no account, that exports to CSV and PDF with syllabus text and estimated hours. SC1 (closed
courses never shown as takeable), SC2 and SC8 must keep holding with the shortlist on the page.
The data holds no syllabus, only NUS's course description; `/search` carries no description or
workload; `pick` and `alt` were reserved in Phase 5. The page's users now are Sem 2 2026/27
students changing courses in CourseReg and 2027/28 applicants, who apply from March on the
2026/27 data.

## Decisions
- **The list lives in the URL**: `pick` and `alt` repeated in rank order, each `CODE.S` or an
  untagged `CODE`; `ay` set once from the first loaded row; `inv` for a Business School or Law
  invitation; `view=shortlist` to open the view. The list is page-wide, not per history entry:
  Back and Forward keep it and write it into the entry they reach. One history writer makes
  every `pushState` and `replaceState`, under a budget below WebKit's 100 writes in 10 s.
- **No CourseReg mode.** Admitted students get NUS's CourseReg rules, quoted and cited, in one
  box and on the rows they affect, and wording that holds at both stages (G4).
- **One order each for picks and backups for the year**, every entry shown and worked out at its
  own semester; Move swaps with the neighbour, which keeps focus without re-parenting the
  focused row.
- **Counting** sorts entries into counted, to confirm with NUS, and not counted with the reason;
  the minimum is never shown as met. Two codes are the same course when both are on the NG list
  or either's preclusion names the other, compared only with entries already kept.
- **NUS's application form order** is numbered per semester against 40 units, in exchange mode
  only. Exam overlaps are flagged, never used to drop a course, because the exams are 2026/27's
  (G5 for the full-year case).
- **NUS's own conditions are lead rules, not questions:** its notes on oversubscribed subjects,
  language courses, level 4000 and master-level supply, Business and Law by invitation, and
  Economics, Business and Law after the offer, each quoted word for word and cited.
- **`/module/:code` adds** `otherCodes`, `gradingBasis` and a 404's kind (`ng-listed`,
  `catalogue-only`, `unknown`). The 40 NG-listed codes with no classes get
  `data/ng-unscheduled.json`, built per corpus like the groups, with NUS's restrictions worked
  out by `eligibility()`, so they read like a row. `/facets` gains `offListRules`.
- **Exports run in the browser.** The CSV is RFC 4180 with a byte-order mark and a formula
  guard; the PDF is the browser's print of a print-only section (G1). Both hold every entry,
  grouped by semester, with NUS's description labelled as such and NUSMods' weekly hours.
- **SC1 is checked over every offered code and every classless NG code**, at each semester and
  study level and in browse mode.
- **One code-only deploy**; the shipped-ranker pin moves as ranking-neutral; no holdout look.

## Jacob's answers
_To be added as they come: G1 (what SC3's words mean), G2 (the most you may take), G3 (remember
the list), G4 (students already admitted), G5 (a full-year student's form order, only if 6-0
finds no current source), and the 6-0 mockup._

## Dissent
- **B-7 (round 1):** a second, Excel-only CSV for `;` locales. Declined: beyond SC3's CSV; a
  hint beside the button and in the file's foot points to Data › From Text/CSV.
- **C2-7 (round 2):** a "Move all to Sem 2" button. Declined: each row can be moved, and the
  button is beyond SC3.
- **C3-m3 (round 3):** adding NG-listed courses with no classes from the "Not this year" line.
  Declined: they have no classes to plan, and that is beyond SC3; r9 made such entries read
  correctly when they arrive by link.
- **C9-m5 (round 9):** carrying the NG list's class number into the export. Declined: classes and
  class times are out of Phase 6's scope, and a 2026/27 class number would mislead 2027/28
  applicants.
- **C12-m3 (round 12):** citing the August list dates in the full-year Sem 2 line. Declined as
  a preference, per Jacob's instruction during round 12: the line already says to check with
  NUS, and §1 holds the dates.

## Consequences
- A new data file, built and checked like the groups, joins the re-ingest runbook, and
  `verify --pre-deploy` checks it and both files' year against D1.
- Two spec files join the `ui` job and one the `sc1` job; the `ui` job is sharded if it passes
  15 minutes.
- The year-of-study control and the first screen ask for the year during the exchange, as NUS's
  portal does; R3's year note says the same (its rule is unchanged).
- Class times, corequisites and a CourseReg mode stay out; the description is never called a
  syllabus.
