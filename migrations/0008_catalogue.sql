-- Phase 3 3B (docs/plans/phase3.md 3B "Code parser", C-7, C2-1): the codes in
-- the NUSMods catalogue with no offering this acad year. A whole query naming
-- one answers `count: 0` with `noMatch: { reason: "not-offered", code, title,
-- related }`; `related` is the dense neighbours of title + description,
-- embedded at request time. Loaded by ingest (scripts/ingest-core.mjs) through
-- /admin/catalogue; no Vectorize or FTS side. `row_hash` is
-- src/rowhash.js catalogueRowHash, so a rerun writes only changed rows.
-- 0007 is 3H's (0007_intents.sql); this file is numbered after it so the
-- order the plan fixed holds once 3H lands.
CREATE TABLE IF NOT EXISTS catalogue_only (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  acad_year   TEXT NOT NULL,
  row_hash    TEXT NOT NULL
);
