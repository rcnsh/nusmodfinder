-- Phase 5 5A (docs/plans/phase5.md §3 "5A Exam dates"): each exam's date and
-- duration, for /module/:code. normalise() (scripts/lib.mjs) derives it from
-- moduleInfo's semesterData[].examDate/examDuration; ingest binds it and
-- row_hash covers it, so adding it rewrites every row once (a row-only
-- re-ingest: no re-embedding, no FTS writes).
-- exam_dates: JSON [{"sem": 1, "date": "<ISO UTC>", "durationMins": 120 | null}, ...],
--   one per offered semester with an exam, by semester; '[]' when none.
ALTER TABLE modules ADD COLUMN exam_dates TEXT NOT NULL DEFAULT '[]';
