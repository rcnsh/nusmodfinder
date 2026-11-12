# 0010: The shortlist lives in the URL and exports from the browser

Status: accepted. The view and its modules are described in [docs/page.md](../page.md).

## Context
Students need a shortlist with primary and backup picks and a running units total, with no
account, that exports with the course description and estimated hours. The data holds NUS's
course description, not a syllabus. The page's users are students changing courses in CourseReg
and next year's applicants, who apply from March on this year's data.

## Decision
- **The list is in the URL:** `pick` and `alt` repeated in rank order, each `CODE.S` or an
  untagged `CODE`; `ay` once, from the first loaded row; `inv` for a Business School or Law
  invitation; `view=shortlist` opens the view. It is page-wide, not per history entry: Back and
  Forward keep it. One history writer makes every `pushState` and `replaceState`, under a budget
  below WebKit's 100 writes in 10 s.
- **The last edited list is kept on the device** (`localStorage`) for "Restore your last
  shortlist" and "Forget this list on this device"; opening someone else's link never overwrites
  it.
- **No CourseReg mode.** Admitted students get NUS's CourseReg rules, quoted and cited, in one box
  and on the rows they affect, with wording that holds at both stages.
- **One order each for picks and backups**, every entry worked out at its own semester.
- **Counting** sorts entries into counted, to confirm with NUS, and not counted with the reason;
  the minimum is never shown as met. Two codes are the same course when both are on the NG list or
  either's preclusion names the other.
- **NUS's application form order** is numbered per semester against 40 units, in exchange mode
  only. Exam overlaps are flagged, never used to drop a course, because the exams are this year's.
- **The maximum is NUS's own words:** "NUS's brochure says at most 23 units a semester, but NUS
  Global's exchange page says 20 (NUS Business School's exchange students: 20). Ask NUS before
  planning more than 20." The two sources disagree, so the page names both.
- **NUS's own conditions are rules, not questions:** its notes on oversubscribed subjects,
  language courses, level 4000 and master-level supply, Business and Law by invitation, and
  Economics, Business and Law after the offer, each quoted word for word and cited. Where two NUS
  sources give different timetable months, the page says "in July or August (the Registrar says
  mid-July)", true to both.
- **`/module/:code` adds** `otherCodes`, `gradingBasis` and a 404's kind (`ng-listed`,
  `catalogue-only`, `unknown`). NG-listed codes with no classes get `data/ng-unscheduled.json`,
  built per corpus like the groups, with NUS's restrictions worked out by `eligibility()`, so they
  read like a row.
- **Exports run in the browser.** The CSV is RFC 4180 with a byte-order mark and a formula guard;
  the PDF is the browser's print of a print-only section. Both hold every entry, grouped by
  semester, with NUS's description labelled "Course description (NUS, via NUSMods)" and NUS's line
  that the full syllabus is on Canvas, and NUSMods' weekly hours with NUS's estimate of 2.5 hours a
  week per unit. The description is never called a syllabus.
- **The site's name and canonical URL** (ADR 0009) title the export and its links.

## Not built, and why
- A second, Excel-only CSV for `;` locales: a hint beside the button and in the file's foot points
  to Data › From Text/CSV.
- "Move all to Sem 2", adding classless NG courses from the "Not this year" line, and the NG
  list's class numbers in the export: beyond what a shortlist needs; class numbers from this year
  would mislead next year's applicants.
- Class times, corequisites and a CourseReg add-and-drop planner.

## Consequences
- `data/ng-unscheduled.json` joins the re-ingest runbook, and `verify --pre-deploy` checks it and
  the reason file's year against D1.
- Exchange-mode correctness is checked over every offered code and every classless NG code, in
  exchange mode with no year of study too (`test/shortlist-oracle.js`). An NUS student's list is
  a plain plan (ADR 0017).
