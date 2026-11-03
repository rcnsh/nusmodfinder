// @ts-check
// Module rows: GET /module/:code, GET /facets, and the row shape both the
// search and admin routes share.
import { bad, json, upstream } from './http.js';

/**
 * A `modules` row as D1 returns it (see migrations/).
 * @typedef {{
 *   code: string, title: string, description: string | null, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: string | null, workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acad_year: string, text_hash: string,
 *   ng: number, ng_semesters: string | null,
 * }} ModuleRow
 * @typedef {import('./timing.js').Trace} Trace
 */

export const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

// Provenance for the Non-Graduating course list, surfaced in /facets so the UI
// can say how old it is. Bump this when data/ng-courses-*.json is regenerated.
const NG_LIST_UPDATED = '01 Sep 2026';

export const SELECT_COLUMNS =
  'code, title, description, credits, department, faculty, level, semesters, workload, prerequisite, preclusion, acad_year, ng, ng_semesters';

/**
 * @param {ModuleRow} row
 * @param {number} [score]
 */
export function rowToModule(row, score) {
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
  try {
    // One row, not three full-table aggregates. The live computation below cost
    // 9,842 D1 rows read on EVERY page load (1,364 + 7,303 + 1,175) to produce
    // about 35 rows of output — the single largest source of row reads in the
    // app. It is now rebuilt at ingest time via POST /admin/facets.
    const cached = /** @type {{ value: string } | null} */ (await trace.time('d1', () =>
      env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').first()));
    if (cached?.value) {
      return new Response(cached.value, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600',
        },
      });
    }
    // No precomputed row (fresh database, or ingest never finished). Fall back
    // so the page still works, but say so rather than silently being expensive.
    console.warn('facets: no precomputed row; falling back to live aggregates (~9.8k rows read)');
    return json(await trace.time('d1', () => computeFacets(env)), 200);
  } catch (err) {
    return upstream('d1', err);
  }
}

/** @param {Env} env */
export async function computeFacets(env) {
  const faculties = await env.DB.prepare(
    'SELECT faculty, COUNT(*) AS n FROM modules WHERE faculty IS NOT NULL GROUP BY faculty ORDER BY faculty',
  ).all();
  const levels = await env.DB.prepare(
    'SELECT level, COUNT(*) AS n FROM modules WHERE level IS NOT NULL GROUP BY level ORDER BY level',
  ).all();
  const ng = await env.DB.prepare('SELECT COUNT(*) AS n FROM modules WHERE ng = 1').first();
  return {
    faculties: faculties.results.map((r) => ({ name: r.faculty, count: r.n })),
    levels: levels.results.map((r) => ({ level: r.level, count: r.n })),
    ng: { count: ng?.n ?? 0, updatedAsAt: NG_LIST_UPDATED },
  };
}

/**
 * @param {Env} env
 * @param {string} code
 * @param {Trace} trace
 */
export async function handleModule(env, code, trace) {
  const upper = decodeURIComponent(code).toUpperCase();
  if (!MODULE_CODE_RE.test(upper)) return bad(`"${upper}" is not a module code.`);
  /** @type {ModuleRow | null} */
  let row;
  try {
    row = await trace.time('d1', () => env.DB.prepare('SELECT * FROM modules WHERE code = ?').bind(upper).first());
  } catch (err) {
    return upstream('d1', err);
  }
  if (!row) return json({ error: 'not_found', message: `No module ${upper} in this acad year.` }, 404);
  return json({
    ...row,
    semesters: JSON.parse(row.semesters ?? '[]'),
    workload: row.workload ? JSON.parse(row.workload) : null,
    ng: row.ng === 1,
    ng_semesters: JSON.parse(row.ng_semesters ?? '[]'),
  });
}
