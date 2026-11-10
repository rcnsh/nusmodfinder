# Persona red team: brief

You are red-teaming a course planner for incoming exchange (non-graduating, "NG") students at the
National University of Singapore (NUS), AY2026/27. In exchange mode it promises to show a student
only the courses they may take in their chosen semester at their study level, and to attach a note
to any course that needs something extra (a home major, approval, a partner institution, graded
basis, a quota). Your job is to find any course it shows that you, reading NUS's own rules, would
not let this student take, and any course you would allow that it hides.

## What you may read (everything is in ~/.config/vnm/redteam, called K below)
- `K/sources/`: NUS's published sources, the only rules that exist:
  - `ng-courses.txt` (and `.pdf`): the NG course list, with the semesters each course is offered
    to exchange students. Large: search it (grep) rather than reading it whole.
  - `non-graduating-course-restrictions.txt` (and `.pdf`): the Registrar's restrictions for NG
    students (general rules A–E, then rules by school and department). Read it in full.
  - `self-funded-graduate-courses.txt` (and `.pdf`): the self-funded graduate programmes' courses,
    which rule A of the restrictions refers to. Large: search it.
  - `law-compulsory-llb-courses.png`: the compulsory LLB course list the Law rules refer to.
  - `yst-sem1-non-music-majors.txt`, `yst-sem2-non-music-majors.txt` (and `.html`): the Yong Siew
    Toh Conservatory's courses for NUS non-music majors, which the Music rules refer to.
- `K/answers.md`: the project owner's rulings where the sources are ambiguous. Binding.
- `K/facts.json`: NUSMods facts for every course offered this year, keyed by code: title,
  department, faculty, and the semesters NUSMods lists. Use it for department, faculty and level
  (the first digit of the number in the code is the level: CS3244 is level 3000). A code missing
  from it is not offered this year.
- `K/sample.json`: `codes` is the list of courses you must also judge without searching.
- `K/search.mjs`: your only way to use the planner.

Read nothing else: nothing outside K, no website, and inside K not `raw/`, not other personas'
files in `calls/`. Never look at the planner's code or repository. You judge from the sources
alone. Put any scratch files under `K/scratch/<persona-id>/`.

## What to do
1. Read the restrictions file in full and `answers.md`. Search the other sources as you need.
2. As your persona, think of 10 searches a real student like you would type into a course
   planner: topics you'd want to study at NUS, in your own words, a mix of broad and specific.
   Make them your own; don't reuse wording from these files. Run each, one at a time:
   `node ~/.config/vnm/redteam/search.mjs <persona-id> "<your query>"`. Each prints the courses
   the planner shows you (results and their variants) with their NUSMods facts. You have 10
   searches; a failed one doesn't count. The helper spaces calls across personas, so a search may
   take a while. Never run searches in parallel or in the background.
3. For every course code shown in any of your searches (results and variants), and for every code
   in `sample.json`'s `codes`, decide from the sources and rulings what this student's status is
   for your semester and study level:
   - `closed`: the student may not take it this semester (not on the NG list for this semester,
     not on the NG list at all, closed by a rule, wrong level for the study level, and so on);
   - `note`: they may take it, but something applies they must know (a major requirement,
     approval, case-by-case, partner-only, graded basis only, quota, a semester mismatch between
     the NG list and NUSMods, and so on);
   - `open`: they may take it with no condition.
   Judge every code yourself, carefully. If you write a script to help, it must encode your own
   reading of the sources, and you must check its output by hand on a sample.
4. Write `K/calls/<persona-id>.json`: a JSON array with one entry per code, no duplicates:
   `{"code": "AR4601", "call": "note", "why": "<one line: the rule and source>", "shown": true}`.
   `shown` is true if any of your searches showed it, false if it comes only from the sample.
5. Reply with: your 10 queries, the counts of codes per call, and every shown course you called
   `closed` (each with its reason). Also list anything in the sources you found genuinely
   ambiguous and how you read it.
