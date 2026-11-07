-- Added after the Phase 4 gate failed: vector-only recall lost to BM25 on
-- topical queries, so the plan's fallback (reciprocal-rank fusion) is in force.
-- FTS5 gives the Worker a lexical ranking to fuse the vector results against.
CREATE VIRTUAL TABLE IF NOT EXISTS modules_fts USING fts5(
  code UNINDEXED,
  title,
  description,
  tokenize = 'porter unicode61'
);

-- Keep the index in lockstep with `modules` so ingest needs no extra step.
CREATE TRIGGER IF NOT EXISTS modules_fts_insert AFTER INSERT ON modules BEGIN
  INSERT INTO modules_fts(code, title, description) VALUES (new.code, new.title, new.description);
END;
CREATE TRIGGER IF NOT EXISTS modules_fts_delete AFTER DELETE ON modules BEGIN
  DELETE FROM modules_fts WHERE code = old.code;
END;
CREATE TRIGGER IF NOT EXISTS modules_fts_update AFTER UPDATE ON modules BEGIN
  DELETE FROM modules_fts WHERE code = old.code;
  INSERT INTO modules_fts(code, title, description) VALUES (new.code, new.title, new.description);
END;
