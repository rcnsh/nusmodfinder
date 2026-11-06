-- Precomputed facet counts. /facets previously ran three aggregates over the
-- whole modules table on EVERY page load: 1,364 + 7,303 + 1,175 = 9,842 D1 rows
-- read to produce ~35 rows of output. It is now one row, rebuilt at ingest.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,   -- JSON
  updated_at TEXT NOT NULL
);
