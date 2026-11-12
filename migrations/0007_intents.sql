-- The fields the no-exam, S/U, workload and prerequisite intents filter on.
-- normalise() (scripts/lib.mjs) derives them; NORMALISER_VERSION 2 rewrites
-- every row once (a row-only re-ingest: no re-embedding, no FTS writes).
-- Production applied it after 0008, which touches only catalogue_only.
ALTER TABLE modules ADD COLUMN exam_semesters TEXT NOT NULL DEFAULT '[]';  -- JSON: offered semesters with an examDate
ALTER TABLE modules ADD COLUMN exam_sem1 INTEGER GENERATED ALWAYS AS (instr(exam_semesters, '1') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN exam_sem2 INTEGER GENERATED ALWAYS AS (instr(exam_semesters, '2') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN exam_sem3 INTEGER GENERATED ALWAYS AS (instr(exam_semesters, '3') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN exam_sem4 INTEGER GENERATED ALWAYS AS (instr(exam_semesters, '4') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN su INTEGER NOT NULL DEFAULT 0;              -- attributes.su
ALTER TABLE modules ADD COLUMN grading_basis TEXT;                          -- gradingBasisDescription
ALTER TABLE modules ADD COLUMN workload_hours REAL;                         -- NULL: not listed, unparseable or all zero
ALTER TABLE modules ADD COLUMN prereq_none INTEGER NOT NULL DEFAULT 0;      -- the prerequisite field is absent
ALTER TABLE modules ADD COLUMN prereq_cohort_only INTEGER NOT NULL DEFAULT 0; -- only a cohort restriction (src/cohort-only.js)
