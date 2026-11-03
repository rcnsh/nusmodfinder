-- D1 is the source of truth for everything the API displays. Vectorize stores
-- only the embedding plus the handful of small properties that get filtered on.
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

-- Lexical half of the hybrid retriever; see migrations/0002_fts.sql.
CREATE VIRTUAL TABLE IF NOT EXISTS modules_fts USING fts5(
  code UNINDEXED, title, description, tokenize = 'porter unicode61'
);

-- Non-Graduating (exchange) availability; see migrations/0003_ng.sql.
-- ALTER statements live in the migration so a fresh database and an existing
-- one converge on the same shape.

-- Precomputed facet counts; see migrations/0004_meta.sql.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
