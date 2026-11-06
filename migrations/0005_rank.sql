-- Persist the bm25 column weights on the FTS table (title x3, description x1;
-- the UNINDEXED code column gets 0). This matters for cost, not just ranking:
-- with the weights stored here, queries can say `ORDER BY rank` instead of
-- `ORDER BY bm25(modules_fts, 0.0, 3.0, 1.0)`. Both give the same order, but
-- calling bm25() as a function makes FTS5 score every matching row, while
-- `rank` uses its internal top-N path. Measured: 389 vs 7 D1 rows read for a
-- query matching 224 documents.
INSERT INTO modules_fts(modules_fts, rank) VALUES('rank', 'bm25(0.0, 3.0, 1.0)');
