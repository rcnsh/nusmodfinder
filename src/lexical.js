// @ts-check
// Lexical half of the hybrid retriever: query tokenising, the FTS5 MATCH
// expression, and the BM25-ranked lookup with filters. Takes a D1 database or
// session so callers choose primary vs replica.

/**
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {import('./search.js').FilterEcho} FilterEcho
 */

// Stopwords are dropped before the FTS5 query is built. Without this, a natural
// question like "how do i start my own company" matches every "Design Your Own
// Course" record on the word "own" and buries the real answers. This is the same
// list the offline BM25 baseline uses, so neither retriever gets an easier query.
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);

// FTS5 MATCH is its own query language: unescaped user text is a syntax error
// waiting to happen. Reduce the query to bare tokens, quote each one, and OR
// them together — recall comes from the OR, ranking from bm25().
/** @param {string} query */
function ftsTokens(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // If the query is nothing but stopwords, keep them rather than matching nothing.
  const tokens = all.filter((t) => !STOPWORDS.has(t));
  return tokens.length ? tokens : all;
}

// FTS5 MATCH is its own query language: unescaped user text is a syntax error
// waiting to happen. Reduce the query to bare tokens, quote each one, and OR
// them together — recall comes from the OR, ranking from the rank column.
/** @param {string[]} tokens */
function ftsMatchExpression(tokens) {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

/**
 * The FTS5 MATCH expression for a user query, or null when it has no tokens.
 * @param {string} query
 */
export function ftsMatch(query) {
  return ftsMatchExpression(ftsTokens(query));
}

// Lexical half of the hybrid retriever. Filters are applied in SQL so the two
// halves see the same candidate universe (R4 holds on both paths).
/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} query
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 */
export async function lexicalSearch(db, query, echo, limit, trace) {
  const match = ftsMatch(query);
  if (!match) return [];
  return runFts(db, match, echo, limit, trace);
}

// Filtered lexical search keeps at most this many FTS hits before joining
// `modules` for the filters (docs/plans/phase1.md r2): the join costs one row
// read per hit, so the cap bounds a filtered search at about 2 x FTS_CAP rows.
export const FTS_CAP = 2000;

/**
 * SQL predicates over `modules m` for the active filters. Semester and NG use
 * the generated columns from migrations/0006_fts_external.sql.
 * @param {FilterEcho} echo
 * @returns {{ clauses: string[], binds: (string | number)[] }}
 */
export function filterSql(echo) {
  /** @type {string[]} */
  const clauses = [];
  /** @type {(string | number)[]} */
  const binds = [];
  if (echo.sem !== undefined) {
    // Interpolated into a column name, so it must be one of the four columns.
    if (![1, 2, 3, 4].includes(echo.sem)) throw new RangeError(`sem must be 1-4, got ${echo.sem}`);
    clauses.push(`m.sem${echo.sem} = 1`);
  }
  if (echo.level !== undefined) { clauses.push('m.level = ?'); binds.push(echo.level); }
  if (echo.credits !== undefined) { clauses.push('m.credits = ?'); binds.push(echo.credits); }
  if (echo.faculty !== undefined) { clauses.push('m.faculty = ?'); binds.push(echo.faculty); }
  if (echo.ng === true) clauses.push('m.ng = 1');
  return { clauses, binds };
}

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} match
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 */
async function runFts(db, match, echo, limit, trace) {
  const { clauses, binds } = filterSql(echo);

  if (clauses.length === 0) {
    // ORDER BY rank, NOT ORDER BY bm25(...). They produce the same ordering — the
    // table's persistent rank config is bm25(0.0, 3.0, 1.0), set in
    // migrations/0005_rank.sql and again in 0006 — but calling bm25() as a
    // function forces FTS5 to materialise and score every matching row, while
    // `rank` uses its internal top-N path. Measured on "machine AND learning"
    // (224 matching documents): bm25() cost 389 D1 rows read, rank cost 7.
    //
    // Unchanged from before 0006 (LIMIT and slice included) so unfiltered
    // rankings stay identical.
    const res = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
      `SELECT modules_fts.code AS code FROM modules_fts
        WHERE modules_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).bind(match, limit * 4).all()));
    trace.d1Result(res);
    return res.results.slice(0, limit).map((r) => r.code);
  }

  // Filters run in SQL against the generated columns, after a bounded FTS
  // top-N (FINDINGS B1: they used to run in JS after the LIMIT, dropping
  // matches). FTS5 returns rank ties in rowid order, so (rank, rowid) is the
  // total order every path here agrees on. The outer LIMIT stops the scan as
  // soon as `limit` hits survive, which is the common case. CROSS JOIN keeps
  // `hits` the outer loop: given a plain JOIN and the filter indexes, SQLite
  // drives from modules and builds an index on hits instead, losing the early
  // stop (level=5 on "buildings and urban design": 7,455 rows read vs 211).
  const where = clauses.join(' AND ');
  const bounded = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `WITH hits AS (
       SELECT rowid, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank LIMIT ${FTS_CAP})
     SELECT m.code AS code FROM hits CROSS JOIN modules m ON m.rowid = hits.rowid
      WHERE ${where} ORDER BY hits.rank, hits.rowid LIMIT ?`,
  ).bind(match, ...binds, limit).all()));
  trace.d1Result(bounded);
  if (bounded.results.length >= limit) return bounded.results.map((r) => r.code);

  // Fewer than `limit` survived. That is the exact answer unless the query
  // matched more than FTS_CAP documents, in which case a filtered match ranked
  // below the cap was never looked at. Then run the filter-driven plan: walk
  // the (indexed) filtered rows and ask FTS5 about each by rowid, so the cost
  // follows the size of the filtered set, not of the match set; never an
  // unbounded match-driven scan.
  //
  // `capped` counts at most FTS_CAP + 1 matches (no ranking, so no scoring).
  // CROSS JOIN fixes the loop order with it outermost: when the query did not
  // overflow the cap its one row fails `n > FTS_CAP` and the join never runs.
  // (As a scalar subquery in WHERE the guard is not hoisted: SQLite still
  // walks every modules row, measured 6,831 rows read for nothing.)
  // `?1` is the MATCH expression in both places; each later bare `?` takes
  // the next number, so the binds are (match, ...filter binds, limit).
  const exact = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `WITH capped AS (
       SELECT count(*) AS n FROM (SELECT 1 FROM modules_fts WHERE modules_fts MATCH ?1 LIMIT ${FTS_CAP + 1}))
     SELECT m.code AS code
       FROM capped CROSS JOIN modules AS m CROSS JOIN modules_fts ON modules_fts.rowid = m.rowid
      WHERE capped.n > ${FTS_CAP} AND modules_fts MATCH ?1 AND ${where}
      ORDER BY modules_fts.rank, m.rowid LIMIT ?`,
  ).bind(match, ...binds, limit).all()));
  trace.d1Result(exact);
  // An empty exact result means either the guard was false (the bounded
  // answer is complete) or nothing matches the filters at all (and then the
  // bounded answer is empty too).
  return (exact.results.length ? exact.results : bounded.results).map((r) => r.code);
}
