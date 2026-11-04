# Judging (Phase 2d)

How the pooled search results of every query set are graded. Plan: `docs/plans/phase2.md`
(Judging, r2 and Final; later sections win), ADR 0003. The tooling is `eval/judge.mjs`
(`npm run eval:judge`); its commands are in `eval/README.md`.

## Who grades

Judging uses one judge: judge A. There is no second judge and no adjudicator.

| slot | grader | sees |
|---|---|---|
| `rule` | mechanical pre-grading | every pooled pair; grades hard-constraint violations 0 |
| `A` | judge `claude-opus-5-5` | a packet: the pairs `rule` did not grade |

The final grade is `rule`'s where it applies, else A's grade (qrels `source: judged`).

`prepare --judges claude-opus-5-5` makes a single-judge round. `drop-judge --slot B --reason
<text>` turns a round prepared with two judges into a single-judge round: B's packets, items and
grades go, A's stay as they were (same item ids, so A's outputs still validate), and the drop is
recorded with its reason in the round state and in the qrels' `judging` entry. It is refused once
adjudication has started, and when B has collected grades unless `--force`.

The tooling still supports a two-judge round (`--judges <idA>,<idB>`): see
[Two-judge rounds](#two-judge-rounds) below. Nothing in the current protocol uses it.

## What a judge sees, and what it never sees

A judge reads one packet file and nothing else. Per query: the query text, the intent narrative
(relevant / partially relevant / not relevant, written by the persona before any results
existed) and the hard constraints. Per candidate: an opaque item id, code, title, level,
credits, semesters offered, NG semesters (and so the NG flag), faculty and department, and the
full description.

A judge never sees: which system or variant returned a candidate, its rank or score, how many
systems returned it, the query's id, shape tags or persona, the `rule` grades, another judge's
grades, or prerequisites (judged from the description, as an exchange student would read it).
Candidates are shuffled per query with a recorded seed, so order carries no signal.

## Grades

Grades are relative to the query's intent, for an incoming undergraduate exchange student
choosing NUS courses for one semester.

- **2, relevant.** What the student asked for: they would shortlist it.
- **1, partially relevant.** Related and plausibly useful: what the intent's "partially relevant"
  line describes, or the asked-for topic as one part of a broader course, or the right topic
  at a clearly different level than wanted.
- **0, not relevant.** Everything else: what the "not relevant" line names, word-overlap
  matches, and **any course breaking a hard constraint**.

## Hard constraints and mechanical pre-grading

A query's hard constraints are its `constraints`, or its `filters` when it has none (the UI
state the persona set): semester, NG (open to non-graduating students, in that semester when
one is set), level, credits, faculty. Every pooled candidate is checked against them before any
judge sees it (`violationReason` in `eval/lib/metrics.mjs`, the same rule as violations@10). A
violating candidate gets grade 0 from judge `rule`, with the broken constraint as its
rationale, and is left out of every judge packet. Soft preferences written only in the
narrative ("ideally 3rd-year", "taught in English") are not hard constraints. Judges weigh
them between 2 and 1.

## Worked examples (dev queries only)

Real dev queries (`eval/dev/queries.json`) and real courses from the pinned corpus
(`data-2026-2027-20260904`). Judges get these examples verbatim (below). Their pairs are graded
here by the author of these criteria, so the judges' grades for those few dev pairs are not
independent; no holdout or test query appears.

| query | constraints | candidate | grade | why |
|---|---|---|---|---|
| d-001 "corporate finance valuation" | sem 1, NG | FIN3701A Corporate Finance (3000-level; NG sem 1, 2) | 2 | the 3rd-year corporate finance course the intent asks for: capital budgeting, valuation, cost of capital |
| d-001 | sem 1, NG | FIN2704X Finance (2000-level; NG sem 1, 2) | 1 | a general finance course covering valuation as one topic: the intent's "partially relevant" |
| d-001 | sem 1, NG | RE3706 Principles of Real Estate Valuation (NG sem 1, 2) | 0 | real estate valuation is named under "not relevant" |
| d-001 | sem 1, NG | FIN3701B Corporate Finance (offered sem 2 only) | 0 (`rule`) | not offered in semester 1; never reaches a judge |
| d-007 "japanese 1" | sem 1, NG | LAJ1201 Japanese 1 (NG sem 1, 2) | 2 | the first-level Japanese course |
| d-007 | sem 1, NG | LAK1201 Korean 1 (NG sem 1, 2) | 1 | another East Asian language at beginner level, named under "partially relevant" |
| d-007 | sem 1, NG | LAJ2201 Japanese 2 (not on the NG list) | 0 (`rule`) | not open to NG students; would otherwise be 1 |
| d-016 "CS 4400 Operating Systems" | sem 2, NG | CS2106 Introduction to Operating Systems (not on the NG list) | 0 (`rule`) | the perfect topical match, but an exchange student cannot take it |
| d-015 "computer vision" | sem 2, NG | CS4277 3D Computer Vision (NG sem 2) | 2 | computer vision, and the intent names 3D vision |
| d-085 "MA2101" | NG | MA2101 Linear Algebra II (NG sem 1, 2) | 2 | the exact code |
| d-085 | NG | MA2101S Linear Algebra II (S) (not on the NG list) | 0 (`rule`) | a variant (would be 1), but not open to NG students |

## Judge instructions (verbatim)

Every judge packet starts with the text between these markers, unchanged, followed by the
packet's sections. `renderJudgePacket` reads it from this file, so editing it here changes
what judges get. Then record the change in the judging round's notes.

<!-- BEGIN judge-instructions -->
You are grading search results for an incoming undergraduate exchange student at the National University of Singapore (NUS) who is choosing courses for one semester.

This file is the only thing you need. Do not open other files, search the web, or use what you know about NUS beyond what this file shows.

Each section below holds one search query the student typed, with:
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
6. Grade each item on its own. Some queries appear in more than one section; grade every item where it appears.
7. The order of candidates means nothing.

For every section, write a JSON file at the path given under "Write to". It holds exactly one entry per item id in that section, in this shape:
{ "<item id>": { "grade": <0, 1 or 2>, "rationale": "<one or two sentences: the evidence in the course fields, tied to the intent>" } }
Start from the section's template and replace every null. Grades are the integers 0, 1 or 2. Write plain JSON only: no comments, no other keys, no other files. Write every section's file before you finish.
<!-- END judge-instructions -->

<!-- BEGIN judge-examples -->
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
<!-- END judge-examples -->

## Two-judge rounds

Only for a round prepared with two judges. Judge B gets its own packet over the same pairs,
shuffled independently; `agree` reports A vs B agreement; the adjudicator grades only the pairs
where A and B differ (\|A − B\| ≥ 1), blind first, then with both grades. The final grade is
`rule`'s, else the A = B grade (`agreed`), else the adjudicator's second-pass grade
(`adjudicated`). `agree` and `adjudicate` refuse a single-judge round.

### Adjudicator instructions (verbatim)

The adjudicator works in two passes over the same items, from two packet files. The lead passes
the second only after the first pass is collected (`adjudicate collect --pass 1` writes it).

**Pass 1 (blind).** The packet starts with this block, then the judge instructions and
examples above, then the items. It holds no other grader's grade.

<!-- BEGIN adjudicator-pass1 -->
You are the third grader for query-course pairs on which two other graders disagreed. This first pass is blind: you do not see their grades. Grade every item exactly as the instructions below say, as if you were the only grader.
<!-- END adjudicator-pass1 -->

**Pass 2 (reconcile).** The packet starts with this block, then the judge instructions and
examples, then each item with the adjudicator's own pass-1 grade and rationale and both judges'
grades and rationales, labelled Grader 1 and Grader 2 in a per-item random order (no judge or
model names).

<!-- BEGIN adjudicator-pass2 -->
This is your second pass over items you have already graded blind. Each item now shows your own first-pass grade and rationale, and the grades and rationales of two other graders (Grader 1 and Grader 2, in random order). Decide the final grade under the same instructions as before, repeated below.

Change your first-pass grade only when another grader's rationale points to evidence in the course fields or the intent that you missed or misread. Do not split the difference, and do not side with the other graders because they agree with each other. Your rationale says which evidence decided the final grade.
<!-- END adjudicator-pass2 -->

## Self-consistency, drift and calibration

With one judge, three checks stand in for inter-judge agreement: planted-repeat
self-consistency, the drift re-judge sample, and Jacob's human calibration. Inter-judge κ and α
do not apply.

- **Planted repeats.** About 5% of each judge batch's items appear a second time, under a new
  item id, in a later section of the same query, at least one section after the original
  where the batch allows. `collect` reports exact agreement and mean |Δ| between the two grades
  per judge. The first grade is the one that counts.
- **Drift.** `prepare --drift-from <qrels>` re-judges a 5% sample of already-judged pairs
  (rule-graded pairs excluded) in the new round's packets. `collect` reports agreement with the
  stored final grade. Drift items never change the qrels.
- **Human calibration** (dev only; Jacob is not custodian-briefed for holdout plaintext).
  About 150 pairs stratified by grade (equal shares where available) and by shape within
  each grade, rule-graded pairs excluded. Jacob grades them blind in a CSV. The importer reports
  agreement between Jacob and A and between Jacob and the final grade, and Δ(candidate −
  baseline) nDCG@10 with its sign under A's grades, the final grades and, on the calibrated
  subset, Jacob's. A judge the qrels hold no grades from (B) gets no row.
- **Agreement** between A and B (`agree`, two-judge rounds only): raw agreement,
  Krippendorff's ordinal α, binary Cohen's κ at grade ≥ 1, and quadratic-weighted κ, overall
  and per shape, with n. A statistic with no chance variation (everyone used one grade) is
  printed as `—` and flagged degenerate. On a two-judge qrels the calibration import also
  reports B.

## Limits

- The worked examples are dev pairs graded here; judges' grades for those pairs on dev are not
  independent.
- A judge can notice a planted repeat (the same course under the same query twice). The
  measure is a floor on inconsistency, not an estimate of it.
- With one judge there is no independent second grade: a systematic bias of judge A is
  visible only through Jacob's calibration (dev) and not at all on holdout.
- Holdout packets exist in plaintext only in the round's `0700` directory under `.eval-work/`
  until `clean`.
- Duplicate groups (variant families, cross-listings) are not marked by this tooling; a merge
  keeps the base qrels' groups.
