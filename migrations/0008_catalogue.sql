-- The codes in the NUSMods catalogue with no offering this acad year. A whole query naming
-- one answers `count: 0` with `noMatch: { reason: "not-offered", code, title,
-- related }`; `related` is the dense neighbours of title + description,
-- embedded at request time. Loaded by ingest (scripts/ingest-core.mjs) through
-- /admin/catalogue; no Vectorize or FTS side. `row_hash` is
-- src/rowhash.js catalogueRowHash, so a rerun writes only changed rows.
CREATE TABLE IF NOT EXISTS catalogue_only (
  code        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  acad_year   TEXT NOT NULL,
  row_hash    TEXT NOT NULL
);
