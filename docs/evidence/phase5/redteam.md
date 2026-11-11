# Phase 5 red team (5G, plan §3 "5G")

Three exchange-student personas on the live page, a plain-language reviewer and a front-end
security reviewer. Run on 2026-11-11 against the live Worker, version `810c903b` (commit
`fdec96f`). The kit is in `redteam/`; its `README.md` lists every file.

## Method
- **Rules before the run.** Commit `0152430` fixed every persona's context and brief facts
  (`redteam/personas.json`), the brief-to-answer rules (`redteam/rules.mjs`, the plan's table:
  most restrictive wins), and `redteam/expected.json`. That file holds the expected answer for
  every course offered this year, for each persona and semester, computed from the independent
  oracle (`test/sc1/oracle.node.mjs`) over the production-normalised modules and the brief
  alone. The commit was pushed before any persona started. `diff.mjs` recomputes each answer
  and refuses to run if it differs from the committed table.
  - The oracle's notes are free text. `rules.mjs` maps each one to a note kind by pattern and
    throws on a note it can't map. All 6,778 offered courses mapped, in every persona context.
- **Blind personas.** Each persona was a fresh subagent that read only its brief
  (`redteam/briefs/<id>.md` and `common.md`). It used the site only through `act.mjs`, which
  drives a browser held by `session.mjs`. It never saw the plan, this kit, the oracle, the
  rules or the expected answers. It answered **yes / yes if / no / ask NUS** for every course it
  picked or was told to check. One line in the brief fixes how to use the answer scale: when
  the brief already settles a condition the site names, answer yes or no, not "yes if".
  - **p1:** a 3rd-year Architecture undergraduate (Landscape Architecture counts as the same
    discipline), Sem 1, keyboard only (Chromium, 1280×800). Has the design-year letter, takes
    everything graded, pays no fees beyond tuition. Partner status is unknown. Not a business
    student.
  - **p2:** a 2nd-year Computer Science undergraduate, Sem 2, accessibility tree and keyboard
    only (no screenshots, no visible text). Home list: **CS3244, CS2106, CS3231, CS3240**. Two
    of these are closed by the oracle: CS2106 is off the NG list, and CS3231 is offered only in
    Sem 1.
  - **p3:** a 3rd-year Geography and History undergraduate for the full year (Sem 1 and Sem 2),
    on an iPhone 13 in WebKit (390 px wide). Takes everything graded and pays no fees. The
    brief says the home university is **not** a partner of any NUS school or the conservatory.
- **Live traffic.** `session.mjs` routes every request through one gate shared by all session
  processes:
  - each request starts at least 4 s after the previous one;
  - the page's files are fetched once for all three personas, then served from a shared cache,
    as a browser cache would;
  - an API answer with `max-age` is served from the cache for that long;
  - requests are capped at 400 in total and 120 per persona;
  - anything that isn't a GET to the live host is refused.

  Every request is logged in `redteam/requests-<id>.jsonl`, whether sent, served from the cache
  or refused. The personas ran one after another. Each command a persona ran is in
  `redteam/actions/<id>.jsonl`, and its final report, verbatim, is in `redteam/reports/<id>.md`.
- **Reviewers** worked from the repo and a local `npm run dev` only. They sent nothing to the
  live site.

## Live requests
| persona | sent | from cache | refused |
|---|---|---|---|
| p1 | 40 (21 page files, 1 `/facets`, 11 `/search`, 7 `/module`) | 88 | 0 |
| p2 | 14 (7 `/search`, 7 `/module`) | 22 | 0 |
| p3 | 19 (10 `/search`, 9 `/module`) | 22 | 0 |
| **total** | **73** (all 200): 21 files, 1 `/facets`, 28 `/search`, 23 `/module` | 132 | 0 |

- **Time range:** first request at 2026-11-11T06:43:49.473Z, last at 2026-11-11T07:02:07.827Z.
- **Spacing:** one pair started **3,999 ms** apart, 1 ms short of the 4 s rule: p2's
  `/search` and then `/module/CS2106`, at 06:54:29. A timer fired a millisecond early. Every
  other gap is at least 4,000 ms. The gate now loops until the full gap has passed (fixed after
  the run, in this PR). The Worker's limit (20 per 10 s) was never approached: at most 3
  requests fell in any 10 s window.
- No other Cloudflare calls, no deploys, no `--remote`.

## Results: the mechanical diff (`redteam/diff.mjs` → `redteam/diff.json`)
| persona | answers | agree | disagree |
|---|---|---|---|
| p1 (Sem 1, ug3, keyboard) | 7 | 5 | 2 |
| p2 (Sem 2, ug2, accessibility tree) | 6 (all four list codes answered) | 5 | 1 |
| p3 (Sem 1 and 2, ug3, phone) | 8 | 8 | 0 |
| **total** | **21** | **18** | **3** |

Every answer:

| persona | code | sem | persona's answer | expected | note kinds (oracle) |
|---|---|---|---|---|---|
| p1 | AR3101 | 1 | yes | yes | letter (has it) |
| p1 | AR3223 | 1 | yes | yes | none |
| p1 | AR4601 | 1 | ask NUS | **yes** | major: architecture (meets it) |
| p1 | PF3210 | 1 | yes if I get one of the limited places | yes if | graded, quota |
| p1 | PF3208 | 1 | yes if I get one of the limited places | yes if | graded, quota |
| p1 | PF4306 | 1 | yes if the department confirms it runs in Sem 1 and I get a place | **ask NUS** | semester, graded, quota |
| p1 | RE4701 | 1 | no | no | major: business (doesn't meet it) |
| p2 | CS3244 | 2 | yes | yes | none |
| p2 | CS2106 | 2 | no | no | closed: not on the NG list |
| p2 | CS3231 | 2 | no | no | closed: NG list offers it in Sem 1 only |
| p2 | CS3240 | 2 | yes if the Computing department confirms it is taught in Sem 2 | **ask NUS** | semester |
| p2 | CS3234 | 2 | yes | yes | none |
| p2 | CS3210 | 2 | yes | yes | none |
| p3 | GE3206 | 1 | yes | yes | none |
| p3 | HY3226 | 1 | yes | yes | none |
| p3 | LAJ1201 | 1 | yes | yes | graded (accepts it) |
| p3 | GEC1023 | 1 | yes | yes | none |
| p3 | GE3204 | 2 | yes | yes | none |
| p3 | GE2231 | 2 | yes | yes | none |
| p3 | HY2208 | 2 | yes | yes | none |
| p3 | HY2253 | 2 | yes | yes | none |

No persona answered yes or "yes if" to a course the oracle closes. No persona answered no to a
course the oracle opens. Both closed list codes were found and explained to the
screen-reader persona: p2 called the hidden-codes region "clear and useful".

### The three disagreements, classified
- **R3: AR4601 for p1 (Sem 1, 3rd year): persona `ask NUS`, expected `yes`. Source ambiguity:
  Jacob rules.**
  - The page says "As a 3rd-year exchange student: Sem 1 · Open, with 1 note", and p1 meets the
    note (an Architecture major).
  - The detail's prerequisite, which the page shows verbatim as NUS states it (5C), says "If
    undertaking an Undergraduate Degree THEN must be Year 4".
  - p1 is in its 3rd year at home, and nothing says whether a NUS year-of-study prerequisite
    binds an exchange student's home year.
  - Neither NG source addresses this. The oracle and the plan's table decide exchange
    eligibility only, not prerequisites.
  - The page did what it was designed to do.
  - The question for Jacob: does a NUS "must be Year N" prerequisite count against an exchange
    student's home year?
    - If it doesn't (the department checks prerequisites separately), the expected `yes` stands.
      A line saying so may help.
    - If it does, these courses carry a condition the page doesn't name, and the answer should
      be ask NUS.
- **PF4306 for p1 (Sem 1) and CS3240 for p2 (Sem 2): persona `yes if the department confirms
  it runs`, expected `ask NUS`. Persona error (answer scale).**
  - Both personas read the page correctly: the `semester` note says "Not on NUSMods' timetable
    for Sem N: check with the department".
  - Both then filed a condition that only NUS can settle as "yes if", where the table says ask
    NUS. The decision is the same in substance (don't count on it until NUS confirms), so no
    student would act wrongly.
  - Both personas, and p3 independently, also said the "Open" stamp sits badly next to a
    "Taught in Sem M" line for the other semester. The plain-language reviewer ranks the
    Timetable note's wording as harm rank 1 (row 5 below).
  - If Jacob would rather count "yes if NUS confirms" as ask NUS for `semester` notes, these
    two become agreements. No ruling is needed for exit.

**Page defects among the disagreements: 0.**

## Page findings from the personas' reports (outside the diff)
Each persona-reported issue was checked against the code, and where possible reproduced on a
local `npm run dev` (`redteam/repro/page-issues.mjs`). Neither defect below changes an
exchange answer. I report them and fix neither.

- **PD1: preclusions keep NUS's glued keywords. Page defect, minor (display, screen
  readers).**
  - `public/detail.js:78-79` only collapses whitespace in the preclusion. The prerequisite gets
    `cleanPrereq` (`public/format.js:109`).
  - `detail.js`'s header says both are shown "spacing restored".
  - Live, p2 heard CS2106's preclusion as "Undergraduate DegreeTHEN(" and "at least DOR(must
    not…".
  - Locally the repro shows ACC1701XA's preclusion with `DegreeTHEN((` and `)OR(`.
  - 1,962 of the 7,655 production preclusions contain a glued keyword.
  - Fix: run the preclusion through `cleanPrereq` too.
- **PD2: the typed-codes count line names an unpinned code as if it led the list. Page
  defect, minor (copy).**
  - p1 typed six codes. The page said "20 courses shown: AR3101, AR4601, AR3223, PF3210, then
    16 other matches", but PF3210 was the 20th entry, not pinned.
  - `codesCount` (`public/explain.js:265`) names every typed code shown anywhere, in typed
    order, then "then N other matches".
  - The repro gives the same sentence with PF3210 ranked 20th.
  - Fix: name only the pinned codes before "then", or say "including".

Checked and not page defects:
- **p2's "re-ticking exchange resets the semester to Both".** p2 had removed the Sem 2 chip
  itself before re-ticking, so "Both" is the state it chose.
- **p2's "all four codes were pinned with filters off".** At most three codes pin
  (`src/query-intent.js` MAX_PINS). A fourth near the top is ranking. This is unconfirmed, and
  no request log of the answer was kept.
- **"Japanese 2" / LAJ1202 (p3).** LAJ1202 isn't in this year's catalogue, so "no course
  LAJ1202" is right. Japanese 2 here is LAJ2201, which the search didn't surface. That is
  ranking.
- **GEC1014's Sem 2 "Not open" (p3)** equals the oracle: the NG list offers it in Sem 1 only.
- Search relevance ("architecture" finding CS courses, "piano", "operating systems"), "20
  courses match" on every search, the detail opening below the card on the phone, focus staying
  in the search box, and the long year-by-semester table read aloud: ranking or design, not
  defects. Jacob may want the last three as UX follow-ups.

## Plain-language pass (`redteam/plain-language.md`)
The reviewer checked 229 sentences and templates (118 reason texts, 40 `explain.js`
templates, 20 `messages.js` sentences, 51 other lines), rendering the templates with real
reason values. They flagged **41**:
- **8 at rank 1:** could lead to a wrong decision about a course;
- **18 at rank 2:** leave the student unsure what to do;
- **15 at rank 3:** minor.

The claim that the server's own `message` never reaches the page holds. The rank 1 sentences:
1. **"Conflicting rules"** (`*:elsewhere`): an "Open" stamp, then "Listed as open, but … all
   CG-coded courses are not open". "All … are not open" reads as "not all are open".
2. **`D-grad-levels-closed-exchange`**: the hidden-code line ends with "unless a department says
   so" but gives no next step, so a graduate student gives up a course they could get.
3. **A code closed in both semesters** (`hiddenCodeLine`): "Offered … only in Sem 2" reads as
   "switch semesters". The next sentence says Sem 2 is closed too.
4. **The browse-all marker "On the exchange (NG) list: Sem 1, Sem 2"** reads as "you can take
   it". The restrictions aren't applied in that view.
5. **The Timetable note** "Not on NUSMods' timetable for Sem 1: check with the department"
   doesn't say what isn't on the timetable or which department. This is the note behind both
   answer-scale disagreements.
6. **"Not offered"** in an entry's meta beside an "Open" stamp, when NUSMods lists no
   semester.
7. **"Graded basis" / "Cannot be audited"** (10 reason ids): "audit" is read as a financial
   check.
8. **"Level 4000 courses by appeal only."** (`1-psych-l4-appeal`) under an "Open" stamp.

The reviewer traced row 9 (rank 2) in code without reproducing it: in exchange mode, when no
course is open to the student, the page says "No courses match “dentistry”", which reads as
"NUS has no such course". The report ends with 15 terms to explain once in the sources box.
Every row has a proposed rewrite. None is applied.

## Security review (`redteam/security.md`, repros in `redteam/security/`)
The reviewer found no script or markup injection and no open redirect. I re-ran
`misleading-links.mjs` on a fresh local server and got the same output.

- **S1, low: `from=` asserts a false equivalence.**
  `/?q=PP5288&open=PP5288&from=CS1010` shows "Opened from CS1010: another code for the same
  course" over PP5288. The page never checks that `from` is a variant of `open`
  (`public/state.js:98`, `app.js:314`, `detail.js:170-171`), and the canonical URL keeps it.
  This matters for students mapping credit at home.
- **S2, low: `q` and `faculty` are echoed where the site's own sentences go.**
  - A crafted `q` (capped at 200 characters, shown in quotes) puts "— NUS Registrar: every
    course below is open to all exchange students…" in the count line and the live region.
  - `faculty` (no length cap) becomes a chip and the selected option, though a made-up faculty
    empties the results.
  - Bidi controls are kept.
- **S3, low: the page can be framed.** There is no `X-Frame-Options` or `frame-ancestors`
  header. From a second local origin, input through the frame changed the saved year
  (`vnm.study`), which pre-fills later visits.
- **S4, info: a link's `study=` overrides the saved year without notice.**
  `?…&study=grad` shows a graduate's status ("Open, with 2 notes" for PP5288) to a student
  whose saved year is 1st year, and skips the set-up. This is the intended "the URL wins"
  design. Only the chip shows it.

Found sound, with evidence in `security.md`:
- DOM-only rendering, and lint passes with its HTML-sink ban;
- 21 crafted URLs × 2 engines: nothing ran, nothing was injected, the prototype stayed clean,
  and no request went to another origin;
- every link scheme is allow-listed, and every `target=_blank` has `noopener`;
- no redirect anywhere;
- URL params are allow-listed or capped;
- server error text never reaches the page;
- the missing `nosniff` and CSP aren't exploitable here.

## Process notes
- **The kit directory.** It first went under `~/.config/vnm/`. Listing that directory showed
  the names of key files kept there, but none was opened. The kit moved to
  `~/.local/share/vnm-redteam5/` before any persona ran, so no persona worked beside key files.
- **The answer scale.** The personas' use of "yes if" for a condition only NUS can settle
  (the PF4306 and CS3240 disagreements above) suggests a future brief should say that "check with NUS or the department"
  means ask NUS.

## Exit status (plan §5, "the red team")
- **Page defects among the diff's disagreements: 0.**
- **R3 (AR4601's year prerequisite) needs Jacob's ruling** before exit.
- **PD1 and PD2 are page defects the personas found outside the diff.** If "zero page
  defects open" covers every defect the red team found, both block exit until they are fixed
  or ruled out of scope. Neither changes an exchange answer.
- **The security and plain-language findings** are reported for the lead to triage. None is a
  high-severity issue.
