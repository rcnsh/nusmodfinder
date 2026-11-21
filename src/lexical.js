// @ts-check
import { ftsMatch } from './fts-query.js';
import { INTENT } from './intents.js';
import { ngBit } from './ng-bit.js';
import { filterValues } from './vector-bundle.js';

export { ftsMatch, queryTokens } from './fts-query.js';

/**
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {import('./vector-bundle.js').Constraints} FilterEcho
 */

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {string} query
 * @param {FilterEcho} echo
 * @param {number} limit
 * @param {Trace} trace
 * @param {import('./fts-query.js').FtsTerms} [terms]
 */
export async function lexicalSearch(db, query, echo, limit, trace, terms) {
  const match = ftsMatch(query, terms);
  if (!match) return [];
  return runFts(db, match, echo, limit, trace);
}

export const FTS_CAP = 2_000;

/**
 * @typedef {'sem' | 'level' | 'credits' | 'faculty' | 'ng'} FilterKey
 * @typedef {{
 *   sem: Map<number, number>, level: Map<number, number>, credits: Map<number, number>,
 *   faculty: Map<string, number>, ng: number,
 * }} FilterCounts
 */

/**
 * @param {FilterKey} key
 * @param {FilterEcho} echo
 */
const indexed = (key, echo) => key !== 'sem' || echo.sem === 3 || echo.sem === 4;

/** @type {FilterKey[]} */
export const FIXED_DRIVER_ORDER = ['sem', 'faculty', 'ng', 'level', 'credits'];

/** @param {FilterEcho} echo */
const indexedFilters = (echo) => FIXED_DRIVER_ORDER.filter((k) =>
  (k === 'ng' ? echo.ng === true : k === 'sem' ? echo.sem !== undefined && echo.ng !== true : echo[k] !== undefined)
  && indexed(k, echo));

/**
 * @param {FilterEcho} echo
 * @param {FilterCounts | null} counts
 * @returns {FilterKey | undefined}
 */
export function chooseDriver(echo, counts) {
  const active = indexedFilters(echo);
  if (!counts) return active[0];
  /** @param {FilterKey} k */
  const rows = (k) => {
    if (k === 'ng') return counts.ng;
    if (k === 'faculty') return counts.faculty.get(/** @type {string} */ (echo.faculty)) ?? 0;
    return filterValues(/** @type {number | number[]} */ (echo[k])).reduce((n, v) => n + (counts[k].get(v) ?? 0), 0);
  };
  let best;
  for (const k of active) if (best === undefined || rows(k) < rows(best)) best = k;
  return best;
}

/**
 * @param {FilterEcho} echo
 * @param {FilterKey} [driver]
 * @returns {{ clauses: string[], binds: (string | number)[] }}
 */
export function filterSql(echo, driver) {
  /** @type {string[]} */
  const clauses = [];
  /** @type {(string | number)[]} */
  const binds = [];
  const col = (/** @type {FilterKey} */ key, /** @type {string} */ name) =>
    `${driver !== undefined && key !== driver ? '+' : ''}m.${name}`;
  if (echo.sem !== undefined && echo.ng !== true) {
    if (![1, 2, 3, 4].includes(echo.sem)) throw new RangeError(`sem must be 1-4, got ${echo.sem}`);
    clauses.push(`${col('sem', `sem${echo.sem}`)} = 1`);
  }
  for (const key of /** @type {const} */ (['level', 'credits'])) {
    const v = echo[key];
    if (v === undefined) continue;
    const vs = filterValues(v);
    clauses.push(vs.length === 1 ? `${col(key, key)} = ?` : `${col(key, key)} IN (${vs.map(() => '?').join(', ')})`);
    binds.push(...vs);
  }
  if (echo.faculty !== undefined) { clauses.push(`${col('faculty', 'faculty')} = ?`); binds.push(echo.faculty); }
  if (echo.ng === true) clauses.push(`${col('ng', 'ng')} = 1`);
  const plus = driver !== undefined ? '+' : '';
  if (echo.ng === true && !echo.ngIgnoreAllow) {
    const bit = ngBit(echo) ?? 0;
    if (!Number.isInteger(bit) || bit < 0 || bit > 0x7fff) throw new RangeError(`bad allow bit ${bit}`);
    clauses.push(`(+m.ng_allow & ${bit}) != 0`);
  }
  if (echo.exam === 0) {
    if (echo.sem !== undefined) clauses.push(`${plus}m.exam_sem${echo.sem} = 0`);
    else clauses.push(`${plus}m.exam_semesters = '[]'`);
  }
  if (echo.su === 1) clauses.push(`(${plus}m.su = 1 OR ${plus}m.grading_basis = 'Completed Satisfactory/Unsatisfactory')`);
  if (echo.hoursBelow !== undefined) { clauses.push(`${plus}m.workload_hours < ?`); binds.push(echo.hoursBelow); }
  if (echo.prereq === 'none') {
    clauses.push(INTENT.prereq === 'i' ? `${plus}m.prereq_none = 1` : `(${plus}m.prereq_none = 1 OR ${plus}m.prereq_cohort_only = 1)`);
  }
  if (echo.levelWindow) {
    clauses.push(`${plus}m.level >= ?`);
    binds.push(echo.levelWindow.min);
    if (echo.levelWindow.max !== null) { clauses.push(`${plus}m.level <= ?`); binds.push(echo.levelWindow.max); }
  }
  if (echo.ranges) {
    if (echo.ranges.length === 0) clauses.push('0');
    else {
      clauses.push(`(${echo.ranges.map(() => `(${plus}m.code >= ? AND ${plus}m.code < ?)`).join(' OR ')})`);
      for (const [lo, hi] of echo.ranges) binds.push(lo, hi);
    }
  }
  return { clauses, binds };
}

/**
 * @param {any} facets
 * @returns {FilterCounts | null}
 */
export function parseFilterCounts(facets) {
  const list = (/** @type {unknown} */ xs, /** @type {string} */ key) => Array.isArray(xs) ? new Map(xs.map((x) => [x[key], x.count])) : null;
  const sem = list(facets?.semesters, 'sem');
  const level = list(facets?.levels, 'level');
  const credits = list(facets?.credits, 'credits');
  const faculty = list(facets?.faculties, 'name');
  const ng = facets?.ng?.count;
  if (!sem || !level || !credits || !faculty || typeof ng !== 'number') return null;
  return { sem, level, credits, faculty, ng };
}

/** @type {Promise<FilterCounts | null> | null} */
let filterCounts = null;

export function resetFilterCounts() { filterCounts = null; }

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {Trace} trace
 * @returns {Promise<FilterCounts | null>}
 */
export function loadFilterCounts(db, trace) {
  filterCounts ??= trace.time('fts', () => db.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').all())
    .then((res) => {
      trace.d1Result(res);
      const value = /** @type {{ value?: string } | undefined} */ (res.results[0])?.value;
      const counts = value ? parseFilterCounts(JSON.parse(value)) : null;
      if (!counts) filterCounts = null;
      return counts;
    })
    .catch(() => {
      filterCounts = null;
      return null;
    });
  return filterCounts;
}

/**
 * @param {FilterEcho} echo
 * @param {FilterKey} [driver]
 */
export function exactStatement(echo, driver) {
  const { clauses, binds } = filterSql(echo, driver);
  const sql = `WITH capped AS (
       SELECT count(*) AS n FROM (SELECT 1 FROM modules_fts WHERE modules_fts MATCH ?1 LIMIT ${FTS_CAP + 1}))
     SELECT m.code AS code
       FROM capped CROSS JOIN modules AS m CROSS JOIN modules_fts ON modules_fts.rowid = m.rowid
      WHERE capped.n > ${FTS_CAP} AND modules_fts MATCH ?1 AND ${clauses.join(' AND ')}
      ORDER BY modules_fts.rank, m.rowid LIMIT ?`;
  return { sql, binds };
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
    const res = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
      `SELECT modules_fts.code AS code FROM modules_fts
        WHERE modules_fts MATCH ? ORDER BY rank LIMIT ?`,
    ).bind(match, limit * 4).all()));
    trace.d1Result(res);
    return res.results.slice(0, limit).map((r) => r.code);
  }

  const where = clauses.join(' AND ');
  const bounded = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `WITH hits AS (
       SELECT rowid, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank LIMIT ${FTS_CAP})
     SELECT m.code AS code FROM hits CROSS JOIN modules m ON m.rowid = hits.rowid
      WHERE ${where} ORDER BY hits.rank, hits.rowid LIMIT ?`,
  ).bind(match, ...binds, limit).all()));
  trace.d1Result(bounded);
  if (bounded.results.length >= limit) return bounded.results.map((r) => r.code);

  const driver = chooseDriver(echo, indexedFilters(echo).length > 1 ? await loadFilterCounts(db, trace) : null);
  const stmt = exactStatement(echo, driver);
  const exact = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(stmt.sql)
    .bind(match, ...stmt.binds, limit).all()));
  trace.d1Result(exact);
  return (exact.results.length ? exact.results : bounded.results).map((r) => r.code);
}

/**
 * @param {D1Database | D1DatabaseSession} db
 * @param {FilterEcho & { ranges: import('./vector-bundle.js').CodeRange[] }} constraints
 * @param {number} limit
 * @param {Trace} trace
 * @returns {Promise<string[]>}
 */
export async function rangeMembers(db, constraints, limit, trace) {
  const { clauses, binds } = filterSql(constraints);
  const res = /** @type {D1Result<{ code: string }>} */ (await trace.time('fts', () => db.prepare(
    `SELECT m.code AS code FROM modules m WHERE ${clauses.join(' AND ')} ORDER BY m.code LIMIT ?`,
  ).bind(...binds, limit).all()));
  trace.d1Result(res);
  return res.results.map((r) => r.code);
}
