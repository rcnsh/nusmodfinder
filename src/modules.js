// @ts-check
// Module rows: GET /module/:code, GET /facets, and the row shapes the search
// and admin routes share.
import { groups } from './group-data.js';
import { bad, json, upstream, withHeaders } from './http.js';
import { exchangeAll, exchangeAt, NG_ACAD_YEAR, NG_SOURCES, OFF_LIST_RULES } from './ng-reasons.js';
import { unscheduled, unscheduledAcadYear } from './ng-unscheduled.js';
import { reviewsOf } from './reviews.js';
import { D1_TIMEOUT_MS, withTimeout } from './upstream.js';
import { moduleWorkload } from './workload.js';

/**
 * A full `modules` row as /module/:code returns it (see migrations/).
 * @typedef {{
 *   code: string, title: string, description: string | null, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: string | null, workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acad_year: string, text_hash: string,
 *   ng: number, ng_semesters: string | null,
 *   exam_semesters?: string | null, su?: number, grading_basis?: string | null, workload_hours?: number | null,
 *   prereq_none?: number, prereq_cohort_only?: number, ng_allow?: number | null, ng_rules?: string | null,
 *   exam_dates?: string | null,
 * }} ModuleRow
 * @typedef {Pick<ModuleRow, 'code' | 'title' | 'department' | 'faculty' | 'credits' | 'level' | 'semesters' | 'ng' | 'ng_semesters'
 *   | 'exam_semesters' | 'su' | 'grading_basis' | 'workload_hours' | 'prereq_none' | 'prereq_cohort_only'
 *   | 'ng_allow' | 'ng_rules' | 'exam_dates'> & { year_prereq?: string | null }} ResultRow
 *   The columns a search result renders (rowToModule) and filters on (pin, dense rows, constraints).
 * @typedef {{ updatedAsAt: string | null, source: string | null, count: number }} NgList
 *   Provenance of data/ng-courses-*.json, written to meta('ng_list') by ingest.
 * @typedef {import('./timing.js').Trace} Trace
 */

export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

// /module/:code: every column of the row as of migrations 0001–0005, in table
// order, named so a later column (generated filter columns, row_hash) does not
// change the response shape.
// Then ng_allow and ng_rules, answered as `exchange` (one entry per semester
// and study level, with reasons); exam_dates, answered as `examDates`;
// prereq_cohort_only, answered as `prereqCohortOnly`; and grading_basis,
// answered as `gradingBasis`.
const MODULE_COLUMNS =
  'code, title, description, credits, department, faculty, level, semesters, workload, prerequisite, preclusion, acad_year, text_hash, ng, ng_semesters, '
  + 'ng_allow, ng_rules, exam_dates, prereq_cohort_only, grading_basis';

/**
 * /module/:code's Cache-Control: a row changes only at an ingest, so a
 * 200 may sit in browsers and shared caches for 5 minutes and a 404 for one;
 * a failure is never stored. No ETag and no edge cache.
 */
const MODULE_CACHE = Object.freeze({ ok: 'public, max-age=300', notFound: 'public, max-age=60', failed: 'no-store' });

/** NUSMods' page for a course, which has its class times. @param {string} code */
export const nusmodsUrl = (code) => `https://nusmods.com/courses/${code}`;

// /search: only what rowToModule renders and the pin's filter check reads.
// exam_dates is answered as each result's `examDates`. `year_prereq` (ADR 0007)
// is the prerequisite, only where it mentions a year (the rest read NULL, so
// the result hydrate stays small), for the year-of-study note
// (src/year-note.js). The text itself is not answered; the same rows are read.
export const RESULT_COLUMNS = 'code, title, department, faculty, credits, level, semesters, ng, ng_semesters, '
  + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only, ng_allow, ng_rules, exam_dates, '
  + "CASE WHEN prerequisite LIKE '%year%' THEN prerequisite END AS year_prereq";

/**
 * A read on the nearest replica, or the primary when replication is off.
 * @param {Env} env
 * @returns {D1DatabaseSession}
 */
export const readSession = (env) => env.DB.withSession('first-unconstrained');

/**
 * Runs one D1 call under the D1 timeout and the span `name`.
 * @template T
 * @param {Trace} trace
 * @param {string} name
 * @param {() => Promise<T>} fn
 */
export const d1Timed = (trace, name, fn) => trace.time(name, () => withTimeout('D1', D1_TIMEOUT_MS, fn));

/**
 * @param {ResultRow} row
 * @param {number} [score]
 * @param {number | null} [bit] exchange mode's allow-mask bit (src/ng-bit.js): the card gets
 *   `exchange`, that bit's status and reasons
 * @param {{ 1: number, 2: number } | null} [semBits] exchange mode with no semester: the
 *   bits for Sem 1 and Sem 2 at the request's study level; the card gets `exchangeBySem`, each
 *   semester's status and reasons, so a student planning both sees one value per semester
 */
export function rowToModule(row, score, bit = null, semBits = null) {
  return {
    code: row.code,
    title: row.title,
    department: row.department,
    faculty: row.faculty,
    credits: row.credits,
    level: row.level,
    semesters: JSON.parse(row.semesters ?? '[]'),
    ng: row.ng === 1,
    ngSemesters: JSON.parse(row.ng_semesters ?? '[]'),
    ...(bit === null ? {} : { exchange: exchangeAt(row, bit) }),
    ...(semBits === null ? {} : { exchangeBySem: { 1: exchangeAt(row, semBits[1]), 2: exchangeAt(row, semBits[2]) } }),
    // Each exam, its date ISO UTC, as /module/:code's `examDates`.
    examDates: JSON.parse(row.exam_dates ?? '[]'),
    // Students' review scores from NUSMods (src/reviews.js), null when there are none.
    reviews: reviewsOf(row.code),
    ...(score === undefined ? {} : { score }),
  };
}

// The faculty filter is only usable if the caller knows the exact strings D1
// stores, so the page fetches them from here rather than hardcoding 26 names.
/**
 * @param {Env} env
 * @param {Trace} trace
 */
export async function handleFacets(env, trace) {
  const db = readSession(env);
  try {
    // One row, not full-table aggregates. The live computation below cost
    // 9,842 D1 rows read on EVERY page load (1,364 + 7,303 + 1,175) to produce
    // about 35 rows of output — the single largest source of row reads in the
    // app. It is now rebuilt at ingest time via POST /admin/facets. (With 0006
    // and the per-credits/semester counts the live computation reads 21,488:
    // 6,771 + 6,771 + 1,175 + 6,771 on the full corpus.)
    const cached = /** @type {{ value: string } | null} */ (await d1Timed(trace, 'd1', () =>
      db.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').first()));
    if (cached?.value) {
      // The exchange-mode sources and their dates are bundled with the Worker,
      // and the rules about courses off the exchange list beside them.
      return new Response(JSON.stringify({ ...JSON.parse(cached.value), ngSources: NG_SOURCES, offListRules: OFF_LIST_RULES }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
      });
    }
    // No precomputed row (fresh database, or ingest never finished). Fall back
    // so the page still works, but say so rather than silently being expensive.
    console.warn('facets: no precomputed row; falling back to live aggregates (~21.5k rows read)');
    return json({ ...(await d1Timed(trace, 'd1', () => computeFacets(db))), ngSources: NG_SOURCES, offListRules: OFF_LIST_RULES }, 200);
  } catch (err) {
    return d1Failed('/facets', err);
  }
}

/**
 * A D1 failure on /module or /facets: one log line with the route and the error,
 * and nothing about the request (no URL, query or IP), then the 502 every caller answers.
 * /search writes its own `search` line instead.
 * @param {'/module/:code' | '/facets'} route
 * @param {unknown} err
 */
function d1Failed(route, err) {
  console.error(JSON.stringify({ event: 'd1_error', route, error: /** @type {any} */ (err)?.message ?? String(err) }));
  return upstream('d1', err);
}

/**
 * The NG list provenance ingest stored, or null before the first ingest.
 * @param {D1Database | D1DatabaseSession} db
 * @returns {Promise<NgList | null>}
 */
export async function readNgList(db) {
  const row = /** @type {{ value: string } | null} */ (
    await db.prepare('SELECT value FROM meta WHERE key = ?').bind('ng_list').first());
  return row ? JSON.parse(row.value) : null;
}

/**
 * @param {D1Database | D1DatabaseSession} db
 */
export async function computeFacets(db) {
  const faculties = await db.prepare(
    'SELECT faculty, COUNT(*) AS n FROM modules WHERE faculty IS NOT NULL GROUP BY faculty ORDER BY faculty',
  ).all();
  const levels = await db.prepare(
    'SELECT level, COUNT(*) AS n FROM modules WHERE level IS NOT NULL GROUP BY level ORDER BY level',
  ).all();
  const ng = await db.prepare('SELECT COUNT(*) AS n FROM modules WHERE ng = 1').first();
  // Per-value row counts for the remaining filters, in one scan. src/lexical.js
  // reads them (with the faculty, level and ng counts above) to pick the most
  // selective filter to drive its filter-driven plan.
  const byCredits = /** @type {D1Result<{ credits: number | null, n: number, s1: number, s2: number, s3: number, s4: number, g1: number, g2: number }>} */ (
    await db.prepare(
      `SELECT credits, COUNT(*) AS n, SUM(sem1) AS s1, SUM(sem2) AS s2, SUM(sem3) AS s3, SUM(sem4) AS s4,
              SUM(ng_sem1) AS g1, SUM(ng_sem2) AS g2
         FROM modules GROUP BY credits ORDER BY credits`,
    ).all());
  const total = (/** @type {'s1' | 's2' | 's3' | 's4' | 'g1' | 'g2'} */ k) =>
    byCredits.results.reduce((sum, r) => sum + (r[k] ?? 0), 0);
  const ngList = await readNgList(db);
  return {
    faculties: faculties.results.map((r) => ({ name: r.faculty, count: r.n })),
    levels: levels.results.map((r) => ({ level: r.level, count: r.n })),
    // updatedAsAt comes from data/ng-courses-*.json via ingest (meta.ng_list);
    // null until an ingest has recorded it.
    ng: { count: ng?.n ?? 0, updatedAsAt: ngList?.updatedAsAt ?? null },
    credits: byCredits.results.filter((r) => r.credits !== null).map((r) => ({ credits: r.credits, count: r.n })),
    semesters: [1, 2, 3, 4].map((sem) => ({ sem, count: total(/** @type {'s1'} */ (`s${sem}`)) })),
    ngSemesters: [1, 2].map((sem) => ({ sem, count: total(/** @type {'g1'} */ (`g${sem}`)) })),
  };
}

/**
 * A course's other codes: its duplicate group's members but itself
 * (src/group-data.js), [] when it has none. No D1 read.
 * @param {string} code
 */
export function otherCodes(code) {
  const { groupOf, members } = groups();
  const key = groupOf.get(code);
  return key === undefined ? [] : (members.get(key) ?? []).filter((c) => c !== code);
}

/** NUS's year label for an acad year: YYYY-YYYY -> YYYY/YY. @param {string} acadYear */
const yearLabel = (acadYear) => acadYear.replace(/^(\d{4})-\d{2}(\d{2})$/, '$1/$2');

/** "Sem 1", "Sem 1 and Sem 2". @param {number[]} sems */
const semWords = (sems) => sems.map((s) => `Sem ${s}`).join(' and ');

/** A missing table reads as `no such table` in D1's message (a database before migration 0008). @param {unknown} err */
const noSuchTable = (err) => /no such table/i.test(String(/** @type {any} */ (err)?.message ?? err));

/**
 * /module/:code's 404, saying which kind of miss it is:
 * - `ng-listed`: on the NG list with no classes this year (data/ng-unscheduled.json):
 *   the fields a row has, `semesters` and `examDates` empty, and `exchange` from
 *   the file's allow mask by exchangeAll, so the page reads it like a row with no
 *   classes. No D1 read;
 * - `catalogue-only`: a `catalogue_only` row: its title and description;
 * - `unknown`: neither, or no `catalogue_only` table yet.
 * Each carries `acadYear`: the file's, the catalogue row's, else ng-reasons.json's.
 * Any other failed read is a 5xx, never a cached wrong answer.
 * @param {D1DatabaseSession} db
 * @param {string} code
 * @param {Trace} trace
 */
async function notFound(db, code, trace) {
  /** @param {Record<string, unknown>} body */
  const answer = (body) => withHeaders(json({ error: 'not_found', ...body }, 404), { 'cache-control': MODULE_CACHE.notFound });
  const entry = unscheduled().get(code);
  if (entry) {
    const { ngAllow, ngRules, ...fields } = entry;
    const acadYear = unscheduledAcadYear();
    // A semester NUS hasn't published is last year's list, said as such.
    const pending = (entry.ngUnpublished ?? []).filter((s) => entry.ngSemesters.includes(s));
    const listed = entry.ngSemesters.filter((s) => !pending.includes(s));
    const lists = [
      ...(listed.length ? [`NUS lists ${code} for ${semWords(listed)}`] : []),
      ...(pending.length ? [`NUS's last list had ${code} for ${semWords(pending)} (this year's isn't out yet)`] : []),
    ].join('; ');
    return answer({
      kind: 'ng-listed',
      message: `${lists}, but NUSMods shows no classes for it in ${yearLabel(acadYear)}.`,
      acadYear,
      ...fields,
      semesters: [],
      ng: true,
      exchange: exchangeAll({ ng: 1, ng_allow: ngAllow, ng_rules: ngRules ? JSON.stringify(ngRules) : null, prerequisite: entry.prerequisite, level: entry.level, faculty: entry.faculty }),
      examDates: [],
      nusmodsUrl: nusmodsUrl(code),
    });
  }
  /** @type {{ title: string, description: string | null, acad_year: string } | null} */
  let row = null;
  try {
    row = await d1Timed(trace, 'd1', () =>
      db.prepare('SELECT title, description, acad_year FROM catalogue_only WHERE code = ?').bind(code).first());
  } catch (err) {
    if (!noSuchTable(err)) return withHeaders(d1Failed('/module/:code', err), { 'cache-control': MODULE_CACHE.failed });
  }
  if (row) {
    return answer({
      kind: 'catalogue-only',
      message: `${code} is in the NUS catalogue but not offered in ${yearLabel(row.acad_year)}.`,
      code, title: row.title, description: row.description, acadYear: row.acad_year,
    });
  }
  return answer({ kind: 'unknown', message: `No module ${code} in this acad year.`, acadYear: NG_ACAD_YEAR });
}

/**
 * @param {Env} env
 * @param {string} code The raw path segment after /module/.
 * @param {Trace} trace
 */
export async function handleModule(env, code, trace) {
  let decoded;
  try {
    decoded = decodeURIComponent(code);
  } catch {
    return bad('The module code in the path is not valid percent-encoding.');
  }
  const upper = decoded.toUpperCase();
  if (!MODULE_CODE_RE.test(upper)) return bad(`"${upper}" is not a module code.`);
  const db = readSession(env);
  /** @type {ModuleRow | null} */
  let row;
  try {
    row = await d1Timed(trace, 'd1', () =>
      db.prepare(`SELECT ${MODULE_COLUMNS} FROM modules WHERE code = ?`).bind(upper).first());
  } catch (err) {
    return withHeaders(d1Failed('/module/:code', err), { 'cache-control': MODULE_CACHE.failed });
  }
  // A row wins over the file, so a code that gained classes at a re-ingest answers as a row.
  if (!row) return notFound(db, upper, trace);
  /** @type {Partial<ModuleRow>} */
  const rest = { ...row };
  delete rest.ng_rules;
  delete rest.exam_dates;
  delete rest.prereq_cohort_only;
  delete rest.grading_basis;
  return withHeaders(json({
    ...rest,
    semesters: JSON.parse(row.semesters ?? '[]'),
    workload: moduleWorkload(row.workload),
    ng: row.ng === 1,
    ng_semesters: JSON.parse(row.ng_semesters ?? '[]'),
    ng_allow: row.ng_allow ?? 0,
    // Why the course is open, noted or closed, per semester and study level.
    exchange: exchangeAll(row),
    // Each exam, its date ISO UTC (the page shows Singapore time), and where the class times are.
    examDates: JSON.parse(row.exam_dates ?? '[]'),
    nusmodsUrl: nusmodsUrl(row.code),
    // The cohort-only flag (src/cohort-only.js, set at ingest): the prerequisite names only NUS intake
    // years or programmes, so the page says there is no course prerequisite.
    prereqCohortOnly: row.prereq_cohort_only === 1,
    // NUSMods' grading basis ("Graded", "Completed Satisfactory/Unsatisfactory", ...), and the
    // course's other codes, which the shortlist counts as the same course.
    gradingBasis: row.grading_basis ?? null,
    otherCodes: otherCodes(row.code),
  }), { 'cache-control': MODULE_CACHE.ok });
}
