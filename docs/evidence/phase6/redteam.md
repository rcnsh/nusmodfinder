# Phase 6 red team (6E, plan §3 6E "Red team")

Three personas on the live page: an admitted Sem 2 student who exports both files, a full-year
2027/28 applicant on a phone with a keyboard, and a home-university advisor who has only the
applicant's link and PDF. Run on 2026-11-11 (UTC) against NUS Mod Finder at
`https://nusmodfinder.rcn.sh`, version `f8aefeab` (commit `0b5f360`; every API answer carried
`x-app-version: 0b5f360`). The kit is in `redteam/`, Phase 5's kit extended; its `README.md`
lists every file.

## Method
- **Rules before the run.** Commit `8130d7c` fixed, and pushed before any persona started:
  - every persona's context and brief facts (`redteam/personas.json`);
  - the brief-to-answer rules (`redteam/rules.mjs`). This is Phase 5's table (most restrictive
    wins) with the rows the plan adds:
    - Business and Law: "yes if invited, or already given";
    - `audition`: "ask NUS: apply separately";
    - an NG-listed 404: "ask NUS".

    It also carries R3's `year` note as Jacob ruled after Phase 5 (ask NUS), and one new rule
    for the advisor: a brief fact the persona doesn't know makes a "yes if".
  - `redteam/expected.json`: the expected answer for every course offered in 2026/27 and every
    NG-listed code with no classes, for each persona and semester. That is 6,778
    production-normalised modules, as `p5-live --corpus production` loads them, plus 40 from
    `data/ng-unscheduled.json`. The answers come from the SC1 oracle
    (`test/sc1/oracle.node.mjs` `explainShown`) and the brief alone.
  - `redteam/advisor.mjs`: how the advisor's answers are worked out from whatever link it is
    given. That covers the order on NUS's form, department, level, units, hours, description,
    open or not, and year. It reads production's rows and the independent reference,
    `test/web/shortlist-reference.node.mjs`.

  `diff.mjs` recomputes each p1 and p2 answer and refuses to run if one differs from the
  pushed table. Every oracle note mapped to a kind, in every persona context.
- **Blind personas.** Each persona was a fresh subagent. It read only its brief
  (`redteam/briefs/common.md` and `<id>.md`; the advisor read `p3.filled.md` alone) and used
  the site only through `act.mjs`, which drives a browser held by `session.mjs`. It never saw
  the plan, this kit, the oracle, the rules or the expected answers. The brief line Phase 5
  asked for is in: "If the site says it can't tell and to check with NUS or a department …
  answer ask NUS".
  - **p1:** admitted for Sem 2 2026/27, a 3rd-year Geography and Environmental Studies
    undergraduate, planning CourseReg changes on a laptop (Chromium, 1280×800, mouse and
    keyboard).
    - NUS gave GE2231, GE3204 and ENV3104 at the offer, and no Business, Law or Economics
      course. p1 was not invited by NUS Business School or NUS Law.
    - Takes everything graded and pays no fees. Partner status is unknown.
    - Told to check one Business School sustainability course, then export the CSV and the PDF.
  - **p2:** a full-year 2027/28 applicant, a 3rd-year Mathematics and Statistics undergraduate,
    on a 390 px phone (Chromium with the iPhone 13 profile) using the keyboard only.
    - Takes everything graded and pays no fees. Not a partner of any school, not invited.
    - Told to build about 4 picks a semester plus 2 backups, switch Sem 1 and Sem 2 while
      browsing, and rank a Sem 2 course first.
    - Told to copy the link, save the PDF, and say what the page says about listing Sem 2
      courses.
  - **p3:** the advisor. It got two things and nothing else: p2's copied link
    (`redteam/artifacts/link.txt`) and p2's PDF, the same bytes p2 saved, copied into the
    advisor's own folder. It answered the plan's six questions from those alone. The answers
    are diffed at the link's study level, with no student facts.
- **Exports outside the page.** `session.mjs` saves what a browser would hand the user:
  - a download, which is the CSV;
  - `window.print()`, printed to PDF with Chromium's `page.pdf` (A4, 10 mm margins, tagged,
    print media), as "Save as PDF" does. iOS's print path stays untested, as the plan's risks
    say;
  - what the page writes to the clipboard.

  These are in `redteam/artifacts/`, with the view's text at the moment of printing.
- **The page's 10 s timeout.** The page loads rows four at a time, each with 10 s
  (`public/api.js` `SEARCH_TIMEOUT_MS`). The gate's 4 s spacing would push the later ones past
  that, which is an artefact of the run, not the site. `p6-live` avoids it by fetching first;
  here the session stretches the page's 10 s timers to 4 minutes. No row failed to load.
- **Live traffic.** Every request goes through one gate shared by every session:
  - one request at a time, each starting at least 4 s after the previous one ended (Phase 5
    measured start to start);
  - the page's files are fetched once for every session and then served from a shared cache;
  - an API answer with `max-age` is served from that cache for that long;
  - at most 400 requests in all, and 130 per persona;
  - anything that isn't a GET to the live host is refused.

  Every request is logged in `redteam/requests-<id>.jsonl`, whether sent, served from cache or
  refused. Before any persona ran, I smoke-tested the session on the live page with my own
  two-entry link (`requests-smoke.jsonl`): print, download and copy all worked. Its page files
  went into the shared cache. The personas ran one after another.

## Live requests
| session | sent | from cache | refused |
|---|---|---|---|
| smoke (the lead) | 34 (31 page files, 1 `/facets`, 2 `/module`) | 34 | 0 |
| p1 | 17 (8 `/search`, 9 `/module`) | 32 | 0 |
| p2 | 30 (18 `/search`, 12 `/module`) | 67 | 0 |
| p3 | 4 (4 `/module`) | 38 | 0 |
| **total** | **85** (all 200): 31 files, 1 `/facets`, 26 `/search`, 27 `/module` | 171 | 0 |

- **Time range:** first request at 2026-11-11T19:31:19.305Z, last at 2026-11-11T19:48:14.734Z.
- **Spacing:**
  - No two requests overlapped.
  - The closest pair started 4,023 ms apart. The gate waits 4 s after a request ends, so no
    two starts can be closer than that.
  - At most 3 requests fell in any 10 s window.
- No request went anywhere but the live page and its API. No deploy, no wrangler, no eval run.

## Results: the mechanical diff (`redteam/diff.mjs` → `redteam/diff.json`)
| persona | answers | agree | disagree |
|---|---|---|---|
| p1 (Sem 2, admitted, laptop) | 6 | 6 | 0 |
| p2 (full year, applicant, phone + keyboard) | 11 | 0 | 11 |
| p3 (advisor, link + PDF): open or not | 10 | 0 | 10 |
| p3: the other facts (rank, form number, department, level, units, hours; each semester's totals; year) | 70 | 70 | 0 |
| **open-or-not total** | **27** | **6** | **21** |

The advisor's "what each course covers" isn't diffed mechanically. I compared its 10 sentences
with NUS's descriptions: all 10 match.

Every answer:

| persona | code | sem | list | persona's answer (short) | expected | note kinds (oracle) |
|---|---|---|---|---|---|---|
| p1 | GE2231 | 2 | pick | yes | yes | given |
| p1 | GE3204 | 2 | pick | yes | yes | given |
| p1 | ENV3104 | 2 | pick | yes | yes | given |
| p1 | GEC1030 | 2 | pick | yes | yes | none |
| p1 | PF3504 | 2 | backup | yes if I get one of the limited places | yes if | graded, quota |
| p1 | DOS3714 | 2 | checked | no | no | closed: not on the NG list |
| p2 | ST4234 | 2 | pick 1 | yes if [2027/28 list] and [4000 place] | **yes** | none |
| p2 | MA4251 | 2 | pick 2 | yes if [2027/28 list], [4000 place], [prereq] | **yes** | none |
| p2 | ST3247 | 2 | pick 3 | yes if [2027/28 list], [prereq] | **yes** | none |
| p2 | ST2137 | 2 | pick 4 | yes if [2027/28 list] | **yes** | none |
| p2 | MA3210 | 1 | pick 5 | yes if [2027/28 list] | **yes** | none |
| p2 | ST3131 | 1 | pick 6 | yes if [2027/28 list] | **yes** | none |
| p2 | ST3236 | 1 | pick 7 | yes if [2027/28 list] | **yes** | none |
| p2 | ST3248 | 1 | pick 8 | yes if [2027/28 list] | **yes** | none |
| p2 | ST4253 | 1 | backup 1 | yes if [2027/28 list] and [4000 place] | **yes** | none |
| p2 | ST4248 | 2 | backup 2 | yes if [2027/28 list], [4000 place], [prereq] | **yes** | none |
| p2 | MA2401 | 2 | checked | no [preclusion] | **yes** | none |
| p3 | ST4234 | 2 | pick 1 | yes if [4000 place] and [prereq] | **yes** | none |
| p3 | MA4251 | 2 | pick 2 | yes if [4000 place] and [prereq] | **yes** | none |
| p3 | ST3247 | 2 | pick 3 | yes if [prereq] | **yes** | none |
| p3 | ST2137 | 2 | pick 4 | yes if [prereq] | **yes** | none |
| p3 | MA3210 | 1 | pick 5 | yes if [prereq] | **yes** | none |
| p3 | ST3131 | 1 | pick 6 | yes if [prereq] | **yes** | none |
| p3 | ST3236 | 1 | pick 7 | yes if [prereq] | **yes** | none |
| p3 | ST3248 | 1 | pick 8 | yes if [prereq] | **yes** | none |
| p3 | ST4253 | 1 | backup 1 | yes if [4000 place] and [prereq] | **yes** | none |
| p3 | ST4248 | 2 | backup 2 | yes if [4000 place] and [prereq] | **yes** | none |

In the table:
- **[2027/28 list]** means "NUS's 2027/28 exchange list still offers it in that semester".
- **[4000 place]** means "NUS has a place in a level-4000 course".
- **[prereq]** means "the student has completed, or NUS accepts the equivalent of, the
  prerequisite".

The full answers are in `redteam/diff.json` and `redteam/answers/`.

Every disagreement has the same shape: the page shows "Open" with no oracle note, and the
persona added a condition the answer table has no row for. No persona answered yes or "yes if"
to a course the oracle closes. Every "no" the oracle gives was found: DOS3714 for p1, off the
NG list and a Business course not given at the offer.

### The 21 disagreements, classified
Three causes, each a **source ambiguity for Jacob**. An answer can carry several. Once each is
ruled, every disagreement is settled:

| cause | answers |
|---|---|
| R6-1: the year | p2's 10 list answers |
| R6-2: NUS's level-4000 note | p2's and p3's ST4234, MA4251, ST4253, ST4248 (8) |
| R6-3: prerequisites and preclusions | p2's MA4251, ST3247, ST4248, MA2401; p3's 10 |

Under each recommendation below, p2's ST2137, MA3210, ST3131, ST3236 and ST3248 agree outright
(R6-1 alone). The rest resolve to "yes if" (R6-2) or to persona errors (R6-1, R6-3).

- **R6-1: does a 2027/28 applicant's answer carry the next year's list?**
  - p2 answered "yes if NUS's 2027/28 exchange list still offers it" for all 10 courses on its
    list.
  - The page says, in the form section and the PDF: "This order uses NUS's 2026/27 exchange
    list and exams. Applying for 2027/28? NUS publishes Sem 1's list in March or April, Sem
    2's later … check each course there."
  - The plan fixes the expected answers from the 2026/27 oracle.
  - p2 read the page correctly. The condition applies to the whole list, and the page says it
    once for the list.
  - *Recommendation:* the expected answers stand. The year is a property of the list, not a
    per-course condition. That makes these persona answer-scale errors, and a future applicant
    brief should say how to answer for a later year.
- **R6-2: is NUS's level-4000 note a "yes if (a place)"?**
  - On level-4000 rows, the page shows GRO's line, a 6B "NUS's notes on particular picks" lead
    rule, under the "Open" stamp: "Higher level undergraduate courses (e.g. course code
    starting from 4000 & above) have very limited supply and are usually NOT available to
    exchange students".
  - The oracle gives no note, and the table has no row for these lead-rule notes. That covers
    the level-4000, oversubscribed, language-form and master-level notes.
  - Both personas independently read it as "yes if NUS has a place", and p2 also listed it
    among its problems: "Open" beside "usually NOT available".
  - *Recommendation:* treat it as `quota` (yes if). The page's wording supports that reading,
    and Phase 5's table already treats limited places that way. If Jacob agrees, these 8
    answers agree on this kind.
- **R6-3: does "open to the student" include prerequisites and preclusions?**
  - Phase 5's table, and this one, decide exchange eligibility only; R3's year note is the one
    prerequisite rule.
  - The advisor, who knows nothing of the student's record, made every answer "yes if the
    student has completed the equivalent of …". p2 did the same for prerequisites met inside
    its own list (MA4251, ST4248) or by a home course (ST3247's CS1010).
  - p2 answered MA2401 "no" by its preclusion ("must not have completed … any Courses
    beginning with MA2 … MA3"), reasoning that its home maths courses count.
  - The advisor's brief contributed. Its examples of student-dependent conditions ("their
    major, how they take the course, an invitation") read as inviting prerequisites in. That
    wording was mine, in `briefs/p3.md`.
  - *Recommendation:* keep eligibility only, as Phase 5 did, which makes these persona errors.
    The next brief should say that prerequisites are the department's to check and don't
    change the answer.

**Page defects among the disagreements: 0.**

## The live totals against the independent reference (`redteam/totals.mjs` → `redteam/totals.json`)
I checked each export the personas made against `test/web/shortlist-reference.node.mjs` over
production's rows (through `advisor.mjs`), at the link each export carries.

| export | Sem 1 counted / to confirm / if invited | Sem 2 counted / to confirm / if invited | equals the reference |
|---|---|---|---|
| p1 CSV, view at printing, PDF | — | 16 / 0 / 0 | yes, all three |
| p2 view at printing, PDF | 16 / 0 / 0 | 16 / 0 / 0 | yes, both |

- p1's CSV has a byte-order mark, its rows all have the header's field count, and it holds all
  5 entries.
- p1's PDF holds all 8 of the CSV's totals lines.
- Both PDFs hold every entry's description.
- p2 made no CSV, which its plan didn't ask for.
- The advisor's semester totals (16 and 16 units, about 40 hours a week each) and all 10 form
  numbers equal `advisor.mjs`.

## Page findings from the personas' reports (outside the diff)
I checked each issue the personas reported against the code, the plan and the approved 6-0
mockup. I fixed nothing.

- **RT6-PD1: the view's subheading names only the semester filter, not the list's semesters.
  Page defect, minor (copy).**
  - p2's list has picks in both semesters, and its link carries `sem=2`. The view says "Sem 2
    · 3rd-year exchange student · NUS's 2026/27 courses".
  - p2 said the heading reads as one semester, and the advisor said "At first glance it looks
    like a one-semester plan".
  - `public/shortlist-view.js:558` builds the line from `m.sem`, the semester filter.
  - The approved mockup's full-year state, "Sem changed to 2 in the view"
    (`docs/design/phase6-shortlist/a/mockup.js` `stateFullYear`), reads "Sem 1 and Sem 2 ·
    2nd-year exchange student · NUS's 2026/27 courses". ADR 0010 approved that mockup "as
    shown".
  - The PDF's head already names both semesters ("Sem 1 and Sem 2"), so only the view is wrong.
  - **Local repro:** `node docs/evidence/phase6/redteam/repro/page-issues.mjs`. It loads
    `public/` from disk in Chromium at 390×664, answers `/facets` and `/module` with the live
    answers p2 received (`repro/answers/`), and sends nothing anywhere. It prints `the view's
    subheading reads "Sem 2 · 3rd-year exchange student · NUS's 2026/27 courses"` and exits
    1. It exits 0 once fixed.
  - Fix: name the semesters the entries hold ("Sem 1 and Sem 2" when they span both), as the
    mockup does.
- **RT6-SA1: "Not open. You cannot take it in that semester" at the CourseReg stage. Source
  ambiguity: Jacob rules on scope.**
  - p1 is admitted and in CourseReg. The search page's key (`public/app.js:1051`) says "Not
    open. You cannot take it in that semester."
  - The shortlist's CourseReg box quotes the Registrar's rule E: courses not on the exchange
    list "may be available during Course registration".
  - The plan asks for "lines that read true at both stages" (its opening summary, "no CourseReg mode"). The key and the detail are
    Phase 5's lines, and the plan doesn't say whether that rule reaches them.
  - For p1's own case, a Business course not given at the offer, "no" is right by GRO's line.
    The key's line is too strong only for off-list non-Business, non-Law, non-Economics
    courses.
- **RT6-SA2: two dates for the timetable. Source ambiguity.**
  - The export's head says NUS "publishes the course descriptions and exam timetable in July
    or August (NUS Global)" (`public/export.js:326`).
  - The form section says "the timetable in mid-July" (`public/shortlist.js:140`; the
    Registrar's NG list: "published mid-July").
  - Both are spec'd and cited (plan 6B, 6D). The sources differ, and p2 noticed. Jacob may
    want one line, or both with their sources side by side.

Checked and not page defects (each as the plan or the approved mockup says):
- **Levels in the exports are bands** (p1, p3): "Level 1000–3000, undergraduate", "Level 4000,
  Honours", as plan 6D says ("as the brochure puts it"). The advisor got the exact levels from
  the link. Jacob may want the exact level beside the band.
- **The PDF puts Sem 1 first, so p2's pick 1 is on page 3** (p2): plan 6D says "By semester,
  Sem 1 then Sem 2". The view puts the filter's semester first, as 6B says. A UX follow-up if
  wanted.
- **Admitted students see applicant wording** (p1): "Counted, if NUS accepts you into it", form
  numbers, and the form line counting a backup (16 picked, 20 on the form). G4 rules out a
  CourseReg mode, and the form order is picks then backups (6B).
- **The view shows no descriptions or prerequisites, and titles aren't links** (p3, p1): the
  view's rows are as 6C specifies, and the exports carry the description, prerequisite and
  preclusion. The advisor's "clicking the title did nothing" was a `click link ST4234` that
  found no link.
- **Unticking "Only courses open to exchange students" drops the year** (p1): that is browse
  mode, unchanged from Phase 5. Its table is headed "Open to exchange students" with every cell
  "Not open" (`public/detail.js:158`). That is a plain-language follow-up like Phase 5's rank-1
  row 4, not a defect.
- **No Business sustainability course with the exchange filter on** (p1): they are off the NG
  list, so the filter hides them correctly.
- **A typed address starts with an empty list and offers "Restore your last shortlist"** (p2):
  G3 as designed.
- **The "Both semesters" chip can't be focused or removed** (p2): it is the default state,
  `removable: false` (`public/app.js:326`).
- **The 2018/19 source for full-year Sem 2 choices** (p2, p3): the plan's known risk (G5, §4).
- **Run artefacts, not the site:**
  - Ctrl+A not selecting: macOS Chromium, where Cmd+A selects.
  - The phone print hint not matching: the session prints straight to PDF.
  - The Faculty drop-down needing "(643)": the kit's `select` matches the option's full label.
  - A three-code search padded with 17 matches: ranking, as in Phase 5.
  - The "Also as ST3236" link sitting between two Shortlist buttons: UX, not a defect.

## Process notes
- **p1 wrote a scratch file** (`/tmp/p1read.txt`) to read a long page, then deleted it, which
  is outside the brief's files. The p2 and p3 briefs said "don't write scratch files anywhere
  else". It read nothing outside the site and its downloads.
- **The kit directory** is `~/.local/share/vnm-redteam6/`, away from anything else. Each
  persona's folder was moved out of the kit before the next persona started, so no persona
  could see another's files.
- **The answer scale for applicants and advisors.** R6-1 and R6-3 suggest the next briefs say
  two things: how to answer for a later year than the data's, and that prerequisites don't
  change the answer.
- **No fresh-context review** of this PR: it is evidence and a test kit, not product code, and
  the brief allowed subagents for the personas only. The lead may want one.

## Exit status (plan §5, "the red team: zero page defects open")
- **Page defects among the diff's disagreements: 0.**
- **One page defect from the personas' reports: RT6-PD1**, the view's subheading (minor, copy,
  local repro above); fixed in PR #98 (see "Rulings and follow-up").
- **Ruled:** R6-1, R6-2, R6-3, RT6-SA1 and RT6-SA2 (see "Rulings and follow-up").
- **The live totals equal the independent reference** in every export the personas made.

For `docs/evidence/requests.tsv` (the lead enters it):

    ref	Phase 6 6E red team on version f8aefeab (tag 0b5f360): 85 requests (31 page files, 1 /facets, 26 /search, 27 /module; all 200), one at a time, each starting >= 4 s after the previous ended (closest starts 4,023 ms); smoke 34, p1 17, p2 30, p3 4; 171 served from the run's cache, 0 refused (docs/evidence/phase6/redteam/requests-*.jsonl)	Phase 6, 2026-11-11 19:31:19-19:48:15 UTC

## Rulings and follow-up (2026-11-12)
- **R6-1, the year (lead):** the expected answers stand. The 2027/28 caveat covers the whole list,
  and the page says it once; it does not become a condition on each course. p2's ten "yes if
  NUS's 2027/28 list still offers it" answers are persona errors.
- **R6-2, NUS's level-4000 note (Jacob):** a condition, like `quota`. A course GRO's sentence
  covers shows "Open, with 1 note" with GRO's line, and the expected answer is "yes if there's a
  place". The page is changed to say so (the follow-up PR "level-4000 note"); the expected
  answers for those courses become "yes if", so p2's and p3's eight answers agree once it ships.
- **R6-3, prerequisites and preclusions (lead):** the answer table decides exchange eligibility
  only, as Phase 5's did. Answers that add a prerequisite or preclusion condition are persona
  errors; the advisor brief's examples invited them, and a later run's brief drops them.
- **RT6-SA1, rule E at CourseReg (Jacob):** the search key's "Not open" stays (it is true at
  application), and the admitted-students box quotes rule E ("not available during application
  stage but may be available during Course registration"). The box already carries that line
  (`public/shortlist.js`, the CourseReg rules), so no page change.
- **RT6-SA2, the exam timetable's month (lead):** the page says one thing true to both sources,
  in the same follow-up PR.
- **RT6-PD1:** fixed in PR #98, with a test that failed first; re-checked live after the deploy.
