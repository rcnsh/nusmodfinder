// @ts-check
import { groups } from './group-data.js';
import { bad, json, upstream, withHeaders } from './http.js';
import { exchangeAll, exchangeAt, NG_ACAD_YEAR, NG_SOURCES, OFF_LIST_RULES } from './ng-reasons.js';
import { unscheduled, unscheduledAcadYear } from './ng-unscheduled.js';
import { reviewsOf } from './reviews.js';
import { D1_TIMEOUT_MS, withTimeout } from './upstream.js';
import { moduleWorkload } from './workload.js';

/**
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
 * @typedef {{ updatedAsAt: string | null, source: string | null, count: number }} NgList
 * @typedef {import('./timing.js').Trace} Trace
 */

export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

const MODULE_COLUMNS =
  'code, title, description, credits, department, faculty, level, semesters, workload, prerequisite, preclusion, acad_year, text_hash, ng, ng_semesters, '
  + 'ng_allow, ng_rules, exam_dates, prereq_cohort_only, grading_basis';

const MODULE_CACHE = Object.freeze({ ok: 'public, max-age=300', notFound: 'public, max-age=60', failed: 'no-store' });

/** @param {string} code */
export const nusmodsUrl = (code) => `https://nusmods.com/courses/${code}`;

export const RESULT_COLUMNS = 'code, title, department, faculty, credits, level, semesters, ng, ng_semesters, '
  + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only, ng_allow, ng_rules, exam_dates, '
  + "CASE WHEN prerequisite LIKE '%year%' THEN prerequisite END AS year_prereq";

/**
 * @param {Env} env
 * @returns {D1DatabaseSession}
 */
export const readSession = (env) => env.DB.withSession('first-unconstrained');

/**
 * @template T
 * @param {Trace} trace
 * @param {string} name
 * @param {() => Promise<T>} fn
 */
export const d1Timed = (trace, name, fn) => trace.time(name, () => withTimeout('D1', D1_TIMEOUT_MS, fn));

/**
 * @param {ResultRow} row
 * @param {number} [score]
 * @param {number | null} [bit]
 * @param {{ 1: number, 2: number } | null} [semBits]
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
    examDates: JSON.parse(row.exam_dates ?? '[]'),
    reviews: reviewsOf(row.code),
    ...(score === undefined ? {} : { score }),
  };
}

/**
 * @param {Env} env
 * @param {Trace} trace
 */
export async function handleFacets(env, trace) {
  const db = readSession(env);
  try {
    const cached = /** @type {{ value: string } | null} */ (await d1Timed(trace, 'd1', () =>
      db.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').first()));
    if (cached?.value) {
      return new Response(JSON.stringify({ ...JSON.parse(cached.value), ngSources: NG_SOURCES, offListRules: OFF_LIST_RULES }), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
      });
    }
    console.warn('facets: no precomputed row; falling back to live aggregates (~21.5k rows read)');
    return json({ ...(await d1Timed(trace, 'd1', () => computeFacets(db))), ngSources: NG_SOURCES, offListRules: OFF_LIST_RULES }, 200);
  } catch (err) {
    return d1Failed('/facets', err);
  }
}

/**
 * @param {'/module/:code' | '/facets'} route
 * @param {unknown} err
 */
function d1Failed(route, err) {
  console.error(JSON.stringify({ event: 'd1_error', route, error: /** @type {any} */ (err)?.message ?? String(err) }));
  return upstream('d1', err);
}

/**
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
    ng: { count: ng?.n ?? 0, updatedAsAt: ngList?.updatedAsAt ?? null },
    credits: byCredits.results.filter((r) => r.credits !== null).map((r) => ({ credits: r.credits, count: r.n })),
    semesters: [1, 2, 3, 4].map((sem) => ({ sem, count: total(/** @type {'s1'} */ (`s${sem}`)) })),
    ngSemesters: [1, 2].map((sem) => ({ sem, count: total(/** @type {'g1'} */ (`g${sem}`)) })),
  };
}

/** @param {string} code */
export function otherCodes(code) {
  const { groupOf, members } = groups();
  const key = groupOf.get(code);
  return key === undefined ? [] : (members.get(key) ?? []).filter((c) => c !== code);
}

/** @param {string} acadYear */
const yearLabel = (acadYear) => acadYear.replace(/^(\d{4})-\d{2}(\d{2})$/, '$1/$2');

/** @param {number[]} sems */
const semWords = (sems) => sems.map((s) => `Sem ${s}`).join(' and ');

/** @param {unknown} err */
const noSuchTable = (err) => /no such table/i.test(String(/** @type {any} */ (err)?.message ?? err));

/**
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
 * @param {string} code
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
    exchange: exchangeAll(row),
    examDates: JSON.parse(row.exam_dates ?? '[]'),
    nusmodsUrl: nusmodsUrl(row.code),
    prereqCohortOnly: row.prereq_cohort_only === 1,
    gradingBasis: row.grading_basis ?? null,
    otherCodes: otherCodes(row.code),
  }), { 'cache-control': MODULE_CACHE.ok });
}
