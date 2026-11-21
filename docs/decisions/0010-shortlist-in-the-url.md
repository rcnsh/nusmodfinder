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

## In the code

**The URL and the device**
- `public/history.js` folds a held or queued replace into the write before it but never folds a
  push, so the entry the student leaves keeps its last replace (an edit, or the detail closed
  before the view opens). A refused write retries with later writes queued behind it, never
  skipping ahead: WebKit throws on the 101st write in 10 s and Chrome drops excess writes
  silently, so a dropped or reordered write would lose a submit or misorder Back.
- `public/list.js` keeps 40 entries because NUS's form takes 40 units, about ten 4-unit courses a
  semester. `parseList()` marks a code seen before applying the caps, so a code dropped at a cap
  stays dropped and a later duplicate can't slip in under it.
- `public/saved.js` wraps every `localStorage` call in try and treats a throw or a missing store
  (Safari's private mode, blocked storage) as no saved copy: the device list is a convenience, so
  a throw means no restore offer, never a broken page. `test/web/saved.node.test.js` runs it
  against a throwing Storage. "Forget this list on this device" removes that copy only, never the
  list in the URL.

**Working the list out** (`public/shortlist.js`)
- Units and hours sum in integer tenths (`tenths`, `fromTenths`), so 2.5 + 1.5 is exactly 4 and
  a list at exactly 40 units isn't marked over. `test/web/shortlist-reference.node.mjs` sums the
  same way.
- `staleRows()` refetches once, with `cache: 'reload'`, any loaded `/module` row whose acad year
  is older than the newest loaded. `/module` answers are browser-cached for 5 minutes, so a list
  loaded across an ingest could mix two years' rows.
- `settleSameCourse()` compares each entry only with entries already kept (counted picks in rank
  order, then to-confirm picks, then backups), because "same course" isn't transitive: comparing
  every pair would drop a course that only shares a code with one already dropped. `flag()`
  checks preclusions between picks only, since a backup a pick precludes is a normal alternative.
- `formOrder()` numbers counted and to-confirm entries per semester, picks then backups, while the
  semester stays within 40 units: an entry that would pass 40 is marked and takes no number, and a
  later one that fits takes the next. Past the 10th, each is marked but keeps its number.
  Duplicates, audition courses and uninvited Business and Law entries take none.
- A Business or Law quota note reads "If you were invited: …" and stays apart from the entry's
  notes, because the quota gives priority to that faculty's own partner universities; it is not a
  chance every exchange student has.
- `APPLICANT_LINES` and `FORM_LINES` rest on NUS's documents: the application guide has a
  prerequisite field but no class choice, and the 10-course caution is from NUS's 2018/19 exchange
  information sheet. The list's date comes from `/facets`' NG list source, never a constant;
  without it no date shows.
- `public/preclusion.js` `names()` reads NUS's text as NUS writes it: a code needs a non-letter
  before it (YSC2216 is not SC2216) and may be glued to a following OR, AND or THEN
  ("ME2134ORmust"); "beginning with CS1010" matches as a prefix; programme codes (0300CS2MJ)
  never match. A branch conditioned on an NUS intake cohort is skipped (exchange students are in
  none), but a "cohort" in a sibling branch doesn't skip it. At `grad`, a branch conditioned on an
  undergraduate degree alone is skipped, while one also naming Graduate Degree Coursework, or a
  later graduate branch, is kept. Each case is a real NUS text in
  `test/web/preclusion.node.test.js`.
- `public/export.js` `plannedSems()` counts a semester only when an entry is placed in it, and the
  title, the file name and the semester sections all come from it, so an export never names a
  semester with nothing planned.

**Tests that don't share the page's code.** Sharing code with the page would let a bug agree with
itself:
- `test/web/rfc4180.node.mjs` is a strict RFC 4180 reader (it refuses bare LF or CR, stray
  quotes, text after a closing quote and a missing final CRLF), so the CSV is read as a
  spreadsheet would read it, not as `public/csv.js` wrote it.
- `test/web/shortlist-reference.node.mjs` re-implements the counting rules over a corpus's own
  columns (allow mask, stored rule ids, groups, `data/ng-reasons.json` kinds). The seeded property
  test runs it over the fixture, and `scripts/live-shortlist.mjs` over production.
- `test/web/shortlist.node.test.js` uses `offListRules` exactly as `/facets` answers them
  (`{ departments, levels }` with levels as digits, `{ faculties }`, or `{}` for rule E). A
  synthetic shape would pass and never match the real rules.
- `test/shortlist-shapes.test.js` runs `answerOf` and `workOut` over the real Worker's `/module`
  and `/facets` answers through `public/api.js`, so a field renamed on either side fails in CI,
  not on the live page.
- `test/ui/pdf-text.mjs` reads Chromium's `page.pdf()` with no dependency, handling only the
  shapes Chromium writes (Flate streams, ToUnicode maps, Type0 and Type3 fonts, no object
  streams); `export.spec.js` checks it against the page's own text. It compares NFKC text with
  whitespace stripped, because PDF readers expand ligatures.

**The live shortlist check**
- `scripts/live-shortlist-plan.mjs` `loadData()` filters `data/catalogue-only.json` by
  `data/corpus.json`'s current catalogue-only codes, though the file is built from them, so a
  stale file never makes the check request a code production doesn't hold. `drawShortlist()` lets
  the to-confirm slot draw a course untaught in its semester, since "to confirm" mostly comes from
  rule R2's "not timetabled in this semester" note.
- `scripts/live-shortlist.mjs` strips `content-encoding`, `content-length` and
  `transfer-encoding` (`WIRE`) before serving a remembered answer: its body is decoded, and those
  headers describe the bytes on the wire, so leaving them makes the browser misread it.
