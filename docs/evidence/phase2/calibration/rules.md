You are grading search results for an incoming undergraduate exchange student at the National University of Singapore (NUS) who is choosing courses for one semester.

Grade from these rules and the fields in pairs.csv only. Do not search the web or use what you know about NUS beyond what the fields show.

Each row of pairs.csv holds one search query the student typed, with:
- the intent: what the student wrote, before seeing any results, about what they would count as relevant, partially relevant and not relevant;
- the hard constraints: settings the student fixed (semester; open to non-graduating (NG) students, which exchange students are; level; credits; faculty).

Then the candidate courses, each with an item id, code, title, level, credits, the semesters it is offered, the semesters it is open to NG students, its faculty and department, and its description.

Grade every candidate:
- 2 (relevant): what the student asked for, as the intent's "relevant" line describes; they would put it on their shortlist.
- 1 (partially relevant): related and plausibly useful: what the intent's "partially relevant" line describes, or the asked-for topic as one part of a broader course, or the right topic at a clearly different level than wanted.
- 0 (not relevant): anything else, including what the intent's "not relevant" line names, courses that only share words with the query, and any course that breaks a hard constraint.

Rules:
1. The intent decides. When the query text and the intent disagree, follow the intent. Where the intent is silent, judge what a reasonable exchange student typing this query wants.
2. Hard constraints are absolute. A course not offered in the required semester, not open to NG students (in that semester, when one is set), or outside a required level, credit value or faculty is 0, however good a match it is otherwise. Most such courses were removed before you see them; if one remains, grade it 0.
3. Soft preferences in the intent ("ideally 3rd-year", "not too hard", "taught in English") move a course between 2 and 1. They make it 0 only when the intent's "not relevant" line says so.
4. For a course-code query, the course with exactly that code is 2. Its variants and cross-listings (the same code with a letter suffix, or the same course under another code) are 1 unless the intent says otherwise. Other courses are 0 unless the intent names them.
5. Judge only from the fields shown. Do not reward a course for being popular or well known. When the intent depends on something the fields do not show (workload, exam format), grade on what the description does show and say so in the rationale.
6. Grade each item on its own. Some queries appear in more than one row; grade every row on its own.
7. The order of candidates means nothing.


Worked examples (from other queries; for calibration only, not part of your task):
- Query "corporate finance valuation"; intent: relevant = an undergraduate corporate finance course, ideally 3rd-year, on firm valuation, capital budgeting and cost of capital; partially relevant = a general finance course that covers valuation as one topic; not relevant = accounting, public finance, real estate valuation. Constraints: semester 1, open to NG students in that semester.
  - FIN3701A Corporate Finance, 3000-level, NG in semesters 1 and 2, covers capital budgeting, valuation and cost of capital: grade 2.
  - FIN2704X Finance, 2000-level, a broad introduction to finance with valuation as one topic: grade 1.
  - RE3706 Principles of Real Estate Valuation: grade 0 (real estate valuation is named as not relevant).
  - FIN3701B Corporate Finance, offered in semester 2 only: grade 0 (breaks the semester constraint).
- Query "japanese 1"; intent: relevant = the first-level Japanese course for beginners; partially relevant = Japanese 2, or another East Asian language at beginner level; not relevant = Japanese studies courses taught in English. Constraints: semester 1, NG.
  - LAJ1201 Japanese 1, for students with no prior Japanese: grade 2.
  - LAK1201 Korean 1, a beginners course: grade 1.
- Query "computer vision"; intent: relevant = a computer vision course covering recognition, detection, 3D vision; partially relevant = graphics or image processing. Constraints: semester 2, NG.
  - CS4277 3D Computer Vision, 4000-level, NG in semester 2: grade 2.
- Query "MA2101"; intent: relevant = MA2101 itself; partially relevant = its variants. Constraint: open to NG students.
  - MA2101 Linear Algebra II: grade 2.
  - MA2101S Linear Algebra II (S), not open to NG students in any semester: grade 0 (would otherwise be 1).



