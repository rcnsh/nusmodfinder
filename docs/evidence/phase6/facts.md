# Phase 6 6-0: fact checks

Read 2026-11-11 for `docs/plans/phase6.md` §2 ("Fact checks in 6-0"). Each line is quoted
word for word from the source as it was served, with its URL.

**How the sources were read.** NUS's own sites sit behind an Incapsula bot wall. `curl`, a
summarising web fetch and headless Chromium (old and new headless modes) all got the
challenge page, never the content (`/_Incapsula_Resource`, empty body). So every NUS page and
PDF below was read through Exa's fetch and search (`web_fetch_exa`, `web_search_exa`), which
serves its own crawl. A crawl can be older than the live page. Where the document carries a
date, it is given; one copy (the course restrictions PDF) is visibly older than the one the
repo ingested, and is marked. Nothing here touched the live Worker or the custom domain.

## 1. The brochure's numbers (4, 10, 40, 12, 23)
Source: NUS Global, "Exchange at NUS" brochure,
<https://nus.edu.sg/gro/docs/default-source/prog/sep/exchangeatnus.pdf>, "As at 4 Jun 2026"
(document title "20260604 NUS Global Exchange at NUS - update for print + web Final").

The text layer reads, with the numbers drawn apart from their sentences:
> "Courses are typically worth units each, which equates to about hours of preparation and
> class work each week. As enrolment into specific courses is not guaranteed, we strongly
> recommend that you select up to units worth of courses in your application, and be flexible
> in your study plan. You must be accepted in at least units worth of courses before you will
> receive an offer of admission. You are allowed to read a maximum of units worth of courses per
> semester." … "40" "12" "23"

- **40, 12, 23: confirmed** in the text layer, in the order of the three sentences with blanks
  ("select up to", "accepted in at least", "a maximum of").
- **4 and 10: not in the text layer at all.** They are drawn as graphics in the first
  sentence's two blanks. Checking them by eye needs the rendered PDF, which the bot wall kept
  from this session. **Not checked; needs a person** (open the PDF and read the "Preparing your
  application" panel). The plan's 2.5-hours-a-unit rate doesn't rest on them alone: the
  Business School factsheet says "A 4-Unit course typically requires about 10 hours of work
  per week" (§4).
- Also in the brochure: "1000–3000: Undergraduate courses", "4000: Honours courses",
  "5000–6000: Not open to exchange students"; "Courses in Architecture, Civil Engineering,
  Computer Science, and Economics are in high demand and places are limited."; "For courses
  that have prerequisites, please provide the syllabi of the courses that you have completed or
  are currently taking."; "Please ensure that you have sought your university's approval before
  making any changes to your Study Plan."; "* Applications for the Business and Law exchange
  programmes are by invitation only."

## 2. The GRO FAQ's maximum: **20 units, on the current GRO page** (changes §1)
Source: NUS Global, "Incoming Exchange Students",
<https://www.nus.edu.sg/gro/global-programmes/student-exchange/incoming-exchangers> (no date
on the page; its application tables are for the current cycle).

> "How many courses should I take? The minimum study workload is 12 units (approximately 3
> courses), not more than 20 units or pursue full-time research during the regular semester.
> This minimum workload is also a requirement to qualify for a Student's Pass (student visa)
> issued by the Immigration Checkpoint Authority. The average semester workload for
> undergraduate studies at NUS is 20 units –approximately 5 courses of 4 units each. A workload
> of 20 units would typically require a student to spend an average of 50 hours of study per
> week over 13 weeks of classes."

The plan (§1, "NUS's own words") says critic C found this FAQ text "only in copies of older NUS
brochures that still say 'MCs', not on the current GRO page". As served on 2026-11-11, it **is**
on the GRO page, in its "Frequently Asked Questions › Academic matters", in units. So NUS's
own exchange page says 20 and NUS's brochure says 23. See plan edit P1 and the note on G2
below.

The rest of the GRO page, as the plan quotes it, holds (each line confirmed):
- "Please note that as part of your online application you will be asked to indicate up to 40
  units worth of relevant courses to take while on exchange at NUS. As you are not guaranteed
  a place in any of the courses, we recommend that you select as many relevant courses to
  better your chances at getting the minimum number of 12 units per semester in order to be
  eligible for the Student's Pass. It is recommended that you rank your compulsory courses
  among your top three course choices so as to increase the chances or securing them. Courses
  with clashing class and examination time-table will not be approved."
- "Business and Law courses are only available to students who are invited by NUS Business
  School and NUS Law respectively to apply for the exchange during the nomination period (see
  Step 6)"
- "Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very
  limited supply and are usually NOT available to exchange students. In order to increase the
  chances of securing enough courses, incoming exchange students should consider taking
  courses with course code starting from 1000 to 3000."
- "Master level courses are open to students coming under master-level exchange agreement
  only."
- "Each semester normally includes 13 weeks of instruction and 2 weeks of examinations."
- "List of courses available to undergraduate exchange students - update in March/April";
  "Brief course descriptions - update in July or August"; "Class & Examination Timetables -
  update in July or August"
- "Application to take Level 1000 language course - You need to to complete and include this
  form in your application if you intend to read a Level 1000 language course"
- "TOEFL or IELTS score is only required for students who are applying to take Law courses at
  NUS but are from non-English medium Universities"
- "Canvas contains the latest information on courses including detailed course descriptions
  (syllabi), class structures, and the contact information for academic coordinators."
- CourseReg: "You must maintain at least 12 units or three courses per semester in order to be
  eligible for a valid Student's Pass."; "You must drop any course that clashes with a course
  that you intend to take as attendance for classes and examinations is expected for all the
  courses which you are enrolled in."; "Transfer of units is entirely at the discretion of your
  home university."; "Business, Law and Economics courses at NUS are extremely oversubscribed
  annually. If you are not successful in gaining placements into these popular courses at the
  point of offer, you are not able to add these courses during CourseReg."; "It is important to
  note that no particular course can be guaranteed by NUS."; "please approach the
  Non-Graduating Office at the Office of University Registrar for the signatures on your
  Learning Agreement or Study Plan."

## 3. The sources only critic C had read
| Source | Line the plan uses | Result |
|---|---|---|
| The Registrar's NG course list, <https://nus.edu.sg/registrar/docs/default-source/prospective-students---non-graduating/ng-courses.pdf> (AY2026/2027) | "For course outlines, pre-requisites, timetable information, visit the NUSMods website." "Timetable for the new academic year will be published mid-July. Course syllabus will be available at Canvas (our learning management system) when semester starts." "Enrolment in higher level language courses (2XXX and above) will be conditional on the placement test result." | **Confirmed.** It also reads "Course Offered for Non-Graduating (NG) Students For Semester 2 of AY2026/2027 – Page 1 to Page 22 For Semester 1 of AY2026/2027 – Page 25 to Page 44": the Sem 2 list comes first, as the plan says. |
| The Registrar's course restrictions, <https://www.nus.edu.sg/registrar/docs/default-source/prospective-students---non-graduating/non-graduating-course-restrictions.pdf> | Rule E: "Approval for any other courses not listed in this document will be granted on a case-by-case basis. If the courses cannot be found at the Course offerings list, they are not available during application stage but may be available during Course registration." §2: "If you have not been offered Business courses at the point of initial acceptance (first week of June or November), you will not be able to add the Course". CEE: "No appeal will be accepted for any Level 1000 to Level 4000 courses that are not listed in the NG Course offerings list." | **Confirmed, from an older copy.** Exa's copy ends "Updated as at 19 March 2025"; the repo ingested the 31 Aug 2026 version, whose rule E quote is the same (`docs/evidence/phase4/transcription-a.json:165`). The §2 Business line comes out of a table with its words out of order. |
| NG application guide, NUS Science's copy, <https://www.science.nus.edu.sg/wp-content/uploads/2025/01/NG-online-application-guide-2025-1.pdf> (2025) | "Fill in the Class Selection, and Equivalent Pre-requisites where required" | **Half confirmed.** This copy says "All applicants are required to indicate the intended Semester of Stay and Year of Study during Study Abroad from the dropdown lists."; "Click on 'Edit Rank' to rank your courses in order of your preference."; "The ranking order is used to determine if you get priority for the course."; "If the course(s) you had selected have pre-requisites, you should see the field below added in the same row(s) of the selected course(s). Please add in the equivalent modules/courses you had taken in your home university." It has **no "Class Selection"** step and no limit on the number of courses. Plan edit P4. |
| NUS Business School factsheet, AY2026/2027, <https://bba.nus.edu.sg/wp-content/uploads/sites/51/2026/07/NUS-Biz-Exchange-Factsheet-UG_T2620.pdf> | "Enrol in at least 12 Units (3 courses) and may take up to 20 Units."; "A 4-Unit course typically requires about 10 hours of work per week"; "At least 50% of a student's total course load must consist of Business School courses."; "During the Online Application, only core BBA courses are available. Students will be pre-enrolled in 3 courses (12 Units) upon admission. … Selected BBA elective courses will be made available during this period." | **Confirmed** (T2620, July 2026; the February T2610 lacks the 50% line). |
| NUS Business School incoming exchange FAQs, <https://bba.nus.edu.sg/wp-content/uploads/sites/51/2026/09/BIZUG_Incoming-Exchange-FAQs.pdf> (Sept 2026) | Enrolled in three courses at admission, the rest in CourseReg | **Confirmed:** "Exchange students are required to take a minimum workload of 12 units (approximately 3 courses). The maximum workload is 20 units (approximately 5 courses). Students will be enrolled in 3 courses (12 units) during admission. Students are to participate in Course Registration exercise at the beginning of the semester to secure their remaining workload." Also: "student is expected to take at least 50% of your courses within the NUS BBA curriculum programme." |
| GRO's pre-departure slides (incoming) | "would likely be unavailable"; "Select up to 10 relevant modules" (AY2018/19) | **Not found.** Search turned up only GRO's slides for outgoing NUS students. The plan's quote stays unverified; see §5 for the 10-course question. |
| GRO, Student's Pass | "three pre-registered courses (or 12 units)" | **Confirmed:** "You have failed to obtain a minimum of three pre-registered courses (or 12 units) per semester. The Office of University Registrar will contact you via email to select more courses. Students who do not manage to secure a minimum of 12 units will be deemed as unsuccessful applicants." |
| GRO, drop deadlines | Grade "W" or "F" | **Confirmed:** "Please follow the deadlines to drop courses as failure to comply with the deadlines could lead to a Grade "W" (Withdrawn) or a Grade "F" (Fail) printed on your transcript!" |
| GRO, popular courses | "please do not repeat your request" | **Confirmed:** "If you did not secure any of the popular courses during the first round of course selection, please do not repeat your request for any of these courses in subsequent rounds of reselection in order to avoid delays with your application. Successful Law courses applicants will be contacted by NUS Law directly for the official Law courses registration." |
| NUS CourseReg FAQ for non-graduating students, <https://www.nus.edu.sg/CourseReg/faqs_non_graduate.html> | 23 units a request, the waiver, clashes, Business, Vacancy Report | **Confirmed:** "You can select courses up to 23 Units in one course request."; "If you wish to do more than the allowed maximum workload, please seek support from your home university via email before submitting appeal to NUS under appeal type "Max Workload Waiver"."; "Students are not allowed to read courses with any kind of timetable clashes."; "You will not be allowed to drop the enrolled course if doing so will cause your total workload to fall below the minimum required units."; "Business courses: Only students who have been offered Business courses during the application stage will be able to see the courses during "Submit Course Requests.""; "To check if the course is offered to Non-Graduating students, refer to the Vacancy Report here."; "I was not approved for a course that I chose in my online application earlier. Can I add this course during "Submit Course Requests" rounds? You can add the course if "Submit Course Requests" round is active. If you do not meet this requirement, you can appeal submit an appeal under appeal type "Unable to secure course"." |
| CourseReg student guide, <https://www.nus.edu.sg/coursereg/docs/CourseReg-Student-User-Guide.pdf> | | "Students are allowed to select courses up to 23 Units in one Course Request." The Sem 2 AY2026/27 NG appeal timeline (<https://www.nus.edu.sg/coursereg/docs/NG_AppealSchedule.pdf>, "Updated: 11am, 7 Oct 2026") lists "Max Workload Waiver" and "Unable to Secure Course" ("To appeal for courses to meet minimum workload."). |

## 4. Full-year students: the 40 units and Sem 2 (decides G5)
- **No current NUS source says how a full-year applicant's 40 units count, or that Sem 2
  courses are chosen later.** Searched NUS Global, the Registrar's NG pages and guides, the
  Business School's documents and partner universities' guides. GRO's application table
  groups the intakes: "NUS Semester 1,(August - December) & Full year (August to May) |
  February to March | 25 March to 12 April | Late May" (nomination, online application,
  results); the page's FAQ gives "NUS Semester 1 (August to December) | 21 March - 10 April |
  Late May". So full-year students apply in the Sem 1 window, with one application.
- The only NUS text on Sem 2 choices is old: NUS's university-wide SEP information sheets,
  AY2018/19 (<https://international.huji.ac.il/sites/default/files/intl/files/nus_sep_information_sheet_18-19.pdf>)
  and the edition "correct as at 4 March 2019"
  (<https://stuex.nju.edu.cn/_upload/article/files/55/91/4794dd0d4c57a605534ee02757d7/4473849b-e141-4b12-b41c-83fc3d024c25.pdf>).
  Their table text comes out fragmented, but holds "choose up to 10 relevant" modules and
  "Full-year … be informed via email to select modules for semester 2 before semester 1 ends".
- **G5 does not need asking.** ADR 0010: "If 6-0 finds no current source, the lead takes the
  recommendation (each semester numbered separately against 40 units, with the note that NUS
  may ask for Sem 2 choices later)". 6-0 found none, so the lead takes it. Plan edit P3 records
  the search.

## 5. A course-count cap on the form
- **No current NUS source caps the number of courses.** The 2025 application guide (§3) ranks
  courses with no stated limit; GRO says "indicate up to 40 units worth of relevant courses".
- Older and partner sources say 10: NUS's 2018/19 SEP information sheet ("choose up to 10
  relevant" modules, §4); Cornell's NUS pages, current, "You will list 10 classes in ranked
  order of preference on your NUS application"
  (<https://experience.cornell.edu/opportunities/national-university-singapore-nus/academics>).
  UConn's old NUS booklet says "A student may select, in order of preference, a maximum of 6
  classes per semester or 12 classes for the entire academic year" with "the application
  suggests you to select 10 different courses".
- The plan's "past the 10th, marked, keeping its number" rule fits this: a caution, not a cap.
  Its citation should name what was found (plan edit P2).

## 6. Clashing exams
GRO, current:
> "Course requests will be assessed by the academics teaching the course based on availability
> and pre-requisites. Applicants are automatically barred from adding courses with clashing
> timetables and examination dates or choosing courses which are not offered to exchange
> students."

and "Courses with clashing class and examination time-table will not be approved." So the
portal itself bars a second course whose exam clashes with one already listed. The plan's
flag wording ("NUS won't approve both and its form won't take both (GRO)") matches. The
form-order rule (overlaps flagged, never dropped, since applicants plan on 2026/27's exams for
2027/28) needs no change.

## 7. PDFs of the mockup's print page
Mockup: `docs/design/phase6-shortlist/a/index.html#solo-print-desktop-dark` (the print page, in
a dark-theme context, to show print undoing it). Run by `docs/design/phase6-shortlist/check.mjs`
(Playwright 1.64.1, its Chromium; `page.pdf({ format: 'A4', margin: 10 mm, tagged })`).

| | pages | StructTreeRoot | text selectable | every check |
|---|---|---|---|---|
| `print-tagged.pdf` (`tagged: true`) | 6 | **present** | **yes** (pdftotext: 14,007 non-space characters; the head's first line first; the descriptions and the shortlist link present) | head on page 1; the closed section before the forced break; the foot's form order starts page 6 |
| `print-untagged.pdf` (`tagged: false`) | 6 | absent | yes, same text | — |

Both are in `docs/evidence/phase6/mockup/`, with `print-pages.png` (the six pages side by
side) and `print-tagged.txt` (the extracted text).

**Not checked, needs a person:**
- **Safari (macOS)**: its "Export as PDF" from the print page, whether that PDF has a structure
  tree and selectable text, and the file name it offers (`document.title` is set to
  `exchange-shortlist-sem1-2026-27-courses`; Safari's `afterprint` may fire before the sheet
  closes). Playwright's WebKit is not Safari and has no `page.pdf`.
- **Chrome's own "Save as PDF"** from the print dialog (as opposed to `page.pdf`): whether it
  tags. Chrome's print preview has a "Tagged PDF" behaviour of its own; not driven here.
- **Print on a second press after a slow load**: whether the browser still treats `print()` as
  the user's. It needs the real page with a held `/module`, which is 6D's spec
  (`window.print` stubbed), not the mockup.

## Plan edits proposed (in this PR, `docs/plans/phase6.md`)
- **P1** (§1 "NUS's own words", the FAQ bullet; and "The maximum"): the FAQ's 20 units is on
  the current GRO page. **G2's approved wording** ("some pages say 20") still holds, but now
  understates it: NUS's own exchange page says 20. This is Jacob's answer, so it's flagged in
  §6 for the lead to put to him, not changed.
- **P2** (6B, the form's 10-course mark): cite "NUS's 2018/19 SEP information sheet and
  partner universities' guides" instead of "pre-departure slides", which 6-0 couldn't find.
- **P3** (§1 "Full-year applicants"; §4 risks): 6-0 found no current source; full-year students
  apply in the Sem 1 window; G5 is not asked and the lead takes the recommendation.
- **P4** (6B "lines for applicants"): the application guide supports the prerequisite field,
  not a class choice: "NUS's form asks, for each course with a prerequisite, the home course
  that meets it (the application guide)". The mockup already uses this wording.

No edit for the restrictions: Exa's copy is the March 2025 one, but the rule texts the plan
quotes match the repo's 31 Aug 2026 transcription.
