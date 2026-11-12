-- External-content FTS keyed on rowid, filter columns for SQL-side filtering,
-- and a row_hash slot for ingest.
--
-- 0002's FTS table stored its own copy of every title and description, and its
-- update/delete triggers deleted by the UNINDEXED `code` column: a full scan of
-- the FTS table per changed row (~46M rows read for a forced full re-ingest).
-- This table reads its content from `modules` and every trigger addresses the
-- FTS row by rowid, which is a point lookup.
--
-- Hazard: nothing may change a modules rowid. The FTS row is keyed on it and no
-- trigger here moves it: the update trigger fires only when code, title or
-- description change, so after a rowid-only update the index still holds the
-- row under its old rowid, which external content then reads from whatever row
-- has it. The modules_rowid_immutable trigger below aborts any statement that
-- changes one, however it is spelt (UPDATE … SET rowid/_rowid_/oid, row-value
-- SET, ON CONFLICT DO UPDATE SET rowid). INSERT OR REPLACE is a separate
-- hazard (see the triggers below; a test bans it).
--
-- `code` stays UNINDEXED: indexing it, even at bm25 weight 0, changes bm25's
-- document lengths and so the ranking. Prefix indexes cost nothing at query
-- time for full-token queries and serve prefix terms without another rebuild.
--
-- This file inserts no d1_migrations row: wrangler (local), applyD1Migrations
-- (tests) and the generated remote wrapper (scripts/remote-migration.mjs) do.

DROP TRIGGER IF EXISTS modules_fts_insert;
DROP TRIGGER IF EXISTS modules_fts_delete;
DROP TRIGGER IF EXISTS modules_fts_update;
DROP TRIGGER IF EXISTS modules_rowid_immutable;
DROP TABLE IF EXISTS modules_fts;

CREATE VIRTUAL TABLE modules_fts USING fts5(
  code UNINDEXED,
  title,
  description,
  content = 'modules',
  content_rowid = 'rowid',
  tokenize = 'porter unicode61',
  prefix = '2 3 4'
);
INSERT INTO modules_fts(modules_fts) VALUES('rebuild');
-- Same persistent rank as 0005, so `ORDER BY rank` keeps FTS5's top-N path.
INSERT INTO modules_fts(modules_fts, rank) VALUES('rank', 'bm25(0.0, 3.0, 1.0)');

-- External content: FTS5 cannot see what a row used to say, so the delete
-- command is given the old values. Never write `modules` with INSERT OR REPLACE:
-- its implicit delete fires no delete trigger and leaves stale index entries
-- (a test fails if any code does). Ingest's ON CONFLICT DO UPDATE keeps the rowid.
CREATE TRIGGER modules_fts_insert AFTER INSERT ON modules BEGIN
  INSERT INTO modules_fts(rowid, code, title, description)
  VALUES (new.rowid, new.code, new.title, new.description);
END;
CREATE TRIGGER modules_fts_delete AFTER DELETE ON modules BEGIN
  INSERT INTO modules_fts(modules_fts, rowid, code, title, description)
  VALUES ('delete', old.rowid, old.code, old.title, old.description);
END;
-- Only an indexed column changing touches the index, so re-ingesting an
-- unchanged row (or one whose semesters/credits changed) costs no FTS writes.
CREATE TRIGGER modules_fts_update AFTER UPDATE OF code, title, description ON modules
WHEN old.title IS NOT new.title OR old.description IS NOT new.description OR old.code IS NOT new.code
BEGIN
  INSERT INTO modules_fts(modules_fts, rowid, code, title, description)
  VALUES ('delete', old.rowid, old.code, old.title, old.description);
  INSERT INTO modules_fts(rowid, code, title, description)
  VALUES (new.rowid, new.code, new.title, new.description);
END;
-- See the hazard note at the top. AFTER, not BEFORE: SQLite re-reads the row
-- after a BEFORE UPDATE trigger (D1 bills it, doubling rows read on every
-- ingest upsert). RAISE(ABORT) still rolls back the whole statement, including
-- the FTS trigger's writes. Costs a comparison per updated row, no reads.
CREATE TRIGGER modules_rowid_immutable AFTER UPDATE ON modules
WHEN new.rowid IS NOT old.rowid
BEGIN
  SELECT RAISE(ABORT, 'modules.rowid is immutable: modules_fts is keyed on it');
END;

-- Filter columns for SQL-side filtering, so a filter never drops matches that a
-- LIMIT cut before it (src/lexical.js). VIRTUAL generated
-- columns: computed on read, never stored, so no backfill and no drift from the
-- JSON they are derived from. `semesters` and `ng_semesters` are JSON integer
-- arrays written by JSON.stringify ("[1,2]"); turning the brackets into commas
-- makes ",1,2," and a membership test a substring search.
ALTER TABLE modules ADD COLUMN sem1 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(semesters, ''), '[', ','), ']', ','), ',1,') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN sem2 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(semesters, ''), '[', ','), ']', ','), ',2,') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN sem3 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(semesters, ''), '[', ','), ']', ','), ',3,') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN sem4 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(semesters, ''), '[', ','), ']', ','), ',4,') > 0) VIRTUAL;
-- The NG list only covers semesters 1 and 2.
ALTER TABLE modules ADD COLUMN ng_sem1 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(ng_semesters, ''), '[', ','), ']', ','), ',1,') > 0) VIRTUAL;
ALTER TABLE modules ADD COLUMN ng_sem2 INTEGER GENERATED ALWAYS AS
  (instr(replace(replace(coalesce(ng_semesters, ''), '[', ','), ']', ','), ',2,') > 0) VIRTUAL;

-- Indexes for the filter-driven plan in src/lexical.js: when a filtered
-- search matches more than FTS_CAP documents and too few survive the bounded
-- top-N, it walks the filtered rows and probes FTS5 by rowid. Without an index
-- on the selective filter that walk is a full scan of modules (EXPLAIN: SCAN m,
-- 6,771 rows) and a search costs ~13k rows. faculty and ng are indexed already
-- (0001, 0003). sem3/sem4 are partial (284/242 rows); sem1/sem2 hold ~63% of
-- rows each, so they are never the cheap driver and get none.
CREATE INDEX IF NOT EXISTS idx_modules_level ON modules(level);
CREATE INDEX IF NOT EXISTS idx_modules_credits ON modules(credits);
CREATE INDEX IF NOT EXISTS idx_modules_sem3 ON modules(sem3) WHERE sem3 = 1;
CREATE INDEX IF NOT EXISTS idx_modules_sem4 ON modules(sem4) WHERE sem4 = 1;

-- Hash of the full normalised row (src/rowhash.js). NULL until ingest writes it.
ALTER TABLE modules ADD COLUMN row_hash TEXT;

-- Schema marker: ingest refuses to run against a database without it, because
-- a full rewrite through 0002's triggers reads ~46M rows.
INSERT INTO meta (key, value, updated_at) VALUES ('schema', '6', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
