# Phase 6 plan: shortlist and export (r13, after critic round 12)

Goal (exit): **SC3** is met, and SC1, SC2 and SC8 still hold with a shortlist on the page.
- **SC3:** a shortlist with primary and backup picks and a running units total lives in the URL
  with no account, and exports to CSV and PDF with syllabus text and estimated hours.
- Out of scope: ops (Phase 7, SC9), launch and the name (Phase 8, SC10), class times,
  corequisites (not stored), a CourseReg mode (courses held, added, dropped; G4), and anything
  that needs an account or a server-side store.

This plan changes no code. Every number marked *est.* is an estimate. Every other number comes
from a script over production's catalogue, `.data/cache/2026-2027-moduleInfo.json` (fetched
from api.nusmods.com on 2026-11-04, 6,778 offered modules, the rows D1 holds;
`docs/evidence/phase3/3-0.md:218`) and `data/ng-courses-2026-2027.json`, from the code at
`5a45f30`, or from a cited source. Counts from the pinned 2026-09-04 release asset, which CI
and `test/full` use, are marked "(pinned)".

Rounds 1 to 12 shaped the design (§7). Its main choices, each with the round that forced it:
- **no CourseReg mode.** Admitted students get one box of NUS's CourseReg rules, the same rules
  on the rows they concern, and lines that read true at both stages; a mode is G4 (r7);
- **one order each for picks and backups for the year**, every entry always shown and worked
  out at its own semester; `sem` only sets a new entry's semester and which totals come first
  (r7, r8);
- **the same course**: two codes are counted once when both are on the NG list or either's
  preclusion names the other (r8);
- **NG-listed courses with no classes** get a data file with NUS's restrictions worked out, so
  they read like a row (r9);
- **NUS's form order**: exam overlaps are flagged but never take a course off it, since
  applicants now apply for 2027/28 on 2026/27's exams; Business and Law count once the student
  says NUS Business School or NUS Law invited them (r9);
- **SC1 is checked over every offered code**, not just the NG list (r8);
- **Move and Remove** move the neighbour, announce what they did and keep focus in view (r6,
  r9);
- **the year of study is the year during the exchange**, as NUS's portal asks (r10);
- **NUS's form order only in exchange mode**, and closed entries never knock an open twin off
  it (r10); **numbered per semester**, each against 40 units, since NUS has asked full-year
  students to choose Sem 2 courses later (r11);
- **five questions** for Jacob; NUS's own conditions are lead rules (r7, r8, r12).

## 1. Facts gathered

### What the API answers today
- **`/search`** results (`rowToModule`, `src/modules.js:86-103`) carry `code`, `title`,
  `department`, `faculty`, `credits`, `level`, `semesters`, `ng`, `ngSemesters`, `examDates`,
  `variants` (the group's other codes that pass the filters, `src/search.js:607`), and in
  exchange mode `exchange` (one semester) or `exchangeBySem` (both). **No description, no
  workload, no acad year:** `workload_hours` and `grading_basis` are selected (`RESULT_COLUMNS`)
  but not answered.
- **`/module/:code`** (`handleModule`, `src/modules.js:192-234`) answers one row: `description`,
  `credits`, `department`, `faculty`, `level`, `semesters`, `acad_year`, `workload` as
  `{ lecture, tutorial, lab, project, prep, total }` hours a week, `{ raw }` or `null`
  (`src/workload.js`; all-zero is `null`), `prerequisite`, `preclusion` (NUS's text),
  `exchange` (status and reasons for every semester × study level), `examDates` (`{ sem, date,
  durationMins }`, ISO UTC), `nusmodsUrl`, `prereqCohortOnly`. Not `grading_basis`, though D1
  stores it. One D1 read by primary key; `Cache-Control: public, max-age=300`, 404 `max-age=60`
  with body `{ error, message }`, 5xx `no-store`. Not rate-limited (only `/search` has
  `SEARCH_LIMIT`). Its tests pin its key order (`test/smoke.test.js:104`) and its Server-Timing
  spans (`test/instrument.test.js:117`: exactly `d1` and `total`; repeated `d1` spans merge).
  `seed()` (`test/helpers.js:122`) loads no `catalogue_only` rows.
- **A 404 covers three cases the page can't tell apart:** one of the 40 codes on the 2026/27 NG
  list with no classes in NUSMods this year (23 listed for Sem 1, 19 for Sem 2: 21 for Sem 1
  only, 17 for Sem 2 only, FIN3701B and PL3266 for both; e.g. EE4407, PL3266); a catalogue-only
  code (14,430 in production, 14,359 (pinned); e.g. CS1010J); a code that doesn't exist (CS9999).
  All 40 NG-listed ones are in `catalogue_only` (which holds `title`, `description` and
  `acad_year`, no units), and each has a title, 4 units, faculty, department and a 5-number
  workload in moduleInfo (EE4407 `[2,1,0.5,1.5,5]`); 17 have preclusion text and 16 a
  prerequisite (ESP4403's "must be Year 3 or 4" gives the year note). NUS's restrictions (`eligibility()`, `src/eligibility.js`) close 4 of them
  at some level (PF2102, PF2505 and PF3307 in Sem 1 at grad; GE3257 in Sem 2 at grad); FIN3701B
  is Business; others carry notes (MUA3213's whitelist, ID's `graded`, PF's `quota`). Some have
  a twin with the same title and description (NGN2001D and NGN2001E with NGN2001A–J; FIN3701B
  with FIN3701A; ESP2106 with ESP3106). The pinned asset has 32 such codes, not 40: PL3265 only
  there; EE4438, FIN3701B, GEX1004, ID2120, LSM1303, PH2301, PL3268, SN2278 and TRA2101 only in
  production. `data/groups.json` has the same split and is built per corpus
  (`scripts/build-groups.mjs`: the production file checked against `data/vectors.json`'s data
  version, a fixture file for tests, `--check` to rebuild). `/search` already reads `catalogue_only` for a
  not-offered code (`src/search.js:875`), answering as not offered on any error.
- **Groups:** `/module` doesn't answer a course's other codes; the groups (`data/groups.json`:
  502 groups, 1,549 codes, every member offered; 509 (pinned); ACC1701A–E and ACC1701XA–XD are
  one course) reach the page only as `/search`'s `variants`. Groups are built from identical
  title and description, so a few join different courses (15 "Independent Study" codes across
  departments, 19 UROPs, 38 UTOP codes); the 19 groups with two or more NG members are each one
  course (18 of them preclude each other; NGN2001A–J have no preclusion text). Of the 3,051
  group pairs not both on the NG list, 1,433 have preclusion text in which either names the
  other (1,235 both ways; e.g.
  CS2030 and CS2030S, both at 2026-11-30T09:00Z), 135 of them with one NG code (ACC1701A and
  ACC1701XA). The fixture's groups (`test/fixtures/groups.json`, 21) hold ACC1701XA–XC, CS2030,
  CS2030DE, CS2030S, and GES1034 with GESS1024. After 6A, `src/modules.js` imports the bare
  `groups-data` alias, which the vitest `node` project doesn't resolve; no Node test imports
  `src/modules.js`.
- **The page's fetch:** `createModuleClient` (`public/api.js:121`) keeps one promise per code per
  page and evicts every non-ok answer, a 404 included (`api.js:129`). `getJson` keeps only
  `{ code: body.error, status }` of a non-ok body (`api.js:63-66`), and its 10 s timeout covers
  `/module` too (`api.js:47`).
- **The acad year** reaches the page only inside a 200 `/module` body (`acad_year`; ingest
  refuses mixed years). `public/index.html:25` hard-codes "Academic year 2026/27". The Worker
  bundles `data/ng-reasons.json` (which has `acadYear: "2026-2027"`, built by
  `scripts/build-ng-reasons.mjs`) but not the NG list's codes (`data/ng-courses-<year>.json`,
  whose name carries the year). The fixture and `test/full` use the pinned snapshot, so their
  year is fixed at 2026-2027.

### "Syllabus text": what the corpus holds
- moduleInfo's keys for an offered course: `moduleCode`, `title`, `description`, `moduleCredit`,
  `department`, `faculty`, `workload`, `prerequisite`, `preclusion`, `corequisite` (91 courses,
  16 on the NG list; not stored), `attributes`, `gradingBasisDescription`, `semesterData`.
  **There is no syllabus**: no weekly topics, assessment weights, readings or learning outcomes.
  The only course text is the `description`, NUS's summary paragraph as NUSMods serves it.
- Every offered course has one (0 empty). Over the 1,167 offered codes on the NG list: median
  631 characters, longest 1,950. Over all 6,778: median 612, 90th percentile 791, longest 2,568.
- NUS Global says the detailed descriptions ("syllabi") are on Canvas, open to registered
  students (GRO page, "Official Registration").
- Grading: GESS1025 is the only NG course not "Graded" ("Completed Satisfactory/Unsatisfactory").

### Units, levels and hours
- `credits` is `Number(moduleCredit)` (`scripts/lib.mjs:354`), null if not finite (`""` and
  `null` would become 0; every value today is a numeric string). On the NG list (1,167 offered):
  1,073 courses of 4 units, 73 of 5, 13 of 8, 7 of 2, 1 of 6. Across the catalogue: 59 of 0 units
  and 18 non-integer. The fixture has no null or non-integer credits, and its three 0-unit
  courses are off the NG list, so those cases are tested on synthetic answers.
- `level` is one digit (`levelOf`, `scripts/lib.mjs:166`: CS4212 is 4), so every rule on "level
  4000" tests `level >= 4`. On the NG list: 131 / 331 / 335 / 342 / 28 at levels 1 to 5; offered
  courses run to 6 (383) and 8 (6). AR5221, AR5321 and AR5601 are open in Sem 2 at every
  undergraduate year; CAS5101 is open in Sem 1 at ug4 and grad and closed at ug3
  (`D-grad-levels-closed-exchange`).
- **Hours:** of the 1,165 NG courses with a 5-number workload, 1,080 total exactly 2.5 hours a
  week per unit; 4 total 5.0 a unit (CE3155A, CE3155B, CG2027, CG2028: 2 units, 10 hours a week;
  CG2028's exams sit mid-semester, so likely half-semester courses); 6 total 1.0; 3 are all zero
  (AR2225, LL4032, LL4099; answered `null`). 82 with a listed workload total something other
  than 2.5 hours a unit (e.g. CS3230 lists 9, ID2114 lists 4). **124 list no lecture, tutorial
  or lab hours** but some project or preparation hours (e.g. AH3204 `[0,0,0,6,4]`). MLE3104
  gives a raw string, NHS2092 none.
- **Business, Law, Economics, Psychology on the NG list:** 40 courses of faculty "NUS Business
  School" (all with `quota` and `major` notes: 30 with only those, 6 also with a `semester` note
  in one semester, 4 closed in one semester); 91 of faculty "Law" (all level 4); 22 with an `EC`
  code (25 of department Economics, the 3 others General Education courses: GEC1028, GESS1000,
  GEX1010); codes starting AR 15, CE 11, CS 57, PL 12. 13 Centre for Language Studies courses at
  level 1 (e.g. LAK1201), 12 of them with only a `graded` note.

### NUS's own words
The lead read the GRO page and the brochure on 2026-11-11; critic C re-read them in rounds 4 to
6, and read the other three sources, which 6-0 reads again.
- NUS Global Relations Office, "Incoming Exchange Students"
  (`https://www.nus.edu.sg/gro/global-programmes/student-exchange/incoming-exchangers`):
  - "you will be asked to indicate up to 40 units worth of relevant courses"; "we recommend that
    you select as many relevant courses to better your chances at getting the minimum number of
    12 units per semester in order to be eligible for the Student's Pass"; "Students who do not
    manage to secure a minimum of 12 units will be deemed as unsuccessful applicants";
  - "It is recommended that you rank your compulsory courses among your top three course choices
    so as to increase the chances or securing them";
  - "Courses with clashing class and examination time-table will not be approved"; "Applicants
    are automatically barred from adding courses with clashing timetables and examination
    dates"; "Courses which are not offered to exchange students are automatically excluded from
    the online application portal";
  - "Architecture, Computer Science, Civil Engineering and Economics courses are extremely
    oversubscribed. Students majoring in [them] will be given priority … Students with other
    declared majors are advised against choosing" them; later, "Economics, Psychology and
    Computer Science courses at NUS are extremely oversubscribed";
  - "Business and Law courses are only available to students who are invited by NUS Business
    School and NUS Law respectively to apply for the exchange during the nomination period"
    (the brochure: "Applications for the Business and Law exchange programmes are by invitation
    only"); NUS's CourseReg FAQ calls an exchange student one "nominated by your home
    university";
  - "Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very
    limited supply and are usually NOT available to exchange students. In order to increase the
    chances of securing enough courses, incoming exchange students should consider taking
    courses with course code starting from 1000 to 3000"; "Master level courses are open to
    students coming under master-level exchange agreement only";
  - "Application to take Level 1000 language course - You need to to complete and include this
    form in your application";
  - "Each semester normally includes 13 weeks of instruction"; updates: the exchange course list
    "in March/April", brief course descriptions and the class and examination timetables "in
    July or August"; intakes: "Semester 1 … & Full year (August to May)" apply in March and
    April, results late May; "Semester 2" apply in September, results early November;
  - **CourseReg**, after admission, "in the first two weeks of each semester": "You must maintain
    at least 12 units or three courses per semester"; "You must drop any course that clashes";
    on "Business, Law and Economics courses": "If you are not successful in gaining placements
    into these popular courses at the point of offer, you are not able to add these courses
    during CourseReg" (a rule about the group of courses, not each one: NUS Business School
    makes electives available in CourseReg to the students it pre-enrolled);
    "Transfer of units is entirely at the discretion of your home university"; the Registrar's
    Non-Graduating Office signs a "Learning Agreement or Study Plan";
  - a FAQ text, "The minimum study workload is 12 units (approximately 3 courses), not more than
    20 units" and "A workload of 20 units would typically require … 50 hours of study per week
    over 13 weeks", which critic C found in round 8 only in copies of older NUS brochures that
    still say "MCs", not on the current GRO page;
- NUS Global, "Exchange at NUS" brochure (`https://nus.edu.sg/gro/docs/default-source/prog/sep/
  exchangeatnus.pdf`, "As at 4 Jun 2026"): "select up to [40] units worth of courses in your
  application", "You must be accepted in at least [12] units … before you will receive an offer
  of admission", "You are allowed to read a maximum of [23] units worth of courses per
  semester", "1000–3000: Undergraduate courses; 4000: Honours courses; 5000–6000: Not open to
  exchange students", "For courses that have prerequisites, please provide the syllabi of the
  courses that you have completed", "Please ensure that you have sought your university's
  approval before making any changes to your Study Plan". The text extraction separates the
  numbers from their sentences; 40, 12 and 23 come out in that order.
- Read by critic C, not yet by the lead: the Registrar's NG course list (`ng-courses.pdf`):
  "Course syllabus will be available at Canvas … when semester starts", "For course outlines …
  visit the NUSMods website"; the NG application system's user guide: "Fill in the Class
  Selection, and Equivalent Pre-requisites where required"; NUS Business School's 2026/27
  undergraduate exchange factsheet: "at least 12 Units … may take up to 20 Units", "A 4-Unit
  course typically requires about 10 hours of work per week", "At least 50% of a student's
  total course load must consist of Business School courses".
- Read by critic C in round 7, not yet by the lead (6-0 reads them): GRO, on the Student's Pass,
  "three pre-registered courses (or 12 units)"; on CourseReg, missing the drop deadlines "could
  lead to a Grade 'W' … or 'F' printed on your transcript", and "no particular course can be
  guaranteed by NUS"; GRO's pre-departure slides: courses rejected earlier "would likely be
  unavailable"; the Registrar's course restrictions, rule E: "If the courses cannot be found at
  the Course offerings list, they are not available during application stage but may be
  available during Course registration" (filed as `E-offerings-list`, info only; exchange mode
  hides such courses under Jacob's Q7, ADR 0007), and §2: "If you have not been offered
  Business courses at the point of initial acceptance … you will not be able to add the
  Course"; NUS Business School's incoming FAQ: students are enrolled in three courses at
  admission and add the rest in CourseReg. The data's NG list is dated "01 Sep 2026"
  (`updatedAsAt`), after the March/April update GRO names.
- Read by critic C in round 8, not yet by the lead (6-0 reads them): NUS's CourseReg FAQ for
  non-graduating students (`nus.edu.sg/CourseReg/faqs_non_graduate.html`): "up to 23 Units in one
  course request", above that a "Max Workload Waiver" appeal supported by the home university; a
  course not approved at application can be requested in "Submit Course Requests" or appealed
  as "Unable to secure course"; "Students are not allowed to read courses with any kind of
  timetable clashes"; you can't drop below the minimum; "Only students who have been offered
  Business courses during the application stage will be able to see the courses". NUS Business
  School's factsheet: its exchange students are "pre-enrolled in 3 courses (12 Units) upon
  admission" and "Selected BBA elective courses will be made available" in CourseReg. GRO:
  "Successful Law courses applicants will be contacted by NUS Law directly for the official Law
  courses registration"; "If you did not secure any of the popular courses during the first
  round … please do not repeat your request for any of these courses in subsequent rounds". The
  Registrar's NG course list: "Timetable for the new academic year will be published mid-July".
  Read by critic C in round 11: the Registrar's NG course list, "Enrolment in higher level
  language courses (2XXX and above) will be conditional on the placement test result"; NUS's
  document checklist (March 2026): TOEFL or IELTS for students taking Law courses who come from
  non-English-medium universities; the CourseReg FAQ: "To check if the course is offered to
  Non-Graduating students, refer to the Vacancy Report"; the Registrar's non-graduating
  "Academic Structure & Grading" page and GRO: hours a week only, and a semester of "13 weeks of
  instruction and 2 weeks of examinations".
  Partner universities' guides (USC, Cornell) say the form takes 10 ranked courses; an older
  NUS guide ("General Instructions for Application to NUS Non-Graduating Programmes") says "a
  minimum of 6 modules and up to 10 modules per semester". NUS Science's portal guide (2025):
  the portal asks for "Year of Study during Study Abroad"; restrictions such as "All Level 4000
  courses are only open to 3rd & 4th year Non-Graduating undergraduate students" apply to that
  year, while the page's control today says "Year of study at home" (`public/index.html:84`).
  Three restrictions say off-list courses can't be added later: `4-cee-no-appeal` ("No appeal
  will be accepted for any Level 1000 to Level 4000 courses that are not listed"),
  `4-isem-no-appeal` and `2-biz-no-late-add`, filed as info only (hidden in search under Q7).
- **The maximum:** 23 in the brochure only; the CourseReg FAQ limits one course request to 23
  units and offers a Max Workload Waiver above "the allowed maximum workload" without giving
  it; 20 in the Business School's factsheet, for its own exchange students, in the older FAQ
  text and on some partner universities' pages (UBC, Calgary). Each limits what a student
  takes, not what they list. G2.
- **Full-year applicants (read by critic C in round 10, not yet by the lead):** NUS's AY2018/19
  exchange info sheet: "Full-year exchange students will be informed via email to select
  modules for semester 2 before semester 1 ends", and the course list is updated "mid-March for
  Semester 1 and mid-August for Semester 2"; Edinburgh's 2024 NUS guide: the Sem 2 list comes
  out "end of August"; the Registrar's `ng-courses.pdf` puts the Sem 2 list ahead of Sem 1. No
  current NUS page says either way. GRO's pre-departure slides (AY2018/19): "Select up to 10
  relevant modules". The Registrar's transcript legend: 1 unit is 2.5 hours a week "in a
  regular semester". Business School's factsheet: "During the Online Application, only core BBA
  courses are available"; every nominated student, Business or not, gets an emailed link to
  apply. G5.
- **Who uses the page now:** Sem 2 2026/27 students had their results in early November and
  change courses in CourseReg in January, on the data's own year; Sem 1 and full-year 2027/28
  applicants apply from March, on next year's lists.

### The URL and history
- `pick` and `alt` are reserved: `parseState` keeps every value raw and in order, and every
  `nav.js` transition carries them (`keepReserved`); `act()` (`app.js:581-582`), `checkFrom`
  (`:340`) and `settle` (`:900`) write URLs from `State.pick/alt`, with no `try`. Tests:
  `test/web/state.node.test.js:65-67, 181, 191-196`; `test/ui/history.spec.js:101-104` loads
  `?q=networks&open=CS5562&pick=CS5562`, changes Sem, and expects exactly
  `q=networks&sem=1&pick=CS5562`.
- **`popstate`** (`app.js:780-797`) rebuilds `current` from the entry's URL, runs `settle()` and
  `show()`, and places focus (a detail's button, else `#main`). When it fires, `location` is
  already the destination and `current` still the entry left. Opening and closing a detail on
  Back and Forward happens only inside `show()`'s same-answer branch (`syncDetail`,
  `app.js:542-547`), covered by `history.spec.js:129-185`. `act()` replaces with
  `history.state` only for `open` (`app.js:582`). `show()` re-searches when no answer is on
  screen (errors aren't remembered: `answers` holds ok bodies only, `app.js:555-562`), and its
  side effects include `announce('')` (`:557`), `message()` (`:524, :531`), focusing `#study`
  (`:529`), `checkOtherSemester` (`:473`) and detail-load failures (`:315`). Escape runs
  `act({ type: 'close' })` when `open` is set (`:745`). `settings` turns into a submit when the
  box's text differs from `current.q` (`nav.js:55`). Code links in NUS's text submit from
  anywhere (`:768`).
- `#panel` (the semester segment, year, filters) exists once and moves between the rail and the
  phone's filters dialog (`app.js:686, 698`). `.app :where(ul, ol)` has `list-style: none`
  (`styles.css:84`), which makes WebKit drop the list role.
- **Browser limits (critic A's probes, Chromium 156 and WebKit 27.2):** WebKit refuses the 101st
  history write within 10 s, `pushState` and `replaceState` counted together (`SecurityError`);
  Playwright's Chromium accepted 150 only because Playwright passes
  `--disable-ipc-flooding-protection`, and real Chrome drops excess writes silently. A
  `replaceState` in `pagehide` or `beforeunload` doesn't survive a reload. Moving (`insertBefore`)
  the `<li>` that holds the focused button drops focus to `<body>` in both; moving its neighbour
  keeps it. A blob `<a download>` works under the production CSP even 6 s after the click.
  Reload then Back, and Back across another origin, both fire popstate with `history.state`
  kept. WebKit can't grant clipboard reading. A 268-character link in a 600 px paragraph
  overflows under print media.
- A code is `^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$` (`MODULE_CODE_RE`); the longest offered code is 11
  characters (e.g. LC6009GRSII). `&pick=` plus 11 characters plus `.2` is 19, so 40 entries add
  about 760 characters. The rest is bounded by `q` (≤ 200 characters, up to ~1,800
  percent-encoded) and `faculty` (≤ 60). Cloudflare's URL limit is 16 KB (Workers limits).
- The page live today keeps only `pick` and `alt` of the new names when it settles a URL.

### Exams, preclusions, clashes
- Over the 1,167 offered NG codes, 553 have an exam, in **58** distinct (semester, start) slots;
  counting only the semesters a code is on the NG list for, the busiest slot holds 22. Among
  NG-open codes every clash is an identical start (e.g. CS2030 and CS2113 at 2026-11-30T09:00Z;
  CS3223 and CS3241 at 2026-11-25T05:00Z); none overlaps partially; no duration is null.
- 533 of the 1,167 have preclusion text. A code match with a left boundary and a right boundary
  allowing glued `OR`/`AND`/`THEN` ("ME2134ORmust", CE2134) finds 133 directed NG pairs, 55
  one-way; a plain substring match adds 4 false ones (LSM2107 > SC2216 via `YSC2216`, MA1100 >
  SC2209, PC2031 > SC3211, PC2130 > SC3210). Prefix forms ("any Courses (Modules) beginning
  with CS1010", COS1000; "beginning with EC1101", BSP1703; "beginning with MA", MA1301;
  "beginning with MA2", EC2104) add 189 pairs. Every prefix follows "beginning with"; the only
  bare code-like tokens are programme codes (`0300CS2MJ` in CS2030DE, CS2040DE and CS2100DE;
  `0103EC2MJ`, BSP1703; `0900PNP2MJ`, MUA3224). 100 NG preclusions match their own code by
  prefix (MA2401). Several group pairs name each other (CS2030 and CS2030DE). The undergraduate
  clause appears in either case, sometimes after "(" (PC1101, whose rule is cohort-only; no NG
  text opens with "(" and an undergraduate clause without a cohort condition); 13 open with a clause naming graduate students too (MA4207
  … MLE4231, EE4705). 10 NG texts apply only to NUS intake cohorts; HY2262 has two cohort
  branches; DAO2702X and FIN2704X say "cohort" inside programme rules, and their only code match
  (DAO2702) is off the NG list and in their own group.
- Class times and corequisites are not stored; class clashes can't be checked here.
- 271 NG codes are on the list for both semesters; 129 offered courses are taught only in
  special terms (e.g. AH3550).
- **Note kinds** (`public/explain.js:84-87`): `quota`, `major`, `approval`, `graded`, `letter`,
  `fee` are conditions the student can meet; `semester` (38 NG codes: "NUSMods shows no classes"
  then), `restricted-elsewhere` (9), `year` (R3), `partner`, `audition` (MUA3224, MUT3222: "you
  can't choose it in the normal application") and `unknown` are the ones to ask NUS about. In the
  fixture, CS2030 is on the NG list and CS2030S, in its group, is not; 24–26 of the 126 fixture
  NG codes are closed in both semesters at each study level; GES1034 and GESS1024 are open in
  Sem 1; GE2101 and PF2504 carry a `quota` note.

### Text the exports must carry
- 238 of the 1,167 NG courses' text uses characters outside Latin-1. The self-hosted Plex subsets
  cover curly quotes, en and em dashes, `•`, `…`, `ﬁ` and `˚`; only U+2010, U+2011, U+2015 and
  U+FB03 (23 NG courses; fixture EN3264 and LL4407) fall back to system fonts. pdf.js expands
  ligatures when it extracts text.
- No NG description starts with `=`, `+`, `-` or `@`; 4 catalogue courses' do (SA4101C, SA4105,
  SA4105C, SA4106; none in the fixture). 102 catalogue descriptions contain `"`; none a newline.
- Excel opens a `.csv` with the region's list separator, `;` in much of Europe; a `sep=,` line
  makes Excel ignore the UTF-8 byte-order mark. Data › From Text/CSV takes the first row as the
  column names.

### PDF without a build step or server rendering
| route | on the page | text and accessibility | cost |
|---|---|---|---|
| **print stylesheet + the browser's "Save as PDF"** | 0 kB of library; a few kB of CSS | real text in Plex; Chromium can write a tagged PDF (checked in 6-0); structure from the HTML | static asset, no Worker CPU |
| vendored jsPDF (*est.* 350 kB minified, plus a TTF for the four characters above) | lazy-loaded | untagged; layout and wrapping by hand | static asset |
| vendored pdf-lib (*est.* 500 kB+) | lazy-loaded | untagged; layout by hand | static asset |
| Browser Rendering in the Worker | 0 | tagged | billed per browser second; ruled out by the brief |

Static asset requests are free and use no Worker CPU (Phase 5 5B). The print route gives a print
dialog, not a download: "Save as PDF" in Chrome, Edge and Safari on macOS; on iOS, Share, then
Print, then pinch out. G1 asks whether that counts as "exports to PDF".

### CI and the page today
- Playwright 1.64.1 (Chromium and WebKit) with axe; `page.pdf()` in Chromium only, with `tagged`;
  `page.emulateMedia({ media: 'print' })` in both; `keyboard.down` doesn't repeat.
- `test/ui/headers.spec.js` runs flows under the production CSP (`public/_headers`); printing
  needs no CSP change. `test/ui/mobile.spec.js:156-166` is the only reflow check (320 to 1100 px).
- At ≤ 640px the rail is hidden and the header static (`styles.css:367-394`); "Filters (n)" sits
  inside `<form role="search">` (`index.html:115-124`). At ≥ 641px a card's units sit in their
  own column under the code (`styles.css:243-245, 351`); on a phone in the head row
  (`styles.css:412`). Each card's `h2` holds only its disclosure button (`render.js:212`). The
  dark tokens live in one `@media (prefers-color-scheme: dark)` block. At 390×664, ACC1701XB's
  stamps end about 242 px above the fold (probed).
- The fixture (`test/fixtures/corpus.json`) has 434 modules, 126 on the NG list. `npm test`
  excludes `test/sc1/**`; CI's `sc1` job runs it over the pinned corpus. The `ui` job takes
  10.7–11.6 minutes (the last 12 green runs on `main`) against `timeout-minutes: 20`.
- `docs/REFERENCE.md`'s Cost table says D1 costs "1 per page load".

## 2. The design gate (6-0)
The shortlist is new UI inside design D, so Jacob sees it before it is built. One direction:
D's tokens, type and stamps already set the look. One mockup, both themes, at 1280 and 390×664,
with fixture data, in these states:
1. results with three courses shortlisted, the cards' toggles on and off (pressed shown by a
   filled icon, not colour alone), and the shortlist button (in the rail outside `#panel` on a
   wide screen; on a phone in the row under the search form, outside the search landmark);
2. the shortlist view for Sem 1, 2nd year: 4 picks and 2 backups; one pick with a `quota` note
   (counted, GE2101), one with a `semester` note (to confirm), one closed (its reason, not
   counted), one NG-listed code with no classes this year, one Computer Science pick with NUS's
   note, one Business pick ("only if invited");
3. a full-year student: one list of picks for the year with each row's semester and its number
   in that semester's form order, totals for each semester (Sem 2's first after a Sem change in
   the view), the line that NUS may ask for Sem 2's choices later, a backup whose 2026/27 exam
   overlaps a pick's (flagged), a pick with "Choose Sem 1 or Sem 2", a Sem 1 entry marked past
   40 units, and a Business entry with the Business School checkbox unticked;
4. the print page: page one, a page break, the form order, and the closing sections.

Each passes `npm run contrast` and the 390×664 fold check (state 1 on ACC1701XB with both
stamps, the toggle, and the longest shortlist button label). Jacob approves, or names what to
change; the result goes in ADR 0010.

**Fact checks in 6-0** (a browser, by the lead; nothing on the live Worker):
- the brochure's numbers by eye (4, 10, 40, 12, 23), and the GRO FAQ's maximum;
- the sources only critic C has read (the Registrar's NG course list and course restrictions,
  the application guide, Business School's factsheet and FAQ, GRO's pre-departure slides, GRO's
  Student's Pass and drop-deadline lines);
- how a full-year student's application counts the 40 units, whether the form caps by units or
  by number of courses as well (NUS's slides said 10), whether full-year students still choose
  Sem 2 courses later by email (G5), and whether the portal bars a
  second entry whose exam clashes with one already listed (recorded for the flag's wording);
- PDFs saved from Chrome and Safari (macOS) of the mockup's print page: a structure tree
  (`StructTreeRoot`) present or not, text selectable; whether print started on a second press
  after a slow load still counts as the user's; the file name Safari offers (its `afterprint`
  may fire before the sheet closes). Recorded, not gated.

## 3. Workstreams
| WS | Scope | Branch | Depends on |
|---|---|---|---|
| 6-0 | mockup, fact checks, Jacob's answers | — | critic rounds |
| 6A | `/module/:code` adds `otherCodes`, `gradingBasis` and a 404's kind; `ng-unscheduled.json` | `phase6/module-fields` | — |
| 6B | shortlist state: URL, history, totals and flags | `phase6/state` | — |
| 6C | shortlist UI | `phase6/ui` | 6-0, 6A, 6B |
| 6D | export: CSV and the print page | `phase6/export` | 6C |
| 6E | ship, live checks, red team | — | 6A–6D |

### 6A `/module/:code` answers what the shortlist needs
- **`otherCodes: [code]`:** the course's group members other than itself (`src/group-data.js`),
  `[]` when none. No D1 read.
- **`gradingBasis`:** the stored `grading_basis` column, added to `MODULE_COLUMNS`, answered as
  `gradingBasis` and deleted from the spread row (as `exam_dates` is, `src/modules.js:216`). No
  migration, no row-hash change (the column exists and is hashed already).
- **NG-listed codes with no classes get a data file of their own,** built the way the groups
  are: `scripts/build-ng-unscheduled.mjs --corpus production` writes `data/ng-unscheduled.json`
  from the moduleInfo cache the re-ingest already holds, refused unless its data version is the
  production bundle's in `data/vectors.json` (as `build-groups.mjs` is), and `vectors.mjs build
  --corpus production` rewrites it with the bundle; `--corpus fixture` writes
  `test/fixtures/ng-unscheduled.json` from a small hand-kept source (EE4407, PF2102, PF2505,
  NGN2001D, ESP4403: none an offered row in the fixture), aliased for the Worker tests, the eval
  config (`vitest.eval.config.mjs`) and the UI server as the fixture groups are; `--check`
  rebuilds in memory and fails on a difference. The fixture build matches titles and
  descriptions against `test/fixtures/corpus.json` too, so NGN2001D's `otherCodes` holds
  NGN2001F and NGN2001G. For each NG code with no offered row (40 today)
  it holds `acadYear`, the semesters NUS lists it for, `title`, `description`, `credits`,
  `faculty`, `department`, `level`, `workload` (through `moduleWorkload`, as rows are),
  `prerequisite`, `preclusion`, `gradingBasis`, `otherCodes` (groups-v1, `src/groups.js`, run
  over the offered rows plus the file's codes, so one rule as for offered codes: FIN3701B gets
  FIN3701A, FIN3701C and FIN3701D), and the same `ng_allow` mask and `ng_rules`
  that ingest stores for an offered row, worked out by `eligibility()` with the year's rules
  (so ESP4403's year note is there).
  `ng-reasons.json` gains, from the rules file, the texts of the four info rules about courses
  off the exchange list (`E-offerings-list`, `4-cee-no-appeal`, `4-isem-no-appeal`,
  `2-biz-no-late-add`) with the scope each states (department and levels, or faculty),
  transcribed into the rules file's `info` entries (4-cee's scope is the department "Civil and
  Environmental Engineering", levels 1 to 4, matched on a row's department, never by code
  prefix: of 33 offered GEC codes only one is CEE's); its rebuild test stays and a test checks each scope against
  the restriction's quoted text. The page gets them through `/facets`, which gains
  `offListRules` (`[{ id, text, scope }]`) beside `ngSources` (`app.js:819`); its shape is pinned
  in `test/smoke.test.js`.
- **A 404's kind:** the body adds `kind`: `ng-listed` (a code in that file: its fields, and
  `exchange` built from its mask by the same function `/module` uses for a row, so the page
  treats it like a row with no classes), `catalogue-only` (a `catalogue_only` row; its `title`
  and `description`, so the export carries its text)
  or `unknown`; and `acadYear`, from the file or the `catalogue_only` row, else from
  `ng-reasons.json`. `/search` checks the file before its unknown-code branch (in
  `parseQuery`'s caller, ahead of `src/search.js:875`), because `data/catalogue-codes.json` is
  built from the pinned release and lacks 9 of the 40 (EE4438, FIN3701B, GEX1004, ID2120,
  LSM1303, PH2301, PL3268, SN2278, TRA2101): typing EE4438 says what the shortlist says ("NUS
  lists EE4438 for Sem 2, but NUSMods shows no classes") instead of "There is no course EE4438
  in the NUS catalogue". The 162 production catalogue-only codes missing from that file (e.g.
  AI5206) keep search's unknown-code answer; `/module`'s `catalogue-only` 404 for them says
  "not offered in 2026/27", the better of the two, and the gap is logged for Phase 7's data
  work. A fixture-missing offered NG code (CS3223) is not in the fixture file, so
  it never answers `ng-listed` on the test stack. One D1 read, on a 404 not in the file, timed
  under the existing `d1` span (so Server-Timing keeps its two keys); `unknown` only when the
  table is missing; any other error is a 5xx with `no-store`, never a cached wrong answer.
- **Ops:** `verify --pre-deploy` asserts `ng-reasons.json`'s and `ng-unscheduled.json`'s
  `acadYear` equal D1's `acad_year` (`/admin/verify`'s pre-deploy rows, `verify-core.mjs:112-118`,
  gain `acad_year`: a change to `src/ingest.js` with its test), and that the file's codes are exactly the NG codes without
  a `modules` row in D1; the re-ingest runbook gains both build scripts. Between a re-ingest's D1 step and its
  deploy the old groups sit beside new rows; `otherCodes` is only compared within one
  shortlist, so nothing breaks.
- **Answers from before the deploy, or after a rollback,** lack the new fields: no `otherCodes`
  reads as `[]`, no `gradingBasis` as not shown, a 404 without `kind` takes the `unknown`
  wording, and no `acadYear` leaves `ay` unset.
- **The page's side:** `getJson` passes a non-ok body's fields through as `error.detail`; `createModuleClient` keeps a 404 as final.
- **Tests first:**
  - `test/module-detail.test.js` (fixture groups; catalogue-only rows seeded through `POST
    /admin/catalogue` first): ACC1701XB answers `otherCodes [ACC1701XA, ACC1701XC]`; CS2030S
    `[CS2030, CS2030DE]`; a code in no group `[]`; PLS8002A's `gradingBasis`;
    a catalogue-only code 404s with `catalogue-only` and its title; an NG-listed code without a
    row (EE4407, from the fixture file) with `ng-listed`, its semesters, units, title,
    description, workload, prerequisite and `exchange`; PF2102 at grad closed in Sem 1 by
    `4-be-l1234-grad`; ESP4403 at ug2 with its year note; PLS8002A's `gradingBasis`; an offered
    NG code missing from the fixture (CS3223) never answers `ng-listed`; `CS9999` with `unknown`; a failing catalogue read
    gives a 5xx with `no-store`; every other field byte-identical to before for every fixture
    code;
  - `test/smoke.test.js:104`'s key list gains `gradingBasis` and `otherCodes`;
    `test/instrument.test.js:117` stands, for a 404 too;
  - `test/full` (pinned groups): ACC1701XB's list is ACC1701A–E, XA, XC, XD;
  - a Worker test: a synthetic file code absent from `catalogue-codes.json` typed into
    `/search` answers as NG-listed with no classes, not unknown;
  - `test/ng-unscheduled.node.test.js`: each production entry's `ng_allow` and `ng_rules` equal
    `eligibility()` recomputed in CI from the entry's own title, department, faculty, level,
    prerequisite and listed semesters against the committed rules (no cache needed), so a
    stale mask (PF2102 left open at grad) fails CI; the fixture file is what the build writes from its
    source; every code in the production file is on `ng-courses-<acadYear>.json` for the
    semesters it lists; the "no offered row" check and the rebuild against the moduleInfo
    cache run where the cache exists (the re-ingest machine) and are skipped with a stated
    reason in CI, as the production groups' check is (the pinned corpus has rows for 9 of the
    40);
  - `test/web/api.node.test.js`: a 404's detail passes through; a 404 is kept, a 5xx isn't.
- **Exit:** the tests pass; dev and the eval fixture's rankings byte-identical to pin `8a86bf6`.

### 6B Shortlist state
**The URL.** `pick` (primary) and `alt` (backup), each repeated in rank order, then `ay` and
`view`:
- a value is `CODE.S` (S is 1 or 2) or `CODE` (no semester chosen). Tags are **kept as written**,
  in every state; the page never tags an entry on its own after load. On add, the tag is the
  state's semester if it is 1 or 2, else the one of Sem 1 and Sem 2 the course is open in
  (exchange mode) or taught in (browse mode), else none.
- parsing upper-cases and trims, drops malformed values and other tags, keeps the first of
  duplicates (a code in both lists stays a pick), and keeps at most **20 entries in each tagged
  semester and 40 in all**. The page says how many it dropped; a toggle or a semester button
  that would pass a cap refuses and says so.
- **`ay`** (`2026-2027`, as `acad_year` writes it) is set once, from the first 200 `/module`
  row the list holds; 404s never set or compare it. It is written into the URL with the first
  edit or an export, never on load alone (so `history.spec.js:101-104` stands), and by Copy link
  only if a row has loaded (Copy link never waits). A parsed `ay` is never rewritten. If the
  rows' year differs from `ay`, the view says "Made with 2026/27 courses; showing 2027/28's".
  If loaded 200 rows disagree with each other (an ingest within the cache's 5 minutes), the
  older ones are refetched once with `cache: 'reload'`. Every year the page prints comes from
  the rows, and from `public/year.js` (the header's default, updated by the re-ingest runbook)
  only before any row loads.
- **`inv`** (`biz`, `law`, repeated): the student was invited by NUS Business School or NUS Law
  (6B "Business and Law"). Written only when ticked; kept like the list.
- **`view=shortlist`** opens the shortlist view; `parseState` drops `open` when `view` is set.
  A link opens on the view only if it says so (Copy link always does), so a closed view stays
  closed on reload.

**`State` loses `pick` and `alt`.** The list is page-wide, held apart from `current`, and so is
`ay` and `inv`: "the list" below means `pick`, `alt`, `ay` and `inv`. **One history writer** (`history.js`) makes
every `pushState` and `replaceState` the page makes, for every caller (`act()`, `checkFrom`,
`settle`, `popstate`, edits): it builds the URL from the state and the list (`urlFor(state,
list, path)`), counts its writes over a sliding 10 s, coalesces past 80 of them into one write
300 ms after the last, wraps each in `try`, and on a refusal retries with backoff (1 s, 2 s, 4 s
… up to 10 s). While a push waits for its retry, later writes queue behind it and fold into its
URL, so no submit is dropped and no entry is written out of order. `keepReserved` goes; the
tests at `state.node.test.js:65-67, 191-196` move to the list module.

**History.** Search, filters and details move through history as today, with these rules:
| action | history |
|---|---|
| an edit: add, remove, move, choose a semester | written at once through the writer (`replaceState(history.state, …)`), coalesced only past 80 writes in 10 s; a pending write is flushed before Copy link, each export, on `visibilitychange` to hidden and on `pagehide` (a coalesced write can still be lost by a reload in that window). G3's device copy is written at once. Never calls `show()` |
| `act()` | flushes a pending write first (`current` is still the entry being left), then runs as today |
| Back or Forward (`popstate`) | cancels a pending write without flushing it; parses `location`; keeps the page's list and writes it into the entry it arrived at (through the writer's budget); always syncs the detail (`open`) and the view (`view`), with their focus rules; runs the search if `searchParams(arrived)` differs from `searchParams` of the state before the event. If they are equal, it searches again only when the last answer was a network or server error, never after a 429 (the page keeps the last error's kind beside `shown`) |
| open the view | if this page pushed the open detail's entry (`vnmDetail`), that entry is replaced by the view's, marked as pushed, so closing goes `back()` to the list; else, if a detail is open, the current entry is replaced without `open` and the view pushed. The detail region collapses. The view's entry holds `{ vnmShortlist: true, atOpen: <q and filters> }`. Focus on the view's heading (`tabindex=-1`); no `show()` |
| settings (the rail's, or the phone's filters dialog) while the view is open | replace with `history.state` kept, `view` kept, and `current.q` (never the box's unsubmitted text, so `nav.js:55` doesn't turn it into a submit); the box keeps that text (`applyToForm` leaves the query field alone while the view is shown, `app.js:184`); the search runs for the results, which stay hidden behind the view. The view says one sentence: "Sem 2 first: 12 units picked; Sem 1: 8". While the view is shown, `show()` neither announces nor moves focus (no `#study` focus, `app.js:523-529`), and work started before it opened (a detail's load failure, `checkOtherSemester`) says nothing |
| a submit or a code link from the view | closes the view by a push of the search, the list kept; focus and announcement as today |
| close the view (its button, or Escape) | if q and filters equal `atOpen` and this page pushed the view, `back()`; otherwise replace without `view`, then search by the same rule as `popstate` (a changed search, or a network or server error) and announce the count. Either way, text typed into the box while the view was open stays (`applyToForm` leaves the query field alone when it differs from the `q` the view opened with). Focus goes to the shortlist button that is displayed (the rail's or the phone's) |
| browser Back out of the view | `popstate`'s view branch; focus on the displayed shortlist button |
| browser Forward into the view, or Back into it (after a submit or code link from it) | the view shown; focus on its heading |
| the shortlist button while the view is shown | no history write; focus on the view's heading |
| submit, settings, open, close a detail, "Also as", outside the view | as today; the list kept |

The view is a region of its own in `#main`, shown or hidden by `view` alone, not by `shown`;
while it is shown the results region (cards, intent chips, facets) is `hidden`, and only the
settings and the search form stay.
Links the page renders (`searchHref`, `variantHref`, codes in NUS's text) carry no `pick`,
`alt`, `ay` or `view`: a new tab starts with no list (or offers the remembered one, G3), so two
tabs never fork one list. **Copy link** copies the shortlist link (`pick`, `alt`, `ay` once
known, `inv`, `ng`, `sem`, `study`, `view=shortlist`, no `q`) with `navigator.clipboard.writeText`
called within the click, says "Link copied", and shows the link in a read-only field, selected,
if the call fails.

**`shortlist.js`** (pure): from the entries, the semester being worked out, the study level, and
each code's `/module` answer. **Every entry is worked out at its own semester**, in the view and
the exports alike, and the view always shows every entry; the state's `sem` only sets a new
entry's semester and which semester's totals come first. **Rank** is an
entry's position in its `pick` or `alt` sequence in the URL, one order for the year; **Move up
and Move down** swap an entry with the previous or next entry of the same list in that order,
whatever their semesters.
- **per entry:** list, rank, semester, status at that semester and study level, its number on
  the form or why none, and why it counts or not;
- **counted:** picks open in their semester, or open with only condition notes (`quota`,
  `major`, `approval`, `graded`, `letter`, `fee`), labelled "if NUS accepts you into each";
- **to confirm with NUS:** picks whose notes include `semester`, `restricted-elsewhere`, `year`,
  `partner`, `audition` or an unknown kind: "plus N units to confirm with NUS". An `audition`
  pick says "apply separately: see the note" and gets no number on the form;
- **an NG-listed code with no classes** (a 404 of kind `ng-listed`): worked out like a row from
  its `exchange` at its semester and study level, so NUS's restrictions close it (PF2102 at
  grad) or add notes as for any course; open, it is to confirm, never counted: "NUS lists it for
  Sem 1 in 2026/27, but NUSMods shows no classes: ask NUS". A tag outside the semesters NUS lists
  it for is closed ("not on NUS's exchange list for Sem 2 in 2026/27"). Its semester buttons
  come from those semesters;
- **Business and Law** (faculty "NUS Business School" or "Law"): the row quotes GRO, "Business
  and Law courses are only available to students who are invited by NUS Business School and
  NUS Law respectively to apply for the exchange during the nomination period". When the list
  holds one, the view asks, with two checkboxes, in NUS's words: "Did NUS Business School invite
  you to apply for its exchange programme (an invitation during the nomination period)?" and
  the same for NUS Law (`inv`). Ticking or unticking one says what
  changed: "Business courses counted: Sem 1, 20 units picked". Ticked, that faculty's entries
  are worked out like any course, and its rows say, citing their sources: Business, "NUS
  Business School's exchange students add courses in CourseReg", "During the Online
  Application, only core BBA courses are available", and "At least 50% of a student's total
  course load must consist of Business School courses" (factsheet), and its form number reads
  "Application form, Sem 1: 3, if it's a core BBA course"; Law, "NUS Law registers its exchange students for
  Law courses itself" (GRO), and the checklist's TOEFL or IELTS line for students from
  non-English-medium universities. Unticked, they are to
  confirm, take no form number ("on the form only if invited") and say, in the page's own
  words: "Only for students invited by NUS Business School" (a Law course: "by NUS Law"), "If
  you're not sure whether you were, ask your exchange office", and NUS's CourseReg FAQ quoted:
  "Only students who have been offered Business courses during the application stage will be
  able to see the courses". Their units are left out of the to-confirm sum and shown on a line
  of their own ("plus 8 units only if invited"). Their `quota` note, which gives priority to the Business School's
  faculty-level partners, is shown under that line as "If you were invited: …", so it doesn't
  read as a chance for everyone;
- **not counted, said why:** closed ("not open to exchange students in Sem 1"; off the NG list,
  "not on NUS's 2026/27 exchange course list for Sem 1", with rule E's line from the CourseReg
  box, except where `4-cee-no-appeal`, `4-isem-no-appeal` or `2-biz-no-late-add` covers the
  code, or the code is EC-coded or a Law course: then that rule's own text, or GRO's sentence
  on Business, Law and Economics courses quoted word for word, "If you are not successful in gaining placements into these popular courses at the point of offer, you are not able to add these courses during CourseReg"; if `/facets` failed, so those rules can't be
  read, "ask NUS whether it can be added later" instead of rule E's line); a
  catalogue-only or unknown 404 ("not offered in 2026/27", "no course with this code in
  2026/27"); not loaded or failed
  ("at least"); null `credits`; no semester chosen; taught only in special terms ("this page
  plans Sem 1 and Sem 2"); the same course as a counted pick (below);
- **outside exchange mode** (no study level): a pick counts by `credits` only if its tag is in
  the course's `semesters` ("not taught in Sem 2" otherwise); the total is labelled "exchange
  status not checked";
- **same course**, settled once for the year before any view: two codes in one group
  (`otherCodes`) are the same course when both are on the NG list (whose groups are each one
  course), or when either's preclusion names the other by the preclusion rule below (CS2030 and
  CS2030S); an NG-listed code with no classes uses `otherCodes` and `preclusion` from its file
  (NGN2001G and NGN2001D); either side's `otherCodes` is enough, since an offered code's groups
  never list a code with no classes. Only counted and to-confirm entries take part: a closed
  entry never makes another a duplicate. Picks are settled in two passes: counted picks in rank
  order, then to-confirm picks, each compared only with picks already kept (the relation isn't
  transitive: CS2103, CS2103DE, CS2103R), so the first counted one by rank is kept, else the
  first to-confirm one; the others say "the same course
  as CS2030" and appear in no total, no form number and no flag. A backup that is the same
  course as a kept pick, or as an earlier kept backup, is a duplicate too: a neutral line, no
  number, out of the 40-unit sum, no flag.
  Other group members both count, with "NUSMods lists these with the same title: check they
  are different courses", and are flagged like any other pair;
- **the order for NUS's application form**, in exchange mode only (with no year of study the
  view says "Set your year of study during the exchange to see NUS's form order", and no entry
  has a number): counted and to-confirm entries only, not
  duplicates, `audition` picks or uninvited Business and Law entries. **Each semester has its
  own order** (G5): its picks then its backups, each in the list's rank order, numbered 1, 2, 3
  …, shown as "Application form, Sem 1: 2", so a student planning CourseReg doesn't read it as
  a limit on them. An entry fits while that semester's running units stay at or
  under 40; an entry that would take them past 40 is marked and takes no number ("won't fit in
  NUS's 40 units"), and a later, smaller entry that still fits takes the next number. Past the
  10th numbered entry of a semester each is marked, keeping its number: "NUS has said up to 10
  courses (pre-departure slides): check". The form line, per semester: "Sem 1 on NUS's form: 36
  of 40 units". A full-year list's Sem 2 order carries: "NUS has asked full-year students to
  choose Sem 2 courses later, by email before Sem 1 ends (NUS info sheet, 2018/19): check with
  NUS whether to list them now". Exam overlaps never take a number away: the overlap is flagged
  (below), since the exams are 2026/27's and applicants now apply for 2027/28. The heading says
  "for applicants", and under it: "This order uses NUS's 2026/27 exchange list and exams.
  Applying for 2027/28? NUS publishes Sem 1's list in March or April, Sem 2's later (the
  2026/27 list is dated 1 Sep 2026), and the timetable in mid-July: check each course there.";
- **totals, per semester:** picks' units (counted, then to confirm), and about how many hours a
  week that is at NUS's rate (2.5 hours a week per unit: the Registrar's transcript legend, and
  the brochure's 4 units for about 10 hours), with "NUS states hours a week only; your
  university's own conversion decides credit", and GRO's "Each semester normally includes 13
  weeks of instruction and 2 weeks of examinations", quoted, so an advisor has the semester's
  length without the page doing the sum. When counted or to-confirm
  units include EC-coded courses (as NUS's row notes define Economics here): "Includes 8 units
  of Economics courses", with GRO's sentence on Business, Law and Economics courses quoted word
  for word. When the semester holds a flagged exam overlap: "Picks with
  overlapping 2026/27 exams: NUS approves at most one of each pair". Lines that hold at both
  stages, each cited: "To be admitted, NUS must accept you into at least 12 units in a semester"
  (brochure; GRO: "three pre-registered courses (or 12 units)"); "In CourseReg you must keep at
  least 12 units or three courses" (GRO); G2's maximum, "on the
  courses NUS enrols you in, not the courses you list", flagged when a semester's picks pass 20.
  The page never says the minimum is met: picks are not places. Sums in tenths (2.5 + 1.5 is 4);
- **flags:**
  - **exam overlap**, between any two counted or to-confirm entries in one semester, picks or
    backups (start plus duration; a null duration overlaps only an identical start), skipped
    only when the same-course rule dropped one of them: "CS2030 and CS2113: their 2026/27 exams
    overlap. If they still do in the year you go, NUS won't approve both and its form won't
    take both (GRO). NUS publishes each year's timetable in mid-July." (the year from the
    rows);
  - **preclusion**, between counted or to-confirm picks only (a backup that a pick precludes is
    a normal alternative): "CE2134's preclusions name ME2134", quoting NUS's text, never itself, skipped
    only when the same-course rule dropped one of them. A match is a code with a non-letter
    before it and, after it, a non-alphanumeric, the end, or a glued `OR`, `AND` or `THEN`; or a
    prefix after "beginning with" (with or without "(Modules)"), matched against the start of
    the other pick's code. Programme codes (`0300CS2MJ`) never match. A rule whose every branch is conditioned on an NUS intake cohort is
    skipped; a "cohort" inside a programme rule is not. With `study=grad`, a rule opening (either
    case, after an optional "(") with a clause naming undergraduates alone is skipped; one naming
    "Graduate Degree Coursework" too is kept;
- **NUS's notes on particular picks** (a lead rule: NUS's own cautions, cited, on the row and in
  the exports):
  - a code whose letters are exactly AR, CE, CS or EC (not CEG, CSA or ECA): "NUS says these
    courses are extremely oversubscribed, gives priority to students majoring in them, and
    advises students with other majors against choosing them"; exactly PL (not PLS, PLC, PLB or
    PLM): "NUS says Psychology courses are extremely oversubscribed";
  - an EC code also GRO's sentence on Business, Law and Economics courses, quoted word for
    word: "If you are not successful in gaining placements into these popular courses at the point of offer, you are not able to add these courses during CourseReg";
  - a level-1 Centre for Language Studies course: "NUS needs a separate form in your application
    for a Level 1000 language course"; level 2 or above: "Enrolment in higher level language
    courses (2XXX and above) will be conditional on the placement test result" (the Registrar's
    NG course list);
  - level 4 or above, except Law courses and at `study=grad`: GRO's line in full;
  - level 5 or above and not open at the student's year: "NUS: master-level courses are open
    only to students on a master-level exchange agreement";
- **lines for applicants:** "NUS recommends listing as many relevant courses as you can, up to
  40 units" (GRO); NUS's top-three recommendation; "NUS's form asks, for each course,
  your class choice and the home course that meets its prerequisite" (the application guide);
  GRO's "If you did not secure any of the popular courses during the first round … please do
  not repeat your request for any of these courses in subsequent rounds". Which courses are compulsory is the student's to know;
- **the CourseReg box**, for admitted students: NUS's rules, each quoted and cited, then the
  page's own line, set apart from them:
  - GRO: keep at least 12 units or three courses a semester; drop any course that clashes;
    on Business, Law and Economics courses, "If you are not successful in gaining placements into these popular courses at the point of offer, you are not able to add these courses during CourseReg"; missing the
    drop deadlines "could lead to a Grade 'W' … or 'F' printed on your transcript"; the
    Non-Graduating Office signs a Learning Agreement or Study Plan; "no particular course can be
    guaranteed by NUS";
  - NUS's CourseReg FAQ: a course not approved at application can be requested in "Submit
    Course Requests" or appealed as "Unable to secure course"; "Students are not allowed to read
    courses with any kind of timetable clashes"; you can't drop below the minimum; "up to 23
    Units in one course request", and a Max Workload Waiver above that;
  - the Registrar's restrictions, rule E: courses not on the exchange course list "are not
    available during application stage but may be available during Course registration";
  - NUS's CourseReg FAQ: "To check if the course is offered to Non-Graduating students, refer
    to the Vacancy Report";
  - the brochure: get your home university's approval before changing your study plan;
  - the page: "This page can't see your offer. Your offer and CourseReg show which courses are
    yours."

**Tests first.** Pure tests in `test/web/shortlist.node.test.js` and `test/web/state.node.test.js`
build their `/module` answers from the fixture and `test/fixtures/groups.json` (not by importing
the Worker); history tests in `test/ui/history.spec.js` (its detail tests at `:129-185` stay):
- the URL round trip for every case in §1 (malformed, duplicate, both lists, 21 entries in one
  semester and 41 in all, tags 1, 2, 3 and none, lower case, `ay` absent and different, `view`
  with `open`); sem '' → 1 → '' keeps every tag; `pick=CS5562` stays as written;
- a seeded property test: 500 random shortlists over the fixture, at both semesters and every
  study level, counted and to-confirm totals equal a reference written separately in the test;
  synthetic answers for 0 units, null credits and 2.5 + 1.5;
- Move: `pick=A.1&pick=B.2`, "Move up, B" gives `pick=B.2&pick=A.1` (the URL order);
  `pick=A.1&pick=B.1`, "Move up, B": B numbered 1 on Sem 1's form;
- same course, closed entries: `study=ug2&pick=GES1034.2&alt=GESS1024.1` (GES1034 closed in Sem
  2): GESS1024 numbered 1; `study=ug2&pick=CS2030S.1&alt=CS2030.1`: CS2030 numbered 1;
  NGN2001G.1 then NGN2001D.1, and the reverse, at ug2: NGN2001G (counted) kept either way,
  NGN2001D "the same course", Sem 1 counted 4;
- browse mode: `?pick=CS5562.2&view=shortlist`: no form number, the "set your year" line;
- same course: `pick=CS2030S.1&pick=CS2030.1` at ug2 Sem 1 counts CS2030's 4 units;
  `pick=CS2030.1&pick=CS2030S.1` in browse mode (no study level) counts 4, CS2030S "the same
  course as CS2030", no overlap flag; GES1034.1 then GESS1024.1, and the reverse: the first
  counted, the other "same course"; `pick=CS2030DE.2&pick=GE2101.1&pick=CS2030.1` both open:
  CS2030DE kept, with `sem=1` and with `sem=2`; ACC1701XB.1 then XA.1 at ug2: both to confirm
  (Business), XB kept as first, to confirm 4, counted 0; XA as pick and XB as backup: neutral
  line; ACC1701XA as pick and ACC1701XC as backup: XC a duplicate, unnumbered, out of the sum,
  no flag; EC4660 and HY4660 (synthetic answers, one group, off the NG list, no preclusion
  naming each other, identical exams): both count, with the check line and the overlap flag;
- NG-listed 404s (from the fixture file): EE4407.1 at ug2 to confirm, 4 units, numbered;
  EE4407.2 closed ("not on NUS's exchange list for Sem 2"); PF2102.1 and PF2505.1 at grad
  closed; a synthetic Business 404 detail treated as Business;
- a closed CE2xxx pick off the Sem 2 list (a synthetic answer: the fixture's CE codes are
  CE5316QA and CE6077B) gets `4-cee-no-appeal`'s text, not rule E's; a synthetic ESE2xxx the
  same; a synthetic EC3304 GRO's "can't be added" line;
- `alt=CS2030` untagged with `pick=CS2113.1`: the export question asks for CS2030's semester;
- the form: a closed pick, a duplicate and an `audition` pick (a synthetic answer: the fixture
  has none) get no number; ten 4-unit entries all fit and an eleventh is marked; nine 4-unit
  then a 5-unit (41): the 5-unit marked; nine 4-unit, an 8-unit, then a 4-unit: the 8 marked,
  the last 4 numbered 10 (one semester);
  nine 4-unit picks then two Business entries (synthetic answers): unticked, numbers 1–9, both
  "only if invited", 36 of 40; ticked `inv=biz`, numbers 1–10, the second marked "won't fit";
- exports: `sem=1&study=ug2&pick=CS2113.1&pick=CS2030.2`: the Sem 2 total and CS2030's status
  appear, CS2113 counted in Sem 1;
- per-semester numbers: `study=ug2&pick=CS2030.2&pick=CS2113.1&alt=GE2101.1`: Sem 1 form CS2113
  1, GE2101 2; Sem 2 form CS2030 1, with the full-year line; nine 4-unit Sem 1 picks and three
  Sem 2 picks: no "won't fit"; eleven 2-unit Sem 1 entries: the 11th marked "up to 10";
- the same course is compared only with kept entries: `pick=CS2103.1&pick=CS2103DE.2&pick=CS2103R.1`
  in browse mode (synthetic answers where the fixture lacks them) matches the reference;
- exam overlap (fixture: CS2030, 120 minutes, and CS2113, 90 minutes, both at
  2026-11-30T09:00Z and open at ug2 in Sem 1): CS2030 pick and CS2113 backup, both numbered,
  both flagged, the totals' line; two picks, the same; synthetic answers for a 05:00Z 180-minute exam
  against 06:30Z, adjacent exams, a null duration; a closed entry never flagged;
- preclusion on NUS's texts inline: the 4 false substring pairs (no flag), CE2134 > ME2134 (one
  way), COS1000 and CS1010E, BSP1703 and EC1101E, MA1301 and an MA2 code, EC2104 ("beginning
  with MA2") and an MA2 code, MA2401 alone (no self-match), CS2030DE's `0300CS2MJ` against a
  synthetic CS2040C pick (no flag), CS2030 and CS2030DE (same course, no flag), a pick
  precluding a backup (no flag); at the rule parser: a lower-case undergraduate clause and a
  synthetic text opening "(If undertaking an Undergraduate Degree" skipped at grad, MA4207's
  graduate clause kept at grad, HY2262's cohort branches skipped, DAO2702X's programme rule
  kept;
- NUS's notes: an AR, CE, CS, EC and PL code each get theirs, the EC code also the CourseReg
  line; a synthetic GEC1028 (Economics, not EC), PLS8002A and a synthetic CEG code none; a
  synthetic LAJ2201 the placement-test line; a Law pick and a
  grad student no level-4 line; CAS5101 at ug4 (open) no master-level line, at ug3 (closed) the
  line; a ticked Business entry the 50% and CourseReg lines, an unticked one the "only for
  invited" line;
- `history.spec.js`: add on a later entry, Back, Forward (list unchanged); with coalescing forced
  on (a test hook), two toggles then `goBack()` within 100 ms (the previous q shows; that entry
  keeps its q and holds both edits), and two toggles then a code link (after 1 s the URL's `q`
  matches the screen); open a detail, toggle, Escape (no `open`; `goForward()` re-opens it);
  open the view, change Sem to 2, close (`sem=2` stays, no `view`, the first card's stamp is Sem
  2's, the count said); open the view, change nothing, close by Escape and by browser Back (focus
  on the shortlist button; `goForward()` shows the view, focus on its heading); open a detail,
  open the view, close, `goBack()` (the previous query shows); submit from the view; two edits
  within 300 ms then reload (both survive); a refused push retried with an edit made meanwhile
  (one entry, holding the edit); unsubmitted text in the box, Sem changed in the view (the view
  stays, the box keeps its text); search, a 500, open the view, `goBack()` (it searches again); search, a 429, open the
  view, `goBack()` and Escape (no search); load `?q=networks&open=CS5562&pick=CS5562` and change
  Sem (no `ay` in the URL).
- **Exit:** the tests pass; lint and typecheck.

### 6C Shortlist UI
- **The toggle** on each card and in the detail head: a button "Shortlist" with `aria-pressed`,
  its accessible name "Shortlist, CS3244" (the visible text first); pressed also shows by a
  filled icon (`aria-hidden`), not colour alone. On a card it sits in the head row beside the
  units on a phone, and under the units in the code column at ≥ 641px, so the stamps don't move;
  outside the card's `h2`. On adds the course as the last pick; off removes it from either list.
  Every toggle for a code (its card's and its detail head's) shows the list's state, and every
  edit, from anywhere, updates them all.
  The live region speaks once the added course's row settles, or after 2 s, whichever comes
  first (cards don't fetch `/module`; `app.js:310, :387`): "CS2113 added to your picks: Sem 1,
  12 units picked so far", or, past 2 s, "8 units so far, 1 course still loading". Turning a
  card's toggle off says "CS2113 removed from your backups (3 of 8). Undo", with Undo beside
  the shortlist button until the next edit, restoring its list, rank and semester.
- **The shortlist button:** in the rail's `<aside>`, outside `#panel` (so it never moves into the
  filters dialog), on a wide screen; on a phone in the row under the search form, outside the
  search landmark. Its text wraps (`white-space: normal`; `.btn` has `nowrap`, `styles.css:194`):
  "Your shortlist" on the first line (not "Shortlist", the cards' toggles' word, so a voice
  command "click Shortlist" doesn't match it), "Sem 1: 12 units picked" (full year: "Sem 1: 12 ·
  Sem 2: 16 units picked") under it, inside the rail's 210–236 px. It opens the view.
- **The view:** a region in `#main` with its own heading, then its actions ("Copy link",
  "Download CSV", "Print or save as PDF" with a one-line hint for phones), so a long list never
  puts them 200 Tab stops away; then, when the list holds a Business or Law entry, the
  invitation checkboxes (6B). "Primary picks" and "Backups", each an
  `<ol role="list">` (WebKit drops the role under `list-style: none`) in rank order for the year,
  each row showing its semester. A row: its number on the form (or why none), semester, code,
  title, units, department, level, the exchange stamp and every note, NUS's notes on it, "2026/27
  exam" with date and length, hours a week as NUSMods lists them, grading when not "Graded", its
  flags, and buttons named with their visible text first: "Move up, CS3244", "Move down,
  CS3244", "Make backup, CS3244" or "Make primary, CS3244", "Move to Sem 2, CS3244" (or "Sem 1"
  and "Sem 2" when none is chosen), "Remove, CS3244". Move, Make and Remove are drawn at once for
  every row, loaded or not, and never removed by a row arriving; only the semester buttons wait
  for the row, and are drawn for the semesters the course is taught in or, in exchange mode,
  on NUS's list for (ACC1701XB: listed for both, taught in Sem 2; an NG-listed 404: the
  semesters NUS lists it for; any other 404: none). A semester button keeps its element when
  pressed (the row doesn't move: one order for the year) and changes its text ("Move to Sem
  1"); on an untagged row the pressed one stays and the other is removed, so focus stays; if
  the course is taught in only that semester (CS5562, Sem 2), the pressed button becomes
  `aria-disabled` "Sem 2 chosen" rather than offering an impossible move. No drag, no radios. Under the lists: each
  semester's totals and every line of what isn't counted, the form line and the lines for
  applicants, the CourseReg box, "Class times and corequisites aren't checked here: see each
  course on NUSMods", "NUS posts each course's full syllabus on Canvas when the semester starts;
  the text here is NUS's course description" (the Registrar's NG course list), NUS's request for
  the syllabi of your own prerequisite courses, and (G3) "Forget this list".
- **Rows load** on page load when the list has entries, four at a time, through the shared
  client. Each arriving row updates its own element in place, keyed by entry; totals, numbers,
  marks and flags update as text; no control is rebuilt by a row arriving. After "Try again",
  focus goes to that row's first control and the live region says how it ended: "CS3244
  loaded", "CS9999: no course with this code in 2026/27", or "CS3244 still could not be
  loaded".
  Progress is announced once ("Loading 12 courses") and once more when done or failed, only while
  the view is shown, and the "done" sentence is skipped if an edit was announced in the last
  second (one polite live region would overwrite it). The print fonts start loading when the view opens.
- **Closed and not on offer** (SC1, D4): a closed pick stays where the student put it, with its
  stamp ("Not open in Sem 1") and its own reasons (`hiddenCodeLine`), counted in no total, never
  shown as takeable. A 404 reads as its kind says, with its title when it has one, and keeps
  Move, Make and Remove; an NG-listed one is not called closed.
- **Focus and announcements:** the move buttons are never `disabled`: at an end they carry
  `aria-disabled="true"`, do nothing and say "CS3244 is already first". Move up and Move down
  move the neighbouring row, never the focused one, so focus stays; the page then calls
  `scrollIntoView({ block: 'nearest' })` on the focused control (at the top of the page,
  browsers don't anchor the scroll: probed, the button moved from 441 px to 1,100 px at
  390×664) and says "CS3244 moved up: pick 2 of 6, number 2 on the form". Every edit says what
  it did: "CS3244 removed: Sem 1, 8 units picked. Undo is at the top of the list", "CS3244 is
  now a backup", "CS3244 moved to Sem 2". Make backup and Make primary move the row itself, so
  the page then focuses the row's same control in its new place and sets the live region's
  text after the focus moves; semester buttons keep their element (above). After Remove: the next row's Remove in the same
  list, else the previous row's; if that list is now empty, its heading; if the whole list is
  empty, the view's heading. Remove puts "CS3244 removed. Undo" at the top of the view until
  the next edit; Undo puts it back in its place and focuses its row. "Forget this list on this
  device" clears only the device copy (G3), never the list in the URL. After it, the view's
  heading; after G3's restore,
  the view's heading (it opens the view). Announcements set after a focus move are checked by
  `textContent` only; whether a screen reader speaks them is not tested (§4, risks). Every
  heading that can take focus has
  `tabindex="-1"`. A refused move (a full semester) keeps focus and says why. Each of these
  focus moves is followed by the same `scrollIntoView({ block: 'nearest' })`.
- **Before an export**, a browse-mode list, or one with an untagged entry (pick or backup) that
  can take a semester, gets a question first, rendered right under the actions row; pressing
  Download CSV or Print focuses its heading and says "Two questions before your download". It
  asks the semester and "your year of study during the exchange
  at NUS", which turns on exchange mode (`ng=1`; `study` only survives with it, `app.js:273`,
  `state.js:96`), as the question says (the view's own controls,
  with their own names and ids, applied through `act({ type: 'settings' })`, focus kept on the
  question: while the view is shown `show()` moves no focus, so an empty year never sends focus
  to the rail's `#study`), and Sem 1 or Sem 2 for each such entry. Answers apply on change, but
  the export starts only from the question's own "Download CSV" or "Print or save as PDF"
  button, never from a change (arrowing through the year radios checks each one). Entries that
  can't take a
  semester (taught only in special terms, or a catalogue-only or unknown 404) are exempt and
  exported in their own section. No other unchecked export: Ctrl+P prints the shortlist only
  once the question is answered or not needed (6D).
- **The year control** in the rail and the phone's dialog, and the first screen's question,
  hint and error (`index.html:50`, `app.js:656`), and the two notes that say "at your home
  university" (`src/year-note.js:121`, `public/detail.js:151`), are relabelled "Year of study
  during your exchange", the year NUS's portal asks for and its restrictions use; `setup.spec.js` and the
  aria snapshots are updated on purpose.
- **G3's restore offer:** on the first screen it sits under the set-up's questions; on results,
  above the list. Restoring writes the list, leaves the first screen and opens the view.
- **Tests first** (`test/ui/shortlist.spec.js`, and additions to `a11y`, `keyboard`, `live`,
  `aria`, `fold`, `mobile`, `history`, `headers`):
  - add three from results, then reload, Back, Forward and a fresh context (no storage) show the
    same lists; while `/search` answers 429, five edits and opening and closing the view send no
    search;
  - every row control by keyboard at 1280 and 390×664, `document.activeElement` asserted after
    each Move, Make, semester move and Remove at both ends of each list and in the middle, on a
    full-year list (`pick=CS2113.1&pick=CS2030.2&pick=GE2101.1`) before and after a Sem change
    in the view, after the last Remove, after Try again (succeeding, and answering 404), and
    after opening and closing the view (its button, Escape, browser Back), after Back into the
    view from a submit, after pressing the shortlist button with the view shown, after Forget
    and after Restore, in both browsers; after each, the focused control `toBeInViewport()` and
    not covered (as `keyboard.spec.js:6-9` checks), including Move down on the first row with
    the page at the top at 390×664;
  - rows arriving keep focus: `/module` held for later codes, focus on a held row's "Move down",
    the route released as a 200 and, on `?pick=CS2113.1&pick=CS9999.1&view=shortlist`, as a 404:
    `document.activeElement` unchanged, in both browsers;
  - the export question in a fresh context with no saved year: choosing a year keeps focus in
    the question; from `?pick=CS5562.2&view=shortlist` (browse mode), pressing Download CSV
    focuses the question's heading (in view), arrowing through the year radios starts no
    download and no `print`, and the question's own Download CSV then downloads and the URL
    shows `ng=1&study=ug2`;
  - the card's and the detail head's toggles for CS3244 agree after either is pressed, and after
    Remove in the view;
  - adding from a card with `/module` held: once the route is released, `#live` holds the total
    including the course; held past 2 s, the loading sentence;
  - `?pick=CS5562&view=shortlist`, "Sem 2, CS5562": focus stays on the now `aria-disabled`
    button;
  - type in the box with the view open, close it by Escape and by Back: the typed text stays;
  - focus and in-view checks drive real key or click input, never `focus()` from `evaluate`
    (Playwright WebKit doesn't scroll for a programmatic focus without user input: probed);
  - the live sentences, including after Move up, Move down, Make backup and Remove; none from a
    search while the view is shown, but the view's own sentence after a Sem change in it; a link with `q` and picks announces the count, not row progress;
  - Copy link through a `writeText` stub (`addInitScript`), asserted called within the click, and
    the fallback field when it rejects;
  - axe (every rule, the AA bar) on states 1–3, the empty view, the export question, a failed
    row (intercepted), the Copy link fallback field (labelled "Shortlist link"), the
    loading and "press again" states, both themes, both widths;
  - the fold check with toggles, the longest shortlist button label and the restore offer
    shown; the 320 px reflow loop (`mobile.spec.js`) at every width over the view with
    LC6009GRSII's row, the fallback field, and results with toggles and the longest label
    ("Sem 1: 22.5 units · Sem 2: 21.5 units"); the rail button's right edge within the rail's
    at 641, 900 and 1280 px;
  - Escape with the phone's filters dialog open over the view closes only the dialog
    (`app.js:745`'s guard kept), at 390×664;
  - Remove then Undo restores the entry in place and its focus;
  - a closed pick and each 404 kind (a catalogue-only code, an NG-listed code without a row,
    CS9999) from a hand-built link; `?ng=1&study=ug2&pick=CS9999` downloads with that entry in
    its own section, and `?pick=CS9999` (browse mode) asks the export question first;
  - `replaceState` and `pushState` wrapped by `addInitScript` to throw the next N calls: the URL
    catches up after the retry and equals the screen; 150 edits in 5 s make no more history
    writes than the writer's budget (counted), and the URL equals the screen once they stop.
- **SC1 over the shortlist:** `test/sc1` runs `shortlist.js` against the SC1 oracle for every
  offered code (6,771 pinned, NG-listed or not, as `test/sc1/paths.test.js` does) and every
  code with no classes (built in memory from the pinned corpus, as the pinned groups are) ×
  Sem 1 and Sem 2 × each study level, and in browse mode (no study level: no off-list code gets
  a form number): every closed case is not counted, has no form number and carries its
  stamp. A fixture version over all 434 fixture modules lives in the `workers` project outside
  `test/sc1`, so `npm test` runs it; one Playwright sample.
- **Exit:** the specs pass in both browsers; the aria snapshots updated on purpose; the `ui` job's
  time measured, and sharded across two runners if it passes 15 minutes.

### 6D Export
Both exports hold every entry, built from the same rows, each entry worked out at its own
semester, as in the view:
- **Head:** "Courses planned for Sem 1 (or Sem 1 and Sem 2), based on NUS's 2026/27 courses,
  exams and exchange list" (the rows' year); "Year of study during the exchange: 3"; "Made on 11 Nov 2026"; the
  shortlist link (printed with `overflow-wrap: anywhere`); "For a later year, check that year's:
  NUS publishes the exchange course list in March or April and updates it later (this one is
  dated 1 Sep 2026), and publishes the course descriptions and exam timetable in July or August
  (NUS Global)."
- **By semester, Sem 1 then Sem 2; in each, primary picks then backups, in rank order:** for
  each, its number on that semester's form
  (or why none, or the 40-unit mark), list and rank, semester, code, title, units, department,
  faculty, level from its digit ("Level 1000–3000, undergraduate" and "Level 4000, Honours", as
  the brochure puts it; "Level 5000 and above, graduate" for the rest, as the Registrar calls
  them), grading when not "Graded", whether it counts and why, exchange status in its semester
  with every note in full and its source and date, NUS's notes on it, "2026/27 exam" (Singapore
  time, length), "no final exam listed", or, for an NG-listed course with no classes, "exam
  timetable not published in NUSMods", **NUSMods' workload as listed** (lecture, tutorial,
  lab, project and preparation hours a week, each labelled; when lecture, tutorial and lab are
  all 0, "NUSMods lists no lecture, tutorial or lab hours"; or "not listed", or NUS's raw text),
  **estimated study time** (G1): "about 10 hours a week (NUS's rate: 2.5 hours a week per
  unit)", with "NUSMods lists 9 hours a week for this course" where its weekly total differs,
  and "NUS states hours a week only; your university's own conversion decides credit"; "Course description (NUS, via NUSMods)" (G1); prerequisite and preclusion as NUS
  states them; its flags; the NUSMods link.
- **Per semester:** the units picked (counted, then to confirm, then only if invited), the
  hours a week at NUS's rate, GRO's 13 weeks of instruction and 2 of examinations,
  and NUS's minimum and maximum lines.
- **Then "Closed, or not on NUS's exchange list, in that semester":** closed entries, each with
  the same block and its reasons, out of the counts and the form. Entries closed because they
  aren't on NUS's exchange course list are said to be so, with rule E's line ("not available
  during application stage but may be available during Course registration", the Registrar),
  or, where a no-appeal rule, an EC code or the Law faculty applies, that rule's text or GRO's
  sentence on Business, Law and Economics courses, quoted word for word.
- **Then "Not placed in a semester":** entries taught only in special terms, catalogue-only and
  unknown 404s with their kind's line and title, and any entry still untagged, out of the
  counts.
- **Foot:** the form line and the lines for applicants; the CourseReg box; "NUS posts each
  course's full syllabus on Canvas when the semester starts; the text here is NUS's course
  description" (the Registrar's NG course list); "Transfer of units is
  entirely at the discretion of your home university" (GRO); the NG list's and restrictions'
  "updated as at" dates ("date unavailable" if `/facets` failed; then an off-list closed entry
  says "not on NUS's exchange list for Sem 1: ask NUS whether it can be added later" instead of
  rule E's line, since the department rules that contradict it couldn't be read); "Class times and corequisites
  aren't checked here"; NUS's request for your prerequisite courses' syllabi; "Unofficial. Check
  with NUS before you register." The CSV's foot also carries the Excel hint below.
- **File name:** from the semesters present: `exchange-shortlist-sem1-2026-27-courses.csv`,
  `-sem1-sem2-` for both, no semester part when no entry has one
  (`exchange-shortlist-2026-27-courses.csv`); the year from the rows, else a 404's `acadYear`,
  else `public/year.js`. The same stem for the PDF's title.

**CSV** (`csv.js`, pure; a Blob, an `<a download>`, the URL revoked a minute later):
- the column header is the first row, then one row per entry; the head's, totals' and foot's
  lines follow as label/value rows after a separator row of empty fields; every row, the
  separator included, has the header's field count.
- RFC 4180: every field quoted, `"` doubled, CRLF line ends; UTF-8 with a byte-order mark; a
  field starting with `=`, `+`, `-`, `@`, tab or CR gets a leading `'` (OWASP's CSV injection
  advice).
- Beside the button: "Excel shows one column? Use Data › From Text/CSV."

**PDF** (G1): a print stylesheet and a print-only section built eagerly from the rows whenever
they or the list change, gated by a class the CSS reads, `display: none` on screen (screen
readers skip it), light theme always (the dark tokens undone under `@media print`), no meaning in
background colour, links printed as text with `overflow-wrap: anywhere`, no `hyphens: auto`,
`break-inside: avoid` and `break-after: avoid` on each course's head. Under print the grid
ancestors (`.app`, `.layout`, `main`; `styles.css:183, :350`) are reset to `display: block`, or
the section would print in the rail's 210 px column once the rail is hidden (probed: 26 pages
for 40 courses against 10). The print class is derived from state (view shown, every row
settled, the export question answered or not needed), not set and cleared around `print()`;
`afterprint` only restores the title.
- Rows and print fonts load when the view opens, so the buttons act at once on the click.
  Pressed before every row is in, either button keeps its name and a line it points to with
  `aria-describedby` says "Loading 7 of 12 courses", then "Ready: press again to download" (or
  "to print"), also said in the live region, so the browser sees the user's own click and a
  voice command naming the button still works. "Print or
  save as PDF" sets `document.title` to the file name and calls `print()`. A failed row prints "Details could not be loaded".
- A print the browser starts itself (Ctrl+P) prints the shortlist only from the view, once every
  row is settled (loaded, failed or a 404) and the export question is answered or not needed;
  otherwise it prints the screen. `beforeprint` sets the title.
- **Tests first:**
  - `test/web/csv.node.test.js`: quoting, CRLF, the BOM, the header first, padding, the formula
    guard on SA4101C's text (inline), curly quotes and `ﬃ` round-trip, a null, zero, raw and
    no-lecture workload, no exam, an unpublished exam, 0 units, an untagged backup in "Not
    placed", a closed course in its section (an off-list one with
    rule E's line), special-term-only and 404 entries in theirs, the Canvas line in the foot, the
    file name with no semester part;
  - `test/ui/export.spec.js`: the download in both browsers under the production CSP, parsed back
    by a strict RFC 4180 reader in the test, over 7 links covering all 126 fixture NG codes, in
    exchange mode at ug2 and at grad, plus the fixture file's codes: every course has its
    description and workload (or the not-listed text) equal to `/module`'s answer or 404
    detail, and every closed one its reasons;
  - `window.print` stubbed by `addInitScript`: called on the click (or the second press after a
    slowed load) only with every description in the section, the title set; a browse-mode
    list's Ctrl+P (`beforeprint` dispatched) before the export question prints the screen;
  - with `/module` held, the first Download CSV press downloads nothing and the second, once
    rows settle, downloads, in both browsers;
  - Chromium `page.pdf({ tagged: true, format: 'A4', margin: 10 mm each side })` of the print
    view, a known 40-entry list printing in at most 14 pages, text extracted by `pdfjs-dist` (a
    pinned dev dependency, tests only), both sides NFKC-normalised with whitespace stripped,
    holding every description, workload, status and the shortlist link; EN3264 and LL4407 named,
    and the CI image's fallback font for U+2010 and U+2015 confirmed;
  - under `emulateMedia({ media: 'print' })` with the shortlist's print class on, every box with
    a non-zero size lies inside the print section (no header, rail, results or footer), the
    section is at least 95% of the content width at a 718 px viewport (A4 less 10 mm margins),
    and the extracted PDF text starts with the head's first line;
  - under `emulateMedia({ media: 'print' })` with `colorScheme: 'dark'`, with and without the
    print class (Ctrl+P's screen path; the dark tokens are undone for the whole page under
    `@media print`), the computed text colour of every visible text element checked against
    white paper at 4.5:1 (axe
    measures against the CSS ground, which paper drops); axe there for the structural rules; a
    WebKit print-media screenshot for the evidence.
- **Exit:** the tests pass; the 6-0 PDF fact check recorded.

### 6E Ship, live checks, red team
- **Order:** one code-only deploy (6A–6D together); rollback is `wrangler rollback` alone. A
  rolled-back page keeps `pick` and `alt` but drops `ay`, `inv` and `view` from a link it
  settles;
  accepted and noted in the runbook. 6A touches `src/` and `data/`, so the ship moves
  `SHIPPED_BASELINE` with a "ranking-neutral" line (dev and the eval fixture identical), and the
  custodian stores its holdout run with `--store-only` and counts differing lists (expected 0),
  as Phase 5's ships did. No look.
- **Live checks** (`scripts/p6-live.mjs`, built like `p5-live.mjs`): it fetches every answer the
  check needs first, one call in flight and at most one every 4 s, each logged in
  `requests.tsv`; then Playwright loads the page and fulfils its `/module` and `/facets` calls
  from that memory, shared by the Chromium and WebKit contexts, so the page's 10 s timeout never
  fires and no call is made twice. A link with 6 picks and 2 backups (8 `/module`, 1 `/facets`):
  the totals equal the independent reference over production's rows and match the CSV; the CSV
  downloads; Chromium's PDF holds every description; axe and the fold check on the view; one 404
  code of each kind (3 more calls).
- **Red team** (fresh contexts, never this plan), on the live page through Playwright:
  - a Sem 2 2026/27 student, admitted, planning CourseReg changes, exports both files;
  - a full-year 2027/28 applicant builds a list across two semesters on a 390px phone, keyboard
    only, ranking a Sem 2 course first, switching Sem 1 and Sem 2 while browsing, and says what
    the page tells them about listing Sem 2 courses;
  - a home-university advisor gets only the copied link and the PDF, and answers from them
    alone: which courses in what order for NUS's form, their department and level, units and
    study time per semester, what each course covers, whether each is open to the student (yes /
    yes if / no / ask NUS), and which year's courses and exams it rests on;
  - expected answers fixed before the run from the SC1 oracle over production-normalised modules
    (as `p5-live --corpus production` does; pinned and production differ on 10 NG codes) and
    Phase 5's table with rows added for Business and Law ("yes if invited, or already given"),
    `audition` ("ask NUS: apply separately") and an NG-listed 404 ("ask NUS"); the live totals
    checked against the test's independent reference; every disagreement classified as a page
    defect (fixed, re-run), a source ambiguity (Jacob rules) or a persona error. Exit needs zero
    page defects open.

## 4. Cost, ops and risks
- **D1:** one read per `/module` call, plus one on a 404 not in `ng-unscheduled.json`; a full-year list of 40 entries costs 40
  reads per cold load, then the browser cache (5 minutes; a 404 for 1). Paid includes 25 billion
  reads a month. No writes, migration, re-ingest or data-version change.
- **Workers:** one request per `/module` call (Paid includes 10M a month). Exports run in the
  browser; static assets are free.
- **CI:** two spec files in the `ui` job and one in `sc1`; the `ui` job is already 11–12
  minutes, so its time is measured in 6C and the job sharded if it passes 15. `pdfjs-dist` as a
  dev dependency.
- **Holdout:** no look. The pin moves ranking-neutral with the ship.
- **Risks:**
  - print output differs by browser; only Chromium's is checked as a PDF, WebKit's by
    screenshot; iOS's print path is untested on a phone;
  - a shortlist lives in its URL; without the link (or G3) it is lost;
  - a later year's courses, exams and NG list differ: labelled with the data's year and NUS's
    update months, not solved;
  - the description is a summary, not a syllabus;
  - corequisites (16 NG courses) and class clashes are not checked; said in the view and exports;
  - admitted students get NUS's CourseReg rules but no CourseReg mode (G4);
  - a rollback drops `ay`, `inv` and `view` from links it settles;
  - live-region sentences are checked as text, not as speech (the VoiceOver walkthrough was
    dropped in Phase 5);
  - the full-year form order rests on a 2018/19 NUS sheet until 6-0 finds a current source.

## 5. Exit criteria
- SC3, measured: lists, ranks, semesters, `ay` and `view` round-trip through the URL, reload,
  Back, Forward and a fresh context with no storage; the totals equal the reference over 500
  random shortlists and on the live link; the CSV and the PDF carry every course's description
  and its workload or the not-listed text, and the study-time estimate, in CI and once live.
- SC1 holds over the shortlist for every offered code (`test/sc1`). SC2 and SC8 hold: axe zero
  violations on the new states, the keyboard, live-region, reflow and fold specs.
- 6A shipped; pin moved ranking-neutral; 0 holdout lists differing.
- The red team: zero page defects open.
- `docs/REFERENCE.md` (the technical README since ADR 0009: "The page", "Cost", "Re-ingesting", "Known limitations"; its VoiceOver line corrected
  to Jacob's 2026-11-11 answer), `docs/PLAN.md` and the vault page describe the shortlist as it
  is.

## 6. Gate questions for Jacob
Lead rules, not questions, because NUS's own text settles them and the page asks for no new
control: NUS's cited notes on particular picks (oversubscribed subjects, the level-1000 language
form, level 4000 and master-level supply, Economics, Business and Law after admission);
Business and Law's "only if invited"; one ranked backup list, since NUS's application is one
ranked list (NUS Global; NUS Science's portal guide: rank decides priority); and the warnings
(the same course twice, a pick whose preclusions name another pick, exams that overlap), since
the first two double-count units and NUS refuses clashing exams. Exam overlaps are flagged,
never used to drop a course from the form order, because the exams are 2026/27's and
applicants now apply for 2027/28. Asking whether NUS Business School or NUS Law invited the
student is a lead rule too: NUS's own condition, asked only when the list holds such a course.
- **G1. What SC3's words mean.** SC3 asks for "syllabus text", "estimated hours" and an export
  "to PDF". Is each met as follows? *Recommended: yes to all three.*
  - *Syllabus text:* there is no syllabus in the data, only each course's description (about
    630 characters, NUS's text as NUSMods serves it). Export it as "Course description (NUS,
    via NUSMods)", with NUS's line that the full syllabus is on Canvas when the semester
    starts. Calling it a syllabus would mislead a home university; NUS's own course list sends
    students to NUSMods for course outlines.
  - *Estimated hours:* NUSMods' weekly hours as listed (lecture, tutorial, lab, project,
    preparation), and about how many hours a week the course takes at NUS's rate of 2.5 hours a
    week per unit (4 units, about 10 hours), with "NUS states hours a week only; your
    university's own conversion decides credit", and GRO's "Each semester normally includes 13
    weeks of instruction and 2 weeks of examinations". No total of the page's own. A "class
    hours" figure would read 0 for 124 courses that list only project and preparation hours.
  - *PDF:* "Print or save as PDF" opens the browser's print dialog on a print-ready page; on a
    computer that is "Save as PDF", on an iPhone Share, then Print, then pinch out the preview.
    No library to load and the text stays real; whether the saved PDF keeps the page's
    structure for screen readers is checked in 6-0.
- **G2. The most you may take.** NUS's 2026 exchange brochure says 23 units a semester; NUS
  Business School says 20 for its own exchange students; an older NUS FAQ and some partner
  universities' pages say 20 for everyone. What should the page say? *Recommended: "NUS's
  brochure says at most 23 units a semester (NUS Business School's exchange students: 20); some
  pages say 20, so ask NUS before going above 20", as a limit on the courses NUS enrols you in,
  not the courses you list.* The brochure is NUS's current word, but 20 is common enough that a
  student planning 23 should check; one who plans 20 loses nothing.
- **G3. Remember the list.** Keep the last list this student edited on this device, offered as
  "Restore your last shortlist" when a link has none, with "Forget this list on this device"?
  Opening someone else's link never overwrites it. *Recommended: yes.* A list that lives only
  in a URL is easy to lose; "Forget" covers a shared computer.
- **G4. Students already admitted.** For students changing courses after admission, Phase 6
  shows NUS's rules for that stage in one box and on the rows they affect (keep at least 12
  units or three courses; drop clashing courses; which courses can't be added later; how to
  request or appeal for a course; the grades for dropping late). Is that enough for now, with
  a separate planner for adding and dropping courses left for later if you want one?
  *Recommended: yes.* SC3 asks for a shortlist; an add-and-drop planner is a second product, and
  the box keeps an admitted student from being misled.
- **G5. A full-year student's form order** (asked only if 6-0 doesn't find a current source).
  An NUS sheet from 2018/19 says full-year students choose their Sem 2 courses later, by email
  before Sem 1 ends. Number each semester's order separately against NUS's 40 units, and tell
  full-year students that NUS may ask for their Sem 2 choices later? *Recommended: yes.* One
  numbered list for the year would let Sem 2 courses, which the form may not offer yet, push
  Sem 1 backups past 40 units, and a student who secures fewer than 12 Sem 1 units is turned
  down.

## 7. Critic log
Gate question numbers in each round are those of the draft it read. r6 split r5's G4 into G4
(backups) and G10 (the full-year 40), and r5's G6 into G6 (warnings) and G7 (NUS's notes); r5's
G7 and G8 are r6's G8 and G9. r7 makes r6's G7 (NUS's notes) a lead rule, turns r6's G9 (two
stages) into G8 (CourseReg: a box now, a mode later), and renumbers r6's G8 and G10 as G7 and G9.
r8 makes r7's G4 (backups) and G6 (warnings) lead rules and renumbers r7's G5, G7, G8 and G9 as
G4 (PDF), G5 (remember the list), G6 (admitted students) and G7 (a full year's 40 units).
r12 merges r11's G1 (syllabus), G2 (hours) and G4 (PDF) into G1 (what SC3's words mean) and
renumbers G3, G5, G6 and G7 as G2 (maximum), G3 (remember the list), G4 (admitted students) and
G5 (a full-year student's form order).

### Round 1 (critics A frontend and accessibility, B data, export and ops, C product)
Found sound by round 1: `aria-pressed` with a fixed name, the toggle outside the heading, no
drag, the `pick`/`alt` citations, the print route needing no CSP change, the CSV quoting and
injection rules (A); the `/module` field list, the 6,778 / 1,167 / 553 / 58 / 533 / 271 / 238 /
SA41xx counts, the credit distribution, the groups' size, D1 and Workers cost, static assets
staying free, the pin and holdout handling (B); URL-only state, the closed-pick wording from D4,
the print route, the advisor persona, refusing to call the description a syllabus (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A-1 | A (blocking) | each history entry keeps its own list: Back drops an add, restores a removal | the shortlist is page-wide; popstate keeps it and rewrites the entry's URL; tested |
| A-2 | A | a replace on edit erases `vnmDetail`; Escape then leaves a stray entry | edits replace with `history.state`; the view's own flag; history test |
| A-3 | A | edits through `act()` re-search after an error and wipe the live sentence | edits never call `show()`; test: five edits under 429 send no search |
| A-4 | A | tags dropped in a one-semester state; switching back loses them | tags always kept; the other semester's picks shown apart; sem round-trip test |
| A-5 | A | outside exchange mode the total is undefined; no semester control in browse mode | browse-mode rule; semester buttons on every two-semester course |
| A-6 | A | disabled move buttons drop focus; Remove at the end unspecified | `aria-disabled`; focus rules for each action at each end; asserted in both browsers |
| A-7 | A | PDF can print before rows or fonts load; Ctrl+P prints a partial list | rows and fonts load with the view; Ctrl+P prints the list only when loaded; stubbed-print test |
| A-8 | A | WebKit's `replaceState` limit under held Enter | throttled writes in `try` with retry (revised in round 3) |
| A-9 | A | rendered links bake in a stale list | rendered links carry no list; new tabs start empty or offer the remembered list |
| A-10 | A | title restore, print stub, dark theme in print, pdf.js whitespace | `afterprint`; `addInitScript` stub; light print theme tested under dark; normalised text |
| A-11 | A | there is no phone bar; toggle placement can break the fold | button placed for each width; fold check on ACC1701XB with both |
| A-12 | A | radios unnamed; blob revoke; 404s refetched; a 21st add unspecified | buttons, not radios (round 3); revoke after a minute; 404 cached; toggle refuses at the cap |
| B-1 | B (blocking) | = A-4 | as A-4 |
| B-2 | B | "open with notes" counts `semester` and `restricted-elsewhere` picks NUS itself doubts | counted vs to-confirm split by note kind, as Phase 5's red-team table |
| B-3 | B | no source for the acad year; a next-year link silently shows new data | `ay=` in the URL and a mismatch line (the year's source revised in rounds 2 and 3) |
| B-4 | B | 6A's ACC1701 test can't pass on the fixture groups | fixture expects XA, XC; the full list in `test/full` |
| B-5 | B | same-course across pick and backup flagged; doubled with an exam clash | picks only; neutral line for a backup; clash skips one group |
| B-6 | B | preclusion substring matches false pairs; token match misses glued text | boundary rule with glued OR/AND/THEN; one-way wording |
| B-7 | B | Excel in `;` locales puts the CSV in one column | a hint beside the button; no `sep=` line (it breaks the BOM). **Declined:** a second Excel-only file (beyond SC3's CSV) |
| B-8 | B | SC1 over the shortlist tested on 126 codes, not the NG list | `test/sc1` over every NG code |
| B-9 | B | hours × 13 disagrees with NUS's rate on 82 courses | units-based estimate in G2 |
| B-10 | B | data provenance mislabelled; 14,359 from another file | sources named per number |
| B-11 | B (minor) | 404 refetch; "every course's hours"; CSV footer field count; interval test; slot count 22; `Number("")`; URL size; Plex coverage; NG-listed 404s; fallbacks; 7 export links | each applied in §1, §3 or §5 |
| C-1 | C (blocking) | exports name 2026/27 though students now plan for 2027/28 | the data's year on every export, "made on", `ay=` (wording revised in round 3). A wording rule the lead sets, not a gate question: it states facts only |
| C-2 | C | the application's 40 units and single order are never shown | totals against 12, the maximum and 40; order on NUS's form; top-three line |
| C-3 | C | hours × 13 doubles half-semester courses, zero for others | = B-9 |
| C-4 | C | closed and not-offered courses sit in the advisor's PDF | their own closing sections, out of the counts |
| C-5 | C | a browse-mode list exports with blank statuses | revised in round 2 (C2-10): the year is asked before export |
| C-6 | C | = A-4; special-term tags unsupported by the NG list | tags 1 and 2 only |
| C-7 | C | class times and corequisites unchecked, unsaid | a fixed line in the view and both exports; corequisites a known gap (storing them is a data change) |
| C-8 | C (minor) | preclusion wording two-way; pick–backup pairs normal | = B-6; picks only |
| C-9 | C (minor) | noted courses look secured | "if each course accepts you"; to-confirm units apart |
| C-10 | C (minor) | phone PDF path hard to find | "Print or save as PDF", a hint for phones |
| C-11 | C (minor) | no date on the PDF | "Made on" in both exports |
| C-12 | C (minor) | G6 asked two things; shared computers | split into G6 and G7; "Forget this list" |
| C-13 | C (minor) | G1 label; G4 needs its citation | "NUS, via NUSMods"; NUS Global cited |

### Round 2 (fresh critics on r2)
Found sound by round 2: the toggle outside the `h2`, the CSP for print and blob downloads, the
`app.js` citations, the page-wide list with a popstate rewrite, `aria-disabled`, rendered links
without the list (A); every §1 count re-derived from production, the `/module` fields and cache
headers, URL arithmetic, cost, CSV quoting and BOM, the pin procedure (B); the page-wide state,
the counted and to-confirm split, dating the exports, the per-semester 12 and 23, the injection
guard, the advisor persona, the print route, no scope creep (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A2-1 | A (blocking) | a filter change inside the view drops `view`, erases its flag, re-searches and announces the count | rows for settings, chips and the facets drop while the view is open; `view` carried; answers held back while the view is shown; history test |
| A2-2 | A | where the view lives is unspecified; `show()`'s same-answer path leaves it on screen after Back; focus on open; Escape in the view | its own region shown by `view`; opening drops `open`; focus on its heading; Escape closes the view; focus assertions |
| A2-3 | A | the history-length test can't pass and can't catch A-2 | the URL and `goForward()` asserted in `history.spec.js`, as the existing spec does |
| A2-4 | A | the held-Enter test never reaches WebKit's limit | alternating moves in WebKit; a refusal simulated (revised in round 3) |
| A2-5 | A | a debounced write can stamp a stale URL on a newer entry | the URL built when the write fires; `act()` flushes first; the list outside `current` (popstate revised in round 3) |
| A2-6 | A (minor) | exports after a wait may lose the user's click | rows load with the view; a second press after a slow load; 6-0 checks the browsers |
| A2-7 | A (minor) | PDF text comparison: fallback glyphs and ligatures | NFKC, whitespace stripped; EN3264, LL4407 named; CI font confirmed |
| A2-8 | A (minor) | `page.pdf()` may not run a `beforeprint` handler | the section is built eagerly, gated by a class |
| A2-9 | A (minor) | 20 identical "Remove"; label-in-name; "·" read aloud; button inside the search landmark | "Remove, CS3244" (visible text first); words for separators; outside the landmark |
| A2-10 | A (minor) | toggle placement at ≥ 641px; fold check with a short label | placed per width; fold check with the longest label |
| A2-11 | A (minor) | counts unknown until rows load; progress chatter | "at least"; progress said once |
| B2-1 | B (blocking) | a constant year can't be tested against production and breaks at the next ingest | the year comes from the rows' `acad_year`; the constant is only a default |
| B2-2 | B | same-course rule zeroes an open pick when the higher-ranked member is closed | revised in round 3: by status, then rank |
| B2-3 | B | preclusion misses "beginning with X" and bare prefixes | prefix matching; COS1000, BSP1703, EC2104 tested |
| B2-4 | B | browse mode counts a course in a semester it isn't taught in | counts only if the tag is in `semesters`; special-term-only courses said |
| B2-5 | B | export spec asserts descriptions for closed courses the section doesn't carry | closed courses carry the full block; runs in exchange mode at ug2 and grad |
| B2-6 | B (minor) | named tests don't match the data; counts 4 and 55 | synthetic answers for clash and units; NUS's texts inline; counts corrected |
| B2-7 | B (minor) | exam dates are 2026/27's | = C2-1 |
| B2-8 | B (minor) | undergraduate-only preclusions flagged for grad students | skipped at `study=grad` |
| B2-9 | B (minor) | a rollback drops `ay` and `view` | accepted; in the runbook and §4 |
| B2-10 | B (minor) | CSV head before the header row breaks Data › From Text | header first; head and foot after |
| B2-11 | B (minor) | backups in the 40-unit line undefined | revised in round 3: the form order |
| B2-12 | B (minor) | wording: `null` not zero; pinned groups in `test/full`; test file name | corrected |
| C2-1 | C (blocking) | exam dates and clashes are last year's timetable, presented as next year's | "2026/27 exam" everywhere; the flag's wording (revised in round 3); G6 asks |
| C2-2 | C | "estimated hours" read as contact hours | revised in round 3: NUSMods' five figures and NUS's study-time estimate |
| C2-3 | C | NG-listed courses with no classes this year filed as "not open" | their own section; told apart by 6A's 404 kind (round 3) |
| C2-4 | C | a full-year student's 40 units and order have no source | per semester until 6-0 finds one; G3 says so |
| C2-5 | C | exports lack department, faculty and level | added, with NUS Global's level names |
| C2-6 | C (minor) | top-three line misstates NUS | NUS's wording and reason |
| C2-7 | C (minor) | changing semester strands the list | the other semester's picks shown apart; a "Move to Sem N" button per row. **Declined:** a "Move all to Sem 2" button (each row can be moved; beyond SC3) |
| C2-8 | C (minor) | Copy link's contents unspecified | the shortlist link, no `q`, `view=shortlist` |
| C2-9 | C (minor) | G7 overwrites on a shared link | written only on the student's own edits |
| C2-10 | C (minor) | browse-mode exports useless to an advisor | the year and semester asked before export; no unchecked export |
| C2-11 | C (minor) | uncited lines; prerequisite syllabi; Business School's 20 | Canvas line cited (round 3); the brochure's syllabi line; the Business note dropped (not read first-hand) |
| C2-12 | C (minor) | the button's total is ambiguous for a full year | per semester |

### Round 3 (fresh critics on r3)
Found sound by round 3: the toggle outside the `h2`, the CSP, the dark tokens undoable in print,
one Plex subset per face, `act()` flushing before it writes, URL and `goForward()` assertions,
the `app.js` citations (A); every §1 count re-derived from production, the groups, the fixture,
the `/module` fields, cost, the pin procedure (B); the URL-only list, the counted / to-confirm
split, closed picks kept with reasons, the description not called a syllabus, the brochure's
syllabi line, per-semester totals, G1, G4, G5, G7, the advisor persona, no scope creep (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A3-1 | A (blocking) | a pending write flushed inside `popstate` stamps the old q on the entry Back returns to (probed in both browsers) | `popstate` cancels without flushing, then writes the list into the arrived entry; Back-within-100 ms test |
| A3-2 | A | closing the view by `back()` throws away a semester changed inside it | `atOpen` in `history.state`; close by replace when q or filters changed; `sem=2` asserted |
| A3-3 | A | focus after closing the view lands on a card or `#main` | popstate's view branch focuses the displayed shortlist button; opening the view first drops `open` |
| A3-4 | A | the 429 test fails: popstate always runs `show()` | popstate runs `show()` only when q or filters differ |
| A3-5 | A | WebKit's limit is 100 per 10 s; no retry after a refusal | §1 corrected; retry with backoff; refusal simulated in a test |
| A3-6 | A | a submit from the view is unspecified | closes the view by a push, list kept, announced; tested |
| A3-7 | A | radios commit on arrow keys and drop focus; no cap rule | "Move to Sem 2" buttons; focus stays; refused at a full semester |
| A3-8 | A | every URL writer still builds from `State.pick/alt` | `pick`/`alt` leave `State`; one writer takes the list; tests moved |
| A3-9 | A (minor) | a reload right after an edit loses it | the first edit writes at once; device copy at once; reload test |
| A3-10 | A (minor) | `open` and `view` both set | `parseState` drops `open` |
| A3-11 | A (minor) | `show()`'s other side effects speak or move focus behind the view | all held back while the view is shown; tested |
| A3-12 | A (minor) | tagging on load breaks an existing spec, is async, and has no tag for `sem=''` | no tagging after load; "semester not chosen" with Sem 1 / Sem 2 buttons; caps per tagged semester and in all |
| A3-13 | A (minor) | print after awaited work may lose the user's click | fonts and rows load with the view; a second press after a slow load |
| A3-14 | A (minor) | focus after the last Remove | the view's heading |
| B3-1 | B | same-course rule ambiguous with to-confirm: one course counted twice (ACC1701XA/XB) | by status, then rank; across semesters too; both orders tested |
| B3-2 | B | every 404 worded as an NG-listed course (CS1010J, CS9999) | 6A's 404 `kind` and title; each worded apart; tested |
| B3-3 | B | `ay` unset on the card path and rewritten later | set once from the first row or 404; never rewritten; disagreeing rows refetched; years in text from the rows |
| B3-4 | B (minor) | prefix count 189 (MA1301's "MA"); self-matches; grad clause case; cohort rules; same-group pairs | counts corrected; "another pick"; case-insensitive with "("; cohort rules skipped; one group skipped; tested |
| B3-5 | B (minor) | form order numbers entries that can't go on the form | = C3-M3 |
| B3-6 | B (minor) | cost said 20 reads; a full year is 40 | corrected |
| B3-7 | B (minor) | level counts on a different base | over the 1,167 offered |
| B3-8 | B (minor) | where the tests run: aliases, `npm test` excludes `test/sc1`, SA4101C not in the fixture | tests build answers themselves; a fixture SC1 file in the `workers` project; SA4101C inline |
| B3-9 | B (minor) | CI time unsupported | measured in 6C; sharded past 15 minutes |
| B3-10 | B (minor) | null exam duration; exports with picks in the other semester | point overlap; every entry exported, grouped by semester; file name from semesters present |
| B3-11 | B (minor) | live checks vs one call per 4 s | `p6-live.mjs` routes and paces the page's calls |
| B3-12 | B (minor) | line citations off | corrected |
| C3-1 | C (blocking) | NUS gives 23 (brochure) and 20 (GRO FAQ) as the maximum | G3 asks Jacob, with both sources and a recommendation |
| C3-2 | C (blocking) | today's users include Sem 2 2026/27 students on the data's own year | wording for both; the exam flag a hard bar for the data's year, a hint for a later one |
| C3-M1 | C | "NUS publishes them before applications open" is false | NUS's update months, cited |
| C3-M2 | C | "class hours" shows 0 for 124 NG courses | NUSMods' five figures as listed; a line when lecture, tutorial and lab are 0; G2 says so |
| C3-M3 | C | form order counts closed courses and runs past 40 | only counted and to-confirm entries numbered; the 40-unit mark |
| C3-m1 | C (minor) | "Level 5000, graduate" contradicts NUS | "master's level"; GRO's 4000-and-above line |
| C3-m2 | C (minor) | grading basis missing | 6A answers `gradingBasis`; shown when not "Graded" |
| C3-m3 | C (minor) | NG-listed no-class codes export as bare codes; can't be added | title from the 404; **declined:** adding them from the "Not this year" line (they have no classes to plan; beyond SC3) |
| C3-m4 | C (minor) | the 12-unit line's weaker reason; full URL | "below this, NUS turns the application down"; full GRO URL |

### Round 4 (fresh critics on r4)
Found sound by round 4: a blob download under the production CSP, even 6 s after the click,
with the BOM (probed); ACC1701XB's stamps 242 px above the 390×664 fold today (probed); `back()`
after a reload keeps `history.state` (probed); the toggle (A); every §1 count re-derived,
`ng-listed` checked before `catalogue-only`, cost, the pin procedure (B); every NUS quote checked
against the GRO page and the brochure, the FAQ's 20 confirmed word for word; the page-wide list,
closed and 404 picks kept with reasons, NUSMods' five figures, the year-aware exam wording,
G1–G7 plain and about the product, no scope creep (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A4-1 | A (blocking) | "popstate runs `show()` only if q or filters differ" stops Back and Forward opening and closing details; "what is shown" is empty after an error | popstate always syncs detail and view; the search runs only if `searchParams` changed, compared with the state before the event; the existing detail tests kept |
| A4-2 | A | edits within 300 ms are lost on reload; a write in `pagehide` doesn't survive one (probed) | every edit writes at once; coalescing only past 80 writes in 10 s; `visibilitychange` flush; two-edit reload test |
| A4-3 | A | the A3-1 tests can't fail: a single toggle leaves nothing pending | coalescing forced on by a test hook; two toggles, then Back or a code link |
| A4-4 | A | closing the view after a Sem change in it leaves Sem 1 stamps under a Sem 2 chip | close by replace runs `show(current)` when the answer on screen is stale and announces; the stamp asserted |
| A4-5 | A | opening the view from a page-opened detail leaves a dead Back press | the detail's entry becomes the view's; close goes `back()` to the list; tested |
| A4-6 | A (minor) | WebKit's count is shared with `pushState`, fails on the 101st; other writers unguarded; the stress test can't reach it; Playwright's Chromium flag | one guarded history writer for every caller, with a count and retry; a refused push retried; §1 corrected; the stress test asserts the write count |
| A4-7 | A (minor) | focus after choosing a semester for an untagged row | the row's new "Move to …" button |
| A4-8 | A (minor) | focus on Forward into the view; Remove's rule ambiguous | the view's heading; Remove's rule spelled out; headings `tabindex=-1` |
| A4-9 | A (minor) | row progress overwrites a search's count | announced only while the view is shown; tested |
| A4-10 | A (minor) | "Press again" by a name change may go unheard | also said in the live region |
| B4-1 | B | the 40-unit mark disagrees with its test and is wrong for 5- and 8-unit courses | an entry fits while the sum stays ≤ 40; each entry that would pass it is marked; 9×4+5 and 9×4+8+4 tested |
| B4-2 | B | exports take status from the view's semester: a full-year export loses Sem 2 | exports work out each semester as if viewed; same course settled once across semesters; tested |
| B4-3 | B | importing `ng-courses-2026-2027.json` pins the Worker's NG list to one year | the codes ride in `ng-reasons.json`, built per year; a same-year test; a runbook line |
| B4-4 | B | "first by rank" undefined across semesters | rank is URL order; tested in both views |
| B4-5 | B (minor) | `ay` from a 404's bundle year; endless refetch | only 200 rows set `ay`; refetch once |
| B4-6 | B (minor) | answers from before the deploy or after a rollback lack new fields | a fallback for each field |
| B4-7 | B (minor) | `gradingBasis` won't appear by adding the column | renamed and the raw key deleted; key-set test |
| B4-8 | B (minor) | level labels stop at 5000 | 5000–6000, 8000 and a fallback |
| B4-9 | B (minor) | red team's expected answers from the pinned fixture; live totals compared with the page's own CSV | oracle over production-normalised modules; an independent reference |
| B4-10 | B (minor) | an empty CSV line is a 1-field record | the separator row padded |
| C4-1 | C (blocking) | the view and exports speak only to applicants; admitted students in CourseReg are misled (Economics can't be added) | G8: a stage choice that changes the wording; NUS's CourseReg rules cited |
| C4-M1 | C | "12 units" against picks reads as the minimum met | NUS's wording: it must accept you into 12; list as many as you can; never "met"; the 4000-level line in full |
| C4-M2 | C | a full-year student's 40 units per semester has no source; could approve 80 units | G4: one list for the year with one 40-unit limit and "ask NUS", until a source says otherwise |
| C4-M3 | C | oversubscribed departments show as plainly open | NUS's cited note on those picks (G6) |
| C4-M4 | C | the level-1000 language form goes unmentioned | NUS's cited note on those 13 picks (G6) |
| C4-m1 | C (minor) | `audition` picks get a form number | to confirm, "apply separately", no number |
| C4-m2 | C (minor) | G3's reason weak; the FAQ's 50 hours | G3 recommends showing both; the FAQ cited in G2 |
| C4-m3 | C (minor) | estimate and NUSMods' hours disagree for 85 courses, unexplained | the rate named in the label; a line where they differ |
| C4-m4 | C (minor) | "at least 12 units" sounds like the minimum met | "12 units so far"; the button says "picked" |
| C4-m5 | C (minor) | untagged picks exported | a semester asked for each before export |

### Round 5 (fresh critics on r5)
Found sound by round 5: reload then Back, and Back across another origin, both fire popstate
with `history.state` kept (probed); the `app.js` citations; print and blob downloads under the
CSP; `aria-disabled`, visible-text-first names, the toggle outside the `h2`, focus to the
displayed shortlist button (A); every §1 count re-derived, the NG codes in `ng-reasons.json`,
`gradingBasis` needing no migration, cost, one deploy and the pin (B); every NUS quote checked
word for word against the GRO page with its FAQ, the brochure, the Registrar's NG list, the NG
application guide and Business School's factsheet; the page-wide list, counted and to-confirm
apart, the minimum never "met", closed and 404 picks kept with reasons, year-labelled exams, the
five workload figures, the description not called a syllabus, the print route, no scope creep
(C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A5-M1 | A | a stage chosen in the view is lost when the view closes by `back()` | `ay` and `stage` are page-wide with the list, written into the arrived entry; tested |
| A5-M2 | A | "the set-up's own controls, in the view" can't be built: they exist once and move with the dialog | the view's own question with its own names, applied through `act(settings)`, focus kept |
| A5-M3 | A | rows arriving can destroy the focused button | rows update in place, keyed by entry; focus restored by (code, control); tested |
| A5-M4 | A | the dark-theme print test can't catch dark text on white paper (probed: axe 0 violations) | computed text colour checked against white; axe for structure only |
| A5-M5 | A | writing `ay` on load breaks `history.spec.js:101-104` | `ay` written with the first edit, Copy link or an export; its format stated; tested |
| A5-m1 | A (minor) | WebKit can't grant clipboard reading | `writeText` stub; "Link copied"; a fallback field |
| A5-m2 | A (minor) | "picks and no q opens the view" reopens a closed view on reload | dropped; only `view=shortlist` opens it |
| A5-m3 | A (minor) | a filter change with unsubmitted text closes the view | settings in the view use `current.q`; tested |
| A5-m4 | A (minor) | work started before the view opened still speaks | every announcement but the view's held while it is shown; the detail collapsed on opening |
| A5-m5 | A (minor) | the toggle's pressed state by colour alone | a filled icon; in the mockup |
| A5-m6 | A (minor) | Ctrl+P with a failed row never prints the list; title unset | failed and 404 rows count as settled; title set on `beforeprint` |
| A5-m7 | A (minor) | Back onto a failed search never retries | a network or server error retries; 429 doesn't; tested |
| A5-m8 | A (minor) | coalesced writes lost on reload; a citation | §1 says it (past 80 writes only); citation fixed |
| B5-1 | B | `getJson` drops a 404's body, so the page can't tell its kinds apart | `getJson` passes `kind`, `title`, `acadYear` as `error.detail`; unit test |
| B5-2 | B | `p6-live`'s pacing makes the page time out its own `/module` calls | answers fetched first, paced; the page fulfilled from memory shared across browsers |
| B5-3 | B | at CourseReg the 40-unit mark and numbers still apply | dropped at CourseReg; the maximum flagged; tested |
| B5-4 | B (minor) | CS2040C isn't in the fixture | CS2030.2 |
| B5-5 | B (minor) | 6A breaks the key-order and Server-Timing tests; no catalogue seed | both tests named and updated (the read timed as `d1`); `POST /admin/catalogue` seeded |
| B5-6 | B (minor) | groups join different courses ("Independent Study"), so units are dropped | same course only between NG-listed codes; elsewhere both count, with a check line |
| B5-7 | B (minor) | `level` is one digit | rules written on the digit; §1 says so |
| B5-8 | B (minor) | the master-level label contradicts "Open" for 4 courses | a note only when the course isn't open at the student's year |
| B5-9 | B (minor) | "(or three courses)" at the application stage | dropped there; kept at CourseReg, as GRO says |
| B5-10 | B (minor) | the grad and cohort rules under-specified | undergraduate-only clauses; cohort rule defined; MA4xxx, HY2262, DAO2702X tested |
| B5-11 | B (minor) | AH3204's workload; 82 not 85; LAL1201; the Business/Law/Economics fields | corrected; faculty and department named |
| C5-1 | C (blocking) | Business and Law picks counted, though NUS offers them only to invited students | to confirm at both stages, with NUS's cited line. A lead rule, not a question: the page states NUS's condition and asks for no new control |
| C5-M1 | C | the CourseReg stage keeps the application's tools | = B5-3; lists renamed "courses you hold" and "courses to try to add"; the note on the add list only |
| C5-M2 | C | G3 doesn't say where the maximum applies | it limits courses NUS enrols you in; flagged at CourseReg; the Business factsheet's 20 added |
| C5-M3 | C | a year-wide 40 stated as fact could make a full-year student under-list | the mark asks NUS rather than forbids; G10 restated; 6-0 checks units versus course count |
| C5-M4 | C | G1 promises a department syllabus no source mentions | dropped; the Registrar's Canvas and NUSMods lines cited |
| C5-M5 | C | nothing shows how much of the 40 units the form fills | "On NUS's form: 24 of 40 units" at the application stage |
| C5-m1 | C (minor) | the level-4000 line on Law and graduate picks | skipped for both |
| C5-m2 | C (minor) | the oversubscribed note by department over- and under-reaches | by code prefix (AR, CE, CS, EC), Psychology added, "advised against" quoted |
| C5-m3 | C (minor) | "4 units, 10 hours" isn't in the brochure's text layer | Business School's factsheet and the GRO FAQ cited |
| C5-m4 | C (minor) | G4 and G6 each asked two things | split: G4 and G10, G6 and G7 |
| C5-m5 | C (minor) | the form asks for a class choice and equivalent prerequisites | one line at the application stage, cited |

### Round 6 (fresh critics on r6)
Found sound by round 6: the one guarded history writer and its budget, the popstate rules for
detail and view, the 404 kinds, the 6A field list and its fallbacks for old answers (A, B); the
counting buckets, the form's 40-unit mark, the CSV rules, the print route and its dark-theme
check, the pin and holdout handling, the live-check pacing (B); the closed-pick wording, the
exports' head and labels, the advisor persona, the cited NUS lines (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A6-1 | A (blocking) | per-semester lists stop a full-year student ranking a Sem 2 course above a Sem 1 one; Move can't cross semesters | two lists (picks, backups), each in URL order for the year, each row showing its semester; totals per semester under them; Move swaps with the neighbour in the same list; test `pick=A.1&pick=B.2` |
| A6-M1 | A | the 429 rule re-searches on Back when the params changed, and never re-searches after a 500 when they didn't | the error rule applies only when `searchParams` are unchanged; the last error's kind kept beside `shown`; the same rule on close by replace; tests: search, 500 or 429, open view, `goBack()` |
| A6-M2 | A | after a successful Try again focus is lost when the row is rebuilt; semester buttons appear before the row knows its semesters | focus to the row's first control and "CS3244 loaded"; semester buttons drawn only once the row is in |
| A6-M3 | A | moving the focused `<li>` drops focus to `<body>` in both engines (probed) | Move up and down move the neighbour; Make backup, Make primary and semester moves refocus the same control and then announce; asserted in both browsers |
| A6-m1 | A (minor) | an edit after a refused push can land before it | later writes queue behind the retry and fold into its URL; test |
| A6-m2 | A (minor) | popstate's write bypasses the budget | every write, popstate's included, goes through the writer |
| A6-m3 | A (minor) | the rail's shortlist button inside `#panel` moves into the phone's dialog | in the aside, outside `#panel` |
| A6-m4 | A (minor) | G8's restore offer on the first screen leaves the student there | it sets `leftSetup` and opens the view |
| A6-m5 | A (minor) | the printed link overflows the page | `overflow-wrap: anywhere`; the link joins the PDF text assertion |
| A6-m6 | A (minor) | the view isn't in the 320 px reflow loop | added to `mobile.spec.js:156-166` with LC6009GRSII's row and the fallback field |
| A6-m7 | A (minor) | `list-style: none` drops the list role in WebKit | `role="list"` on both `<ol>`s |
| A6-m8 | A (minor) | Copy link awaits rows, so `writeText` leaves the click | never waits; copies without `ay` if no row has loaded; the stub asserts a call within the click |
| A6-m9 | A (minor) | a Sem change in the view says nothing | one sentence: "Showing your Sem 2 picks: 12 units picked" |
| A6-m10 | A (minor) | rendered links carry `stage` | moot: the stage is gone; rendered links carry no `pick`, `alt`, `ay` or `view` |
| B6-M1 | B | the same-course tests use ACC1701 codes, which are Business School courses and so to confirm | counted tests use CS2030/CS2030DE and GES1034/GESS1024; ACC1701XB/XA kept as the to-confirm case; GE2101 for a counted `quota` pick |
| B6-M2 | B | AR5221, AR5321 and AR5601 are open at every undergraduate year, so the master-level test can't fail | CAS5101: open at ug4, closed at ug3; §1 corrected |
| B6-M3 | B | special-term-only courses (129) and 404s can never take a semester, so the export question can't be answered | exempt from the question, exported in "Not placed in a semester"; `?pick=CS9999` download test |
| B6-M4 | B | the CourseReg stage's Business/Law arithmetic double-counts held courses | moot: the stage is removed (G8); the box quotes NUS's rule |
| B6-m1 | B (minor) | the Business notes fact miscounted | 30 / 6 / 4 restated |
| B6-m2 | B (minor) | two Economics rules (department, prefix) | one: the EC prefix; GEC1028 tested as none |
| B6-m3 | B (minor) | a failed `catalogue_only` read answers `unknown`, cached | `unknown` only when the table is missing; else 5xx `no-store` |
| B6-m4 | B (minor) | an NG-listed 404 doesn't say which semester | `ngSemesters` from `ng-reasons.json`, codes stored by semester |
| B6-m5 | B (minor) | the 404's year can drift from D1's | from the catalogue row when there is one; `verify --pre-deploy` asserts the bundle's year equals D1's |
| B6-m6 | B (minor) | the red team's answer key lacks Business/Law, audition and NG-listed 404 rows | added |
| B6-m7 | B (minor) | DAO2702X's programme rule can't be reached by a pick pair | tested at the rule parser |
| B6-m8 | B (minor) | README "Cost" isn't in the exit list | added |
| B6-m9 | B (minor) | `ng-reasons.js` doesn't export `acadYear` | it exports the year and the codes |
| C6-M1 | C | at CourseReg, held courses are judged as if still applied for | the stage is removed; the CourseReg box says "A course NUS gave you at the offer is yours, whatever this page says"; a CourseReg mode is G8 |
| C6-M2 | C | there's no way to mark a course to drop | as C6-M1: scope reduced to the cited box; G8 asks about a mode later |
| C6-M3 | C | exam overlaps are checked between picks only, so a backup that clashes with a pick looks safe (CS3223 and CS3241) | every pair of numbered entries; a pick and a backup get "NUS approves at most one"; tested on CS3223 and CS3241 |
| C6-m1 | C (minor) | Business/Law entries take form places an uninvited student can't use | "on the form only if invited"; the form line both ways; "won't fit" on the uninvited count |
| C6-m2 | C (minor) | no study-time total per semester | hours a week per semester at NUS's rate, on the view and in the exports |
| C6-m3 | C (minor) | the transfer-of-units line only at CourseReg | in the exports' foot for everyone |
| C6-m4 | C (minor) | G7 asks Jacob to approve quoting NUS | a lead rule; nine questions remain |

### Round 7 (fresh critics on r7)
Found sound by round 7: history traversal after a reload and across origins, Move by moving the
neighbour (probed in both engines), the history budget under WebKit's limit, the history table,
`<ol role="list">`, `aria-disabled` end buttons, the focus order after Remove, the shortlist
button's place, the print contrast check and `print()` stub, the CSP, Copy link, the reflow and
fold additions (A); every §1 count re-run over the 2026-11-04 catalogue, the fixture statuses
behind the tests, the API, ops, pin and cost (B); GRO's and the brochure's quoted lines, the
application guide, the Business factsheet's 20 units and 10 hours, G2's rate, marking (not
refusing) entries past 40, labelling every year, never calling the minimum met (C). No blocking
objection.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A7-M1 | A | the view "narrowed to Sem 1" is undefined: Move swaps with hidden rows, a row moved to Sem 2 leaves the view and drops focus, Remove can target a hidden row; whether results stay operable behind the view is unsettled | the view always shows every entry, each worked out at its own semester; `sem` only sets a new entry's semester and which totals come first; the results region is `hidden` while the view is shown; keyboard test on a full-year list before and after a Sem change |
| A7-m1 | A (minor) | settings in the view run `applyToForm`, which overwrites the box's unsubmitted text (`app.js:184`) | the query field is left alone while the view is shown; the history test asserts the box text |
| A7-m2 | A (minor) | a 404 arriving removes Move and Make from a row holding focus; Try again answering 404 has no focus rule | Move, Make and Remove are drawn for every row at once and never removed; Try again focuses the first control and says how it ended; test with CS9999 held then released as 404 |
| A7-m3 | A (minor) | Ctrl+P prints a browse-mode list without the export question | Ctrl+P prints the shortlist only once the question is answered or not needed; test |
| A7-m4 | A (minor) | the export question's year can pull focus to the rail's `#study` via `show()` | `show()` moves no focus while the view is shown; test in a fresh context |
| A7-m5 | A (minor) | the card's and detail head's toggles can disagree | every toggle for a code reflects the list; test |
| A7-m6 | A (minor) | CS3223, CS3241 and an `audition` case aren't in the fixture | overlap tests use CS2030 and CS2113 (fixture, same start); `audition` by a synthetic answer |
| A7-m7 | A (minor) | bundling the whole NG list makes fixture-missing NG codes answer `ng-listed` on the test stack | `ng-reasons.json` bundles only the NG codes with no offered row; `verify --pre-deploy` checks that set against D1; test that CS3223 never answers `ng-listed` |
| B7-M1 | B | "won't fit" judged only without Business and Law lets an invited student's form pass 40 unmarked, and a Business entry ranked first shifts everyone's number | two numbers per entry when the list holds Business or Law (uninvited, invited), each count marked apart, the form line gives both; tests |
| B7-M2 | B | SC1 is checked only over NG codes, not the 5,611 offered codes that are always closed | every offered code (6,771 pinned) in `test/sc1`; all 434 in the fixture version |
| B7-M3 | B | off the NG list, two codes of one course (CS2030, CS2030S) both count and their flags are switched off, while NG pairs merge | the same course when both are on the NG list or either's preclusion names the other; flags skipped only for a dropped duplicate; browse-mode test |
| B7-m1 | B | an NG-listed 404 gets no units, title or number, unlike a `semester` note saying the same | to confirm and numbered, with units (moduleInfo, via `ng-reasons.json`), title and description (`catalogue_only`) in the 404 body |
| B7-m2 | B | the bare-prefix preclusion rule isn't needed and flags programme codes | dropped; every prefix follows "beginning with"; `0300CS2MJ` tested as no flag |
| B7-m3 | B | PC1101's "(" test proves nothing (cohort-only); GESS1025 isn't in the fixture | a synthetic "(If undertaking an Undergraduate Degree" text at the rule parser; grading by a seeded row |
| B7-m4 | B | "starting AR, CE, CS or EC" catches CEG, ECA, CSA, PLS… | the code's letters must equal the prefix; PLS8002A and a CEG code tested as none |
| B7-m5 | B | a list with no semester has no file name or year | no semester part; year from rows, else a 404's `acadYear`, else `year.js`; tested |
| C7-M1 | C | Economics picks count and Business/Law say "it counts" for admitted students who can't add them | the GRO CourseReg rule on each EC, Business and Law row, a line under any total that includes them, and the Business/Law sentence narrowed to "only if NUS gave it to you at the offer" |
| C7-M2 | C | off-list courses are filed as "not open" though rule E says they may be available in CourseReg | rule E quoted in the CourseReg box and on those entries in the export; still uncounted (SC1, Q7) |
| C7-M3 | C | G1's Canvas line is in no build spec | in the view and the exports' foot, tested |
| C7-m1 | C | "at least 12 units" disagrees with GRO's "12 units or three courses" | both quoted, each with its stage and source |
| C7-m2 | C | the box omits the W and F grades and that rejected courses are likely still unavailable | both added, cited |
| C7-m3 | C | the page's own sentences sit inside quotes credited to GRO | each NUS line cited separately; the page's line set apart and reworded ("This page can't see your offer") |
| C7-m4 | C | the update-months line implies the April list is final | "updates it later (this one is dated 1 Sep 2026)" |
| C7-m5 | C | GRO says the portal bars clashing exams, but the form order numbers both | an entry whose exam overlaps one above it gets no number, pending 6-0's portal check |
| C7-m6 | C | invited Business students aren't told the 50% rule | the factsheet's line on Business rows |
| C7-m7 | C | the level labels aren't NUS Global's | the brochure's for 1000–4000, the Registrar's "graduate" above |
| C7-m8 | C | nine questions; G4 and G6 are settled by NUS's text; G9 is a fact; G5 omits the phone route and claims structure before 6-0 | G4 and G6 lead rules; G7 asked only if 6-0 finds nothing; G4 (PDF) gives the iPhone route and leaves structure to 6-0. G1 stays a question: it decides what SC3's "syllabus text" means |

### Round 8 (fresh critics on r8)
Found sound by round 8: WebKit's and real Chrome's history limits against the 80-write budget
(probed), `page.pdf()` firing the print events, the PDF link check, moving the neighbour
mid-page, the row and toggle semantics, `show()` held back while the view is shown (A); every
§1 count re-run, the fixture codes behind the tests, `catalogue_only`'s primary key, the
rollback and pin (B); GRO's and the brochure's lines word for word, the application guide, the
Canvas line, G1, G2's rate, the Business 50% line, the language form's scope, G4, G5 and G7 (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A8-M1 | A | a successful Move or Remove announces nothing | every edit says what it did ("CS3244 moved up: pick 2 of 6, number 2 on the form"); live spec |
| A8-M2 | A | Move down near the top of the page pushes the focused button off screen (probed: 441 → 1,100 px in both engines) | `scrollIntoView({ block: 'nearest' })` after every focus-keeping edit; tests assert `toBeInViewport()` and not covered |
| A8-m1 | A | the shortlist button pressed in the view pushes a second view entry | no history write; focus on the heading; history test |
| A8-m2 | A | Back into the view has no focus rule | focus on the view's heading, as Forward; test after a submit from the view |
| A8-m3 | A | the print tests can't tell a shortlist-only print from a whole-page one | under print media every sized box lies in the print section, and the PDF text starts with the head; the colour check also runs without the print class |
| A8-m4 | A | the export actions sit after every row (200+ Tab stops); no focus target after Forget or Restore | actions under the view's heading; focus on the heading after both |
| B8-B1 | B (blocking) | NG-listed codes with no classes skip NUS's restrictions (PF2102 at grad shown as to confirm) and lose faculty and notes | `ng-unscheduled.json` holds each code's fields and the `ng_allow`/`ng_rules` that `eligibility()` gives, and the 404 answers `exchange` from them; a tag outside its listed semesters is closed; in the SC1 run |
| B8-B2 | B (blocking) | the bundled no-row list can't match both CI's pinned snapshot and production's D1 (32 vs 40 codes, 10 differ) | its own file, built per corpus as `groups.json` is (production checked against `vectors.json`'s data version, a fixture file for tests, `--check`), checked against D1 in `verify --pre-deploy`; `ng-reasons.json` unchanged |
| B8-M1 | B | the exam bar ignores the double numbering (ACC1701XA and BN2201) | moot: exam overlaps no longer remove numbers (C8-B1), and the double numbering is gone (C8-m3) |
| B8-M2 | B | 2027/28 applicants lose form numbers on 2026/27 exams | = C8-B1 |
| B8-M3 | B | totals count entries the form would bar | the bar is gone; a totals line says NUS approves at most one of each overlapping pair; the form line gives the units on the form |
| B8-m1 | B | the classless codes' twins (NGN2001D with NGN2001A) aren't caught as the same course | `otherCodes` and `preclusion` in `ng-unscheduled.json`; tested |
| B8-m2 | B | whether a marked entry keeps a number is unsaid; a test contradicts it | a past-40 entry takes no number and the next fitting one takes the next; tests corrected |
| B8-m3 | B | the "Includes" line can't name Business or Law (never counted) | it covers to-confirm units; Business and Law use their row's line |
| B8-m4 | B | a backup that is the same course as a pick is underspecified | a duplicate: neutral line, no number, out of the sum, no flag; tested with ACC1701XA and XC |
| C8-B1 | C (blocking) | the form order drops courses on 2026/27 exams for 2027/28 applicants, whose timetable comes in mid-July | exam overlaps never take a number away; the flag is worded for the year you go; the form section says which year's list and exams it uses |
| C8-M1 | C | "you can add it only if NUS gave it to you at the offer" is wrong for invited Business students, who add Business electives in CourseReg; NUS Law registers its own | scoped: the Business School and Law lines for invited students, the "can't add" line only for students not invited |
| C8-m1 | C | G3's 20 rests on an old FAQ text; current sources say 23 with a waiver | G3 recommends 23 (Business School's students 20) and the Max Workload Waiver; §1 marks the old text |
| C8-m2 | C | the form may cap at 10 courses (partner guides) | entries past the 10th marked "may take only 10" until 6-0 settles it |
| C8-m3 | C | an invited Business student's totals read 0 counted, and the double numbering confuses an advisor | two invitation checkboxes (`inv`), shown only when the list holds Business or Law; ticked, those courses are worked out like any other; one numbering |
| C8-m4 | C | the box quotes only "would likely be unavailable"; the CourseReg FAQ allows requests and appeals | the FAQ's request, appeal, no-clash and minimum lines replace the slides' line |
| C8-m5 | C | GRO's "don't repeat requests for popular courses" line is missing | added to the lines for applicants |

### Round 9 (fresh critics on r9)
Found sound by round 9: the history budget against both engines (re-probed), `scrollIntoView`
under a sticky header, the empty `<ol role="list">` under axe, the controls and focus rules,
the history table, print and export checks (A); every §1 count re-run against production,
pinned and fixture, `eligibility()` on the 40 classless codes, the groups, preclusion and exam
counts, the unchanged CSV, D1 and cost (B); every GRO, brochure, NG list, CourseReg FAQ and
Business factsheet quote, flagging rather than dropping exam overlaps, one ranked list, G1, G2,
G4, G5, G6 (C). No blocking objection.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A9-M1 | A | the shortlist button's label (249–362 px, `nowrap`) overflows the 210–236 px rail and a 320 px phone; no test measures it | the label wraps on two lines; the reflow loop runs the longest label at every width; the rail button's right edge asserted at 641, 900, 1280 |
| A9-m1 | A (minor) | Back can't undo an edit; Forget's scope is unsaid | Remove gets an Undo; "Forget this list on this device" clears only the device copy |
| A9-m2 | A (minor) | the restore offer isn't in the fold check | added |
| A9-m3 | A (minor) | the fallback field and the loading button states aren't in the axe list | added; the field labelled "Shortlist link" |
| A9-m4 | A (minor) | Escape in the phone dialog over the view is untested | `app.js:745`'s guard kept; test at 390×664 |
| A9-m5 | A (minor) | a course head can end a printed page alone | `break-after: avoid` on the head |
| B9-M1 | B | a closed pick makes its open twin a duplicate, so the course leaves the form (GES1034.2 with GESS1024.1) | only counted and to-confirm entries take part in the same-course rule; tests on both cases |
| B9-M2 | B | `ng-unscheduled.json` lacks workload, prerequisite and grading, so exports say "not listed" and ESP4403 loses its year note | the file adds `workload`, `prerequisite` and `gradingBasis`; the export test covers its codes |
| B9-M3 | B | with no year of study, off-list courses get form numbers (CS5562) | the form order exists only in exchange mode; SC1 run in browse mode too |
| B9-M4 | B | NGN2001A, FIN3701B (an offered fixture row) and GESS1025 can't come from the fixture | NGN2001G, PF2505, ESP4403 and PLS8002A instead; Business no-class by a synthetic detail |
| B9-m1 | B (minor) | an offered code's groups never list its classless twin | either side's `otherCodes`; both orders tested |
| B9-m2 | B (minor) | the eval config needs the new alias | `vitest.eval.config.mjs` aliased too |
| B9-m3 | B (minor) | CI's pinned corpus has rows for 9 of the 40; PL3265 is classless only there | the "no offered row" check skips in CI; the SC1 run builds the pinned set in memory |
| B9-m4 | B (minor) | a rollback also drops `inv` | noted |
| B9-m5 | B (minor) | "Economics courses" in the totals is undefined | EC-coded, as the row notes |
| B9-m6 | B (minor) | the preclusion flag can fire on a closed pick | counted or to-confirm picks only |
| B9-m7 | B (minor) | "each has preclusion text" (17 do); "naming each other" (either) | corrected |
| C9-M1 | C | the year of study isn't said to be the year during the exchange, which NUS's portal and restrictions use | the export question, the head and the rail's control say "during your exchange"; aria snapshots updated |
| C9-M2 | C | rule E's "may be available" contradicts three departments' no-appeal rules; the section heading contradicts rule E | those rules' text overrides rule E for their codes; the section renamed "Closed, or not on NUS's exchange list, in that semester" |
| C9-m1 | C (minor) | "invited by NUS Business School" may read as not applying to a partner-nominated student | "Is your exchange with NUS Business School (it invited you to apply, through its own partnership)?" |
| C9-m2 | C (minor) | G3 cites the CourseReg FAQ for "23 a semester" | the citation fixed |
| C9-m3 | C (minor) | the 10-course cap may be per semester | the mark replaced by one hedged line under the form heading; 6-0 weighs the older guide |
| C9-m4 | C (minor) | advisors need total hours | per course and per semester: "about 130 hours in all" |
| C9-m5 | C (minor) | carry the NG list's class number into the export | declined: class times and classes are out of Phase 6's scope (the plan's header), and a class number from 2026/27's list would mislead 2027/28 applicants |
| C9-m6 | C (minor) | the Excel hint is only on the page | in the CSV's foot too |

### Round 10 (fresh critics on r10)
Found sound by round 10: history after reload and Back (re-probed), links the page renders,
Escape with the phone dialog, the live region inside the dialog, the focus and scrolling rules,
the history writer's budget, Copy link, dark print colours, reflow and rail-width checks (A);
every count re-run over the production cache at data version `d820d578cf81`, `eligibility()` on
the 40, the preclusion matcher, exams, units and hours, CSV safety, the eval workspace and the
deploy's data-version check (B); every GRO, CourseReg FAQ, NG list, portal guide, brochure and
Business factsheet quote, the relabelled year, flagging exam overlaps, G1, G4, G5, G6 (C).

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A10-M1 | A | under print the section sits in the rail's 210 px grid column once the rail is hidden (probed: 26 pages for 40 courses against 10); no test measures width | the grid ancestors reset to `display: block` under print; the section at least 95% of the content width at 718 px; `page.pdf` on A4 with 10 mm margins and a page-count bound |
| A10-M2 | A | in browse mode the export question's year is dropped (`study` survives only with `ng`, `app.js:273`, `state.js:96`) | answering turns on exchange mode, as the question says; test that the CSV downloads and the URL shows `ng=1&study=ug2` |
| A10-M3 | A | the first screen still asks for the year "at your home university" (`index.html:50`, `app.js:656`) | relabelled with the rail and the dialog; `setup.spec.js` and snapshots updated |
| A10-m1 | A (minor) | semester buttons are said to move the row, which invites a re-render | the button keeps its element and changes its text; on an untagged row the pressed one stays |
| A10-m2 | A (minor) | the print class needn't depend on `afterprint` | derived from state; `afterprint` restores only the title |
| A10-m3 | A (minor) | ticking an invitation changes totals silently | it says what changed |
| A10-m4 | A (minor) | announcements after a focus move are checked as text only | recorded in §4's risks |
| A10-m5 | A (minor) | "Shortlist" names both the toggles and the view button | the button says "Your shortlist" |
| B10-M1 | B | the no-appeal rules' texts and scopes are nowhere the page can read | `ng-reasons.json` gains the four off-list info rules with their scopes, transcribed and tested against the quoted text |
| B10-M2 | B | rule E's "may be available" contradicts GRO for off-list Economics and Law courses (EC3304) | EC codes and Law courses get GRO's "can't be added unless secured at the point of offer" |
| B10-m1 | B (minor) | the fixture file can't make NGN2001D and NGN2001G one course | the fixture build matches against the fixture corpus too |
| B10-m2 | B (minor) | "same course" isn't transitive (CS2103, CS2103DE, CS2103R) | an entry is compared only with kept entries, in rank order; tested |
| B10-m3 | B (minor) | "same title and description" is false for 223 pairs | "the same title" |
| B10-m4 | B (minor) | pre-deploy verify rows carry no `acad_year` | added to `/admin/verify`'s rows, with its test, in 6A |
| B10-m5 | B (minor) | semester buttons follow NUSMods, not the NG list (ACC1701XB) | in exchange mode, the semesters taught in or listed for |
| B10-m6 | B (minor) | CS3244 is closed in Sem 1, so the Sem 1 examples never count | CS2113 and GE2101 instead |
| C10-1 | C (blocking) | NUS has asked full-year students to choose Sem 2 courses later, so one numbered list for the year misleads them and pushes Sem 1 backups past 40 | each semester numbered on its own against 40; a full-year list's Sem 2 order says NUS may ask for it later; exports grouped by semester; G7 rewritten; recorded as a risk until 6-0 finds a current source |
| C10-m2 | C (minor) | "130 hours" is the page's arithmetic, not NUS's | the rate cited to the transcript legend and the brochure; the total labelled as the page's estimate |
| C10-m3 | C (minor) | invited Business students may only list core BBA courses at application | the factsheet's line on ticked Business rows |
| C10-m4 | C (minor) | NUS's own slides said "up to 10 relevant modules" | cited; entries past the 10th in a semester marked |
| C10-m5 | C (minor) | G3 over-reads the CourseReg FAQ | 23 rests on the brochure; G3 recommends asking NUS before going above 20 |
| C10-m6 | C (minor) | "list up to 40 units" isn't true at CourseReg | moved to the lines for applicants |
| C10-m7 | C (minor) | every nominated student gets a Business-branded link, so "invited" misleads | "Did NUS Business School nominate you under its own exchange agreement (not your university's university-wide one)?" |
| C10-m8 | C (minor) | "Sem 1: 12 units" counts `major`-note courses | "12 units picked" |

### Round 11 (fresh critics on r11)
Found sound by round 11: moving the neighbour and Make backup keeping `:focus-visible` in both
engines (probed), `scrollIntoView` with `scroll-padding-top`, WebKit's one-frame focus scroll,
the history writer, popstate, the view's history rules, the toggle, lists, print class and
grid reset, axe's rule set, the reflow codes (A); every count re-run (the 40 classless codes,
their closures and twins, groups, preclusions, exams, units, hours, CSV text), every fixture
expectation in 6A and 6B, the data version guard, rollback and pin (B); GRO's current page, the
brochure, the Registrar's legend, the CourseReg FAQ, the portal guides, `ng-courses.pdf`,
per-semester numbering, flagging exam overlaps, the same-course rule, SC1 over the shortlist
(C). No blocking objection.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A11-M1 | A | the export may start when the question's last control changes; arrowing through the year radios checks each (WCAG 3.2.2) | answers apply on change; the export starts only from the question's own buttons; keyboard test arrows through the radios with no download and no `print` |
| A11-M2 | A | nothing says where focus goes or what is said when the question appears | rendered under the actions row; the press focuses its heading and says "Two questions before your download"; tested in view |
| A11-m3 | A (minor) | Undo is hard to find | the Remove sentence says where Undo is |
| A11-m4 | A (minor) | Safari's PDF file name is unchecked (`afterprint` may fire early) | the 6-0 Safari check records it |
| A11-m5 | A (minor) | the print button's name changes while loading | names kept; progress in an `aria-describedby` line |
| A11-m6 | A (minor) | Download CSV before rows load is unspecified | the same as print: "Ready: press again to download" |
| B11-M1 | B | untagged backups get no question and no section (`alt=CS2030`) | the question covers untagged backups; anything still untagged goes in "Not placed in a semester"; tests |
| B11-M2 | B | the off-list rule texts in `ng-reasons.json` never reach the page | `/facets` gains `offListRules`, shape pinned in the smoke test; 4-cee's scope is the CEE department (CE, ESE, GEC) |
| B11-m3 | B (minor) | the year note and detail still say "at your home university" | `src/year-note.js:121` and `public/detail.js:151` relabelled too |
| B11-m4 | B (minor) | the search box and the shortlist disagree on the 40 classless codes | `/search` reads `ng-unscheduled.json` first and says the same |
| B11-m5 | B (minor) | "no final exam listed" misreads for classless codes | "exam timetable not published in NUSMods" |
| B11-m6 | B (minor) | a CE2xxx pick and GEC1028 aren't in the fixture | marked synthetic |
| C11-M1 | C | "Did NUS Business School nominate you" asks the wrong question: home universities nominate, the Business School invites | NUS's words: "invite you to apply … (an invitation during the nomination period)"; §1's GRO quote completed |
| C11-M2 | C | "about 130 hours" is the page's arithmetic and can undercount an ECTS conversion | no semester or course total; hours a week only, with "your university's own conversion decides credit"; G1 changed to match |
| C11-m1 | C (minor) | the Business `quota` note reads as a chance next to "only if invited" | shown under that line as "If you were invited: …" |
| C11-m2 | C (minor) | the language placement test and Law's English test are missing | both added as NUS's notes, cited |
| C11-m3 | C (minor) | a ticked Business elective still gets a plain form number | "Sem 1 form: 3, if it's a core BBA course" |
| C11-m4 | C (minor) | the CourseReg box omits the Vacancy Report | added |
| C11-m5 | C (minor) | G1, G2 and G4 all ask what SC3 means; G6 is dense; G7 may be settled by 6-0 | merged into G1; G4 (admitted students) in plain words; G5 asked only if 6-0 finds nothing; five questions |

### Round 12 (fresh critics on r12; the last round, by the lead's call)
Found sound by round 12: the history writer and view history table (re-probed), moving the
neighbour and `scrollIntoView` under the sticky header, the card toggle's width in the 120 px
column, Escape and the live region in the phone dialog, the print class, grid reset and print
tests, the export question's no-download-on-arrow rule (A); every count re-derived again over
production, pinned and fixture, the 40 classless codes' closures, workloads and year note, the
fixture expectations, pre-deploy verify, cost, rollback and pin (B); GRO, the brochure, the
CourseReg FAQ, `ng-courses.pdf`, the portal guide, the Business factsheet and the 2018/19 sheet,
the five gate questions (C). No blocking objection.

Jacob asked during round 12 that minors which are only a critic's preference be ignored; the one
so judged is marked declined.

| # | Critic | Objection | Resolution |
|---|---|---|---|
| A12-M1 | A | the add sentence is spoken before the course's row loads, so the spoken total omits it and the real one is never said | the add sentence waits for the row to settle, up to 2 s; test with `/module` held |
| A12-m2 | A (minor) | an untagged course taught in one semester loses focus or offers an impossible move (CS5562) | the pressed button becomes `aria-disabled` "Sem 2 chosen"; tested |
| A12-m3 | A (minor) | a card toggle turned off loses the entry's list, rank and semester | the removal says where it was and offers Undo beside the shortlist button |
| A12-m4 | A (minor) | text typed in the box is lost when the view closes | kept on close by Escape or Back; tested |
| A12-m5 | A (minor) | the CSV "press again" path is untested | tested in both browsers |
| A12-m6 | A (minor) | the "done" sentence can overwrite an edit's | skipped within a second of an edit |
| A12-note | A (note) | Playwright WebKit doesn't scroll for a programmatic `focus()` | in-view checks drive real key or click input |
| B12-M1 | B | the search box calls 9 of the 40 classless codes unknown (`catalogue-codes.json` is the pinned set), contradicting the shortlist | `/search` checks `ng-unscheduled.json` before its unknown-code branch; Worker test with a code absent from `catalogue-codes.json` |
| B12-m1 | B (minor) | 4-cee's scope written as CE, ESE and GEC codes; GEC is mostly other departments | matched on the department, never by prefix |
| B12-m2 | B (minor) | `otherCodes` defined two ways for the classless codes | groups-v1 over offered rows plus the file's codes |
| B12-m3 | B (minor) | nothing in CI checks the production file's masks | a CI test recomputes each entry's mask with `eligibility()` from its own fields |
| B12-m4 | B (minor) | one-pass same-course settling can keep a to-confirm code over a counted twin (NGN2001D before NGN2001G) | counted picks settled first, then to-confirm; tested both orders |
| B12-m5 | B (minor) | catalogue-only 404s answer no description | the 404 carries it |
| B12-m6 | B (minor) | with `/facets` down, off-list closed entries fall back to rule E, which department rules contradict | "ask NUS whether it can be added later" instead |
| B12-m7 | B (minor) | the Move test passes either way; the CS9999 download test skips the export question | the Move test asserts URL order and a same-semester number; the download test sets `ng=1&study=ug2`, and browse mode asks first |
| B12-open | B (minor) | 162 production catalogue-only codes are missing from `catalogue-codes.json`, so search calls them unknown while `/module` says "not offered in 2026/27" | **open, for the lead**: a pre-existing gap in the pinned code list, outside the shortlist; logged for Phase 7's data work |
| C12-M1 | C | "not secured at the offer can't be added" paraphrases GRO as a per-course rule NUS doesn't state, and contradicts NUS Business School's CourseReg electives | GRO's sentence quoted word for word wherever the rule appears; the paraphrase and the made-up quotation dropped |
| C12-M2 | C | the PDF never gives the semester's length, so an advisor can't work out study time | GRO's "13 weeks of instruction and 2 weeks of examinations" quoted in each semester's totals and the foot; G1 corrected |
| C12-m1 | C (minor) | uninvited Business and Law units sit in the to-confirm sum | their own line, "plus 8 units only if invited" |
| C12-m2 | C (minor) | students may not know whether they were invited | "If you're not sure whether you were, ask your exchange office" |
| C12-m3 | C (minor) | the full-year Sem 2 line could cite the August list dates | **declined** (a preference: the line already tells the student to check with NUS, and §1 holds the dates) |
| C12-m4 | C (minor) | admitted students may read form numbers as limits on them | labelled "Application form, Sem 1: 2" |

Convergence: round 12 raised no blocking objection; its three majors and the minors it rated
real were fixed in r13. The lead stopped the rounds at 12, so r13 itself has not been critiqued;
one item is open for the lead (B12-open).
