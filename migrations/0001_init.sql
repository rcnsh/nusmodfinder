-- D1 is the source of truth for everything the API displays. Vectorize stores
-- only the embedding plus the handful of small properties that get filtered on.
-- This is the pre-0002 shape: `ng`/`ng_semesters` are added by 0003, the FTS
-- table by 0002 and `meta` by 0004.
CREATE TABLE IF NOT EXISTS modules (
  code         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  credits      REAL,
  department   TEXT,
  faculty      TEXT,
  level        INTEGER,
  semesters    TEXT,          -- JSON array, e.g. "[1,2]"
  workload     TEXT,          -- JSON array of hours per activity
  prerequisite TEXT,
  preclusion   TEXT,
  acad_year    TEXT NOT NULL,
  text_hash    TEXT NOT NULL  -- hash of the embedded blob, for skip-on-reingest
);
CREATE INDEX IF NOT EXISTS idx_modules_faculty ON modules(faculty);
