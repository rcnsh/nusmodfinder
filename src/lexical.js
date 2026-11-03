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
  const match = ftsMatchExpression(ftsTokens(query));
  if (!match) return [];
  return runFts(db, match, echo, limit, trace);
}

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} match
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 */
async function runFts(db, match, echo, limit, trace) {
  const where = ['modules_fts MATCH ?'];
  /** @type {(string | number)[]} */
  const binds = [match];
  if (echo.level !== undefined) { where.push('m.level = ?'); binds.push(echo.level); }
  if (echo.credits !== undefined) { where.push('m.credits = ?'); binds.push(echo.credits); }
  if (echo.faculty !== undefined) { where.push('m.faculty = ?'); binds.push(echo.faculty); }
  if (echo.ng === true) { where.push('m.ng = 1'); }
  // semesters is a JSON array in D1, so the semester filter is applied in JS
  // below — which is why echo.sem forces the join.

  // ORDER BY rank, NOT ORDER BY bm25(...). They produce the same ordering — the
  // table's persistent rank config is bm25(0.0, 3.0, 1.0), set in
  // migrations/0005_rank.sql — but calling bm25() as a function forces FTS5 to
  // materialise and score every matching row, while `rank` uses its internal
  // top-N path. Measured on "machine AND learning" (224 matching documents):
  // bm25() cost 389 D1 rows read, rank cost 7. That single word is the
  // difference between ~1,250 and ~100,000 searches per day on the free tier.
  //
  // Joining `modules` also costs a row read per match, so only join when a
  // filter needs a column that lives over there.
  const needsJoin = where.length > 1 || echo.sem !== undefined;
  const sql = needsJoin
    ? `SELECT m.code AS code, m.semesters AS semesters
         FROM modules_fts JOIN modules m ON m.code = modules_fts.code
        WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`
    : `SELECT modules_fts.code AS code, NULL AS semesters
         FROM modules_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`;

  const res = /** @type {D1Result<{ code: string, semesters: string | null }>} */ (
    await trace.time('fts', () => db.prepare(sql).bind(...binds, limit * 4).all()));
  trace.d1Result(res);
  const { results } = res;

  return results
    .filter((r) => echo.sem === undefined || JSON.parse(r.semesters ?? '[]').includes(echo.sem))
    .slice(0, limit)
    .map((r) => r.code);
}
