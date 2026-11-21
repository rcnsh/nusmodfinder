// @ts-check
import dataVersion from './data-version.json';
import { bundleSearch, denseBundle } from './dense.js';
import { DEFAULT_MODEL } from './embedding.js';
import { appVersion, bad, json, upstream, withHeaders } from './http.js';
import { groups } from './group-data.js';
import { groupKeyOf, semesterRepresentative } from './groups.js';
import { intentContext } from './intent-data.js';
import { lexicalSearch, rangeMembers } from './lexical.js';
import { RESULT_COLUMNS, d1Timed, readSession, rowToModule } from './modules.js';
import { INTENT } from './intents.js';
import { NO_SIGNAL_TAU } from './no-signal.js';
import { STUDIES, bitOf, ngBit } from './ng-bit.js';
import { unscheduled } from './ng-unscheduled.js';
import { canonicalQuery, parseIgnore, parseQuery } from './query-intent.js';
import { EMBED_CORRECTED } from './typo.js';
import { filterValues, hasCode } from './vector-bundle.js';
import {
  AI_TIMEOUT_MS, D1_TIMEOUT_MS, TimeoutError, VECTORIZE_TIMEOUT_MS, denseCircuit, withTimeout,
} from './upstream.js';

/**
 * @typedef {import('./modules.js').ResultRow} ResultRow
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {import('./vector-bundle.js').FilterEcho} FilterEcho
 * @typedef {Record<string, string | number | boolean | { $in: number[] }>} VectorFilter
 * @typedef {'hybrid' | 'vector' | 'lexical'} Mode
 * @typedef {{ q: string, echo: FilterEcho, filter: VectorFilter, mode: Mode, topK: number, ignore: string[] }} SearchQuery
 * @typedef {import('./vector-bundle.js').Constraints} Constraints
 * @typedef {import('./vector-bundle.js').CodeRange} CodeRange
 * @typedef {import('./query-intent.js').ParsedQuery} ParsedQuery
 * @typedef {{ source: string, reason: 'error' | 'timeout' | 'circuit-open' }} Degraded
 * @typedef {{ code: string, score: number }} DenseHit
 * @typedef {'bundle' | 'vectorize'} DenseBackend
 */

const MAX_QUERY_CHARS = 200;
const MAX_TOPK = 50;
const DEFAULT_TOPK = 20;
const LOGGED_QUERY_CHARS = 100;

const CACHE_TTL_S = 3600;
const DEGRADED_CACHE_TTL_S = 60;
const DEGRADED_HEADER = 'x-search-degraded';
/** @param {boolean} degraded */
const cacheControl = (degraded) => `public, max-age=${degraded ? DEGRADED_CACHE_TTL_S : CACHE_TTL_S}`;

/** @param {Headers} headers */
export const crossSite = (headers) =>
  headers.get('sec-fetch-site') === 'cross-site' && headers.get('sec-fetch-dest') !== 'document';

export const DATA_VERSION = String(dataVersion.version);

export const NO_VERSION_ID = 'dev';

/** @param {Env} env */
export function versionId(env) {
  const meta = /** @type {WorkerVersionMetadata | undefined} */ (env.CF_VERSION_METADATA);
  return meta?.id || NO_VERSION_ID;
}

/**
 * @param {Env} env
 * @returns {DenseBackend}
 */
export function denseBackend(env) {
  return /** @type {string | undefined} */ (env.DENSE_BACKEND) === 'vectorize' ? 'vectorize' : 'bundle';
}

const RRF_K = 60;
const CANDIDATE_MULTIPLIER = 3;

export const MAX_FILTER_VALUES = 12;

/**
 * @param {string | null} raw
 * @param {(n: number) => boolean} ok
 * @returns {number | number[] | null | undefined}
 */
function listParam(raw, ok) {
  if (raw === null || raw.trim() === '') return undefined;
  const parts = raw.split(',').map((p) => p.trim());
  if (parts.some((p) => p === '')) return null;
  const ns = parts.map(Number);
  if (!ns.every(ok)) return null;
  const distinct = [...new Set(ns)].sort((a, b) => a - b);
  if (distinct.length > MAX_FILTER_VALUES) return null;
  return distinct.length === 1 ? distinct[0] : distinct;
}

/** @param {number | number[]} v */
const vectorValue = (v) => (Array.isArray(v) ? { $in: v } : v);

/** @param {URLSearchParams} params */
function parseFilters(params) {
  /** @type {FilterEcho} */
  const echo = {};
  /** @type {VectorFilter} */
  const filter = {};
  /** @type {string[]} */
  const errors = [];

  const sem = params.get('sem');
  if (sem !== null && sem !== '') {
    const n = Number(sem);
    if (!Number.isInteger(n) || n < 1 || n > 4) errors.push('sem must be 1, 2, 3 or 4');
    else { echo.sem = n; filter[`sem${n}`] = true; }
  }

  const level = listParam(params.get('level'), (n) => Number.isInteger(n) && n >= 1 && n <= 8);
  if (level === null) errors.push('level must be an integer from 1 to 8, or a comma-separated list of them');
  else if (level !== undefined) { echo.level = level; filter.level = vectorValue(level); }

  const credits = listParam(params.get('credits'), (n) => Number.isFinite(n) && n >= 0);
  if (credits === null) errors.push(`credits must be a non-negative number, or a comma-separated list of at most ${MAX_FILTER_VALUES}`);
  else if (credits !== undefined) { echo.credits = credits; filter.credits = vectorValue(credits); }

  const faculty = params.get('faculty');
  if (faculty !== null && faculty.trim() !== '') {
    echo.faculty = faculty.trim();
    filter.faculty = faculty.trim();
  }

  const ng = params.get('ng');
  if (ng !== null && ng !== '' && ng !== 'false' && ng !== '0') {
    echo.ng = true;
    filter.ng = true;
    if (echo.sem !== undefined) delete filter[`sem${echo.sem}`];
  }

  let studyRequired = false;
  const study = params.get('study');
  if (echo.ng === true) {
    if (study === null || study === '') studyRequired = true;
    else if (!(/** @type {string[]} */ (STUDIES)).includes(study)) errors.push(`study must be one of ${STUDIES.join(', ')}`);
    else echo.study = /** @type {import('./ng-bit.js').Study} */ (study);
  }

  const exam = params.get('exam');
  if (exam !== null && exam !== '') {
    if (exam !== '0') errors.push('exam must be 0 (no final exam listed)');
    else echo.exam = 0;
  }
  const su = params.get('su');
  if (su !== null && su !== '') {
    if (su !== '1') errors.push('su must be 1 (S/U-able or graded CS/CU)');
    else echo.su = 1;
  }
  const hoursBelow = params.get('hoursBelow');
  if (hoursBelow !== null && hoursBelow !== '') {
    const n = Number(hoursBelow);
    if (!/^[1-9][0-9]?$/.test(hoursBelow)) errors.push('hoursBelow must be an integer from 1 to 99');
    else echo.hoursBelow = n;
  }
  const prereq = params.get('prereq');
  if (prereq !== null && prereq !== '') {
    if (prereq !== 'none') errors.push('prereq must be none');
    else echo.prereq = 'none';
  }

  return { echo, filter, errors, studyRequired };
}

/**
 * @param {URLSearchParams} params
 * @returns {{ log: Record<string, unknown>, error: string, code?: string, query?: undefined }
 *   | { log: Record<string, unknown>, query: SearchQuery, error?: undefined, code?: undefined }}
 */
export function parseSearch(params) {
  const raw = params.get('q');
  const trimmed = raw?.trim() ?? null;
  const q = trimmed === null ? null : canonicalQuery(trimmed);
  /** @type {Record<string, unknown>} */
  const log = { q: q?.slice(0, LOGGED_QUERY_CHARS) ?? null, qLength: q?.length ?? null, degraded: null };

  if (trimmed === null || q === null) return { log, error: 'Missing required query parameter "q".' };
  if (trimmed === '') return { log, error: 'Query parameter "q" was empty.' };
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { log, error: `Query parameter "q" was ${trimmed.length} characters; the maximum is ${MAX_QUERY_CHARS}.` };
  }

  const { echo, filter, errors, studyRequired } = parseFilters(params);
  log.filters = { ...echo, ...(echo.faculty !== undefined ? { faculty: true } : {}) };
  if (errors.length) return { log, error: errors.join('; ') };
  if (studyRequired) {
    return {
      log, code: 'study-required',
      error: `Exchange mode (ng=1) needs your year of study: study=${STUDIES.join('|')} (ug4 = 4th year or later).`,
    };
  }

  const mode = params.get('mode') ?? 'hybrid';
  if (mode !== 'hybrid' && mode !== 'vector' && mode !== 'lexical') {
    log.mode = 'invalid';
    return { log, error: `Unknown mode "${mode}"; expected hybrid, vector or lexical.` };
  }
  log.mode = mode;

  const rawTopK = params.get('topK')?.trim() ?? '';
  const requestedTopK = rawTopK === '' ? DEFAULT_TOPK : Number(rawTopK);
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.trunc(requestedTopK), 1), MAX_TOPK)
    : DEFAULT_TOPK;
  log.topK = topK;

  const ignored = parseIgnore(params.get('ignore'));
  if (ignored.error !== undefined) return { log, error: ignored.error };
  if (ignored.ignore.length) log.ignore = ignored.ignore;

  return { log, query: { q, echo, filter, mode, topK, ignore: ignored.ignore } };
}

/**
 * @param {string} origin
 * @param {SearchQuery} query
 * @param {string} [version]
 */
export function canonicalCacheKey(origin, { q, echo, mode, topK, ignore }, version = NO_VERSION_ID) {
  /** @type {[string, string][]} */
  const pairs = [['q', q], ['dv', DATA_VERSION], ['v', version]];
  if (echo.sem !== undefined) pairs.push(['sem', String(echo.sem)]);
  if (echo.level !== undefined) pairs.push(['level', filterValues(echo.level).join(',')]);
  if (echo.credits !== undefined) pairs.push(['credits', filterValues(echo.credits).join(',')]);
  if (echo.faculty !== undefined) pairs.push(['faculty', echo.faculty]);
  if (echo.ng === true) pairs.push(['ng', '1']);
  if (echo.ng === true && echo.study !== undefined) pairs.push(['study', echo.study]);
  if (echo.exam === 0) pairs.push(['exam', '0']);
  if (echo.su === 1) pairs.push(['su', '1']);
  if (echo.hoursBelow !== undefined) pairs.push(['hoursBelow', String(echo.hoursBelow)]);
  if (echo.prereq === 'none') pairs.push(['prereq', 'none']);
  if (mode !== 'hybrid') pairs.push(['mode', mode]);
  if (topK !== DEFAULT_TOPK) pairs.push(['topK', String(topK)]);
  if (ignore.length) pairs.push(['ignore', ignore.join(',')]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Request(`${origin}/search?${new URLSearchParams(pairs)}`, { method: 'GET' });
}

/**
 * @param {string | URL} url
 * @param {string} [version]
 */
export function searchCacheKey(url, version = NO_VERSION_ID) {
  const u = new URL(url);
  const { query } = parseSearch(u.searchParams);
  return query ? canonicalCacheKey(u.origin, query, version) : null;
}

/**
 * @param {ResultRow} row
 * @param {Constraints} echo
 */
export function localMatchesFilters(row, echo) {
  if (echo.ng === true && row.ng !== 1) return false;
  if (echo.ng === true && !echo.ngIgnoreAllow && ((row.ng_allow ?? 0) & (ngBit(echo) ?? 0)) === 0) return false;
  if (echo.sem !== undefined && echo.ng !== true && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.level !== undefined && (row.level === null || !filterValues(echo.level).includes(row.level))) return false;
  if (echo.credits !== undefined && (row.credits === null || !filterValues(echo.credits).includes(row.credits))) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  if (echo.levelWindow) {
    const { min, max } = echo.levelWindow;
    if (row.level === null || row.level < min || (max !== null && row.level > max)) return false;
  }
  if (echo.ranges && !echo.ranges.some(([lo, hi]) => row.code >= lo && row.code < hi)) return false;
  if (echo.exam === 0) {
    const exams = JSON.parse(row.exam_semesters ?? '[]');
    if (echo.sem !== undefined ? exams.includes(echo.sem) : exams.length > 0) return false;
  }
  if (echo.su === 1 && row.su !== 1 && row.grading_basis !== 'Completed Satisfactory/Unsatisfactory') return false;
  if (echo.hoursBelow !== undefined && !(row.workload_hours != null && row.workload_hours < echo.hoursBelow)) return false;
  if (echo.prereq === 'none' && !(row.prereq_none === 1 || (INTENT.prereq === 'ii' && row.prereq_cohort_only === 1))) return false;
  return true;
}

/**
 * @param {CodeRange[]} a
 * @param {CodeRange[]} b
 * @returns {CodeRange[]}
 */
function intersectRanges(a, b) {
  /** @type {CodeRange[]} */
  const out = [];
  for (const [alo, ahi] of a) {
    for (const [blo, bhi] of b) {
      const lo = alo > blo ? alo : blo;
      const hi = ahi < bhi ? ahi : bhi;
      if (lo < hi) out.push([lo, hi]);
    }
  }
  return out;
}

/** @param {string[][]} lists */
export function fuse(lists) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const list of lists) {
    list.forEach((code, i) => {
      scores.set(code, (scores.get(code) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  const tiebreak = (/** @type {string} */ code) => {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
    return h;
  };
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || tiebreak(a[0]) - tiebreak(b[0]) || a[0].localeCompare(b[0]))
    .map(([code, score]) => ({ code, score }));
}

/**
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: any }>}
 */
const settle = (p) => p.then((value) => ({ ok: /** @type {const} */ (true), value }), (error) => ({ ok: /** @type {const} */ (false), error }));

class DenseFailure extends Error {
  /** @param {'workers-ai' | 'vectorize' | 'dense-index'} source @param {any} cause */
  constructor(source, cause) {
    super(cause?.message ?? String(cause), { cause });
    this.source = source;
    this.timedOut = cause instanceof TimeoutError;
  }
}

/**
 * @param {Env} env
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embedOne(env, text) {
  try {
    const embedded = /** @type {{ data?: number[][] }} */ (await withTimeout('Workers AI', AI_TIMEOUT_MS, (signal) =>
      env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: [text] }, { signal })));
    const values = embedded?.data?.[0];
    if (!Array.isArray(values)) throw new Error('Workers AI returned no embedding for the query.');
    return values;
  } catch (err) {
    throw new DenseFailure('workers-ai', err);
  }
}

/**
 * @param {Env} env
 * @param {string[]} texts
 * @param {Trace} trace
 * @returns {Promise<number[][]>}
 */
const embedAll = (env, texts, trace) => trace.time('embed', () => Promise.all(texts.map((t) => embedOne(env, t))));

/**
 * @param {Pick<ParsedQuery, 'dense' | 'corrected'>} parsed
 * @param {boolean} [embedCorrected]
 */
export const denseTexts = (parsed, embedCorrected = EMBED_CORRECTED) =>
  (embedCorrected && parsed.corrected !== null ? [parsed.dense, parsed.corrected] : [parsed.dense]);

/**
 * @param {DenseHit[][]} lists
 * @param {number} depth
 * @returns {DenseHit[]}
 */
export function mergeDense(lists, depth) {
  if (lists.length === 1) return lists[0].slice(0, depth);
  /** @type {Map<string, number>} */
  const best = new Map();
  for (const list of lists) {
    for (const { code, score } of list) {
      const prev = best.get(code);
      if (prev === undefined || score > prev) best.set(code, score);
    }
  }
  return [...best].map(([code, score]) => ({ code, score })).sort((a, b) => b.score - a.score).slice(0, depth);
}

/**
 * @param {ArrayLike<number>[]} vectors
 * @param {Constraints} constraints
 * @param {number} depth
 * @param {Trace} trace
 * @param {(score: number) => void} [firstTop]
 * @returns {Promise<DenseHit[]>}
 */
async function bundleHits(vectors, constraints, depth, trace, firstTop) {
  try {
    return await trace.time('vector', async () => {
      const lists = vectors.map((v) => bundleSearch(v, constraints, depth));
      if (lists[0].length) firstTop?.(lists[0][0].score);
      return mergeDense(lists, depth);
    });
  } catch (err) {
    throw new DenseFailure('dense-index', err);
  }
}

/**
 * @param {Env} env
 * @param {ArrayLike<number>[]} vectors
 * @param {Constraints} constraints
 * @param {VectorFilter} filter
 * @param {number} depth
 * @param {Trace} trace
 * @param {(score: number) => void} [firstTop]
 * @returns {Promise<DenseHit[]>}
 */
async function vectorSearch(env, vectors, constraints, filter, depth, trace, firstTop) {
  if (denseBackend(env) === 'bundle') return bundleHits(vectors, constraints, depth, trace, firstTop);
  const topK = constraints.ng === true ? Math.max(depth, STANDBY_NG_DEPTH) : depth;
  try {
    const lists = await trace.time('vector', () => Promise.all(vectors.map((vector) => withTimeout('Vectorize', VECTORIZE_TIMEOUT_MS, () =>
      env.VECTORIZE.query(/** @type {number[]} */ (vector), { topK, ...(Object.keys(filter).length ? { filter } : {}) })))));
    const hits = lists.map((result) => (result?.matches ?? []).map((m) => ({ code: m.id, score: m.score })));
    if (hits[0].length) firstTop?.(hits[0][0].score);
    return mergeDense(hits, topK);
  } catch (err) {
    throw new DenseFailure('vectorize', err);
  }
}

/**
 * @template T
 * @param {Env} env
 * @param {string[]} texts
 * @param {Trace} trace
 * @param {(vectors: number[][]) => Promise<T>} then
 * @returns {Promise<T>}
 */
const denseRun = (env, texts, trace, then) => embedAll(env, texts, trace).then(then).then(
  (value) => { denseCircuit.success(); return value; },
  (err) => { denseCircuit.failure(err.source); throw err; },
);

const D1_PARAMS = 100;
const STANDBY_NG_DEPTH = 100;

/**
 * @param {D1DatabaseSession} db
 * @param {string[]} codes
 * @param {Trace} trace
 * @returns {Promise<Map<string, ResultRow>>}
 */
async function fetchRows(db, codes, trace) {
  /** @type {Map<string, ResultRow>} */
  const rows = new Map();
  for (let i = 0; i < codes.length; i += D1_PARAMS) {
    const chunk = codes.slice(i, i + D1_PARAMS);
    const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'hydrate', () => db.prepare(
      `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all()));
    trace.d1Result(res);
    for (const r of res.results) rows.set(r.code, r);
  }
  return rows;
}


const VARIANT_COLUMNS = 'code, credits, level, faculty, semesters, ng, ng_semesters, '
  + 'exam_semesters, su, grading_basis, workload_hours, prereq_none, prereq_cohort_only, ng_allow, ng_rules';

/**
 * @param {Env} env
 * @returns {number | null}
 */
const noSignalTau = (env) => {
  const v = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (env)).NO_SIGNAL_TAU;
  if (v === 'off') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : NO_SIGNAL_TAU;
};

/** @param {Env} env */
const collapseOn = (env) => /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (env)).COLLAPSE_GROUPS !== 'off';

/**
 * @param {Env} env
 * @returns {'filtered' | 'ignore' | null}
 */
export function oracleTraceMode(env) {
  const e = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (env));
  if (!e.ORACLE_TRACE || !e.TEST_MIGRATIONS) return null;
  return e.ORACLE_TRACE === 'ignore' ? 'ignore' : 'filtered';
}
const TRACE_FULL_DEPTH = 100_000;

/**
 * @typedef {{
 *   sem: number,
 *   constraints: Constraints,
 *   rank: Map<string, number>,
 *   pinned: Set<string>,
 *   toModule: (row: ResultRow, score?: number) => ReturnType<typeof rowToModule>,
 * }} SemesterSwap
 */

/** @param {{ semesters: string | null }} row @param {number} sem */
const offeredIn = (row, sem) => JSON.parse(row.semesters ?? '[]').includes(sem);

/**
 * @param {D1DatabaseSession} db
 * @param {ReturnType<typeof rowToModule>[]} results
 * @param {Constraints} echo
 * @param {Trace} trace
 * @param {SemesterSwap | null} [swap]
 */
async function attachVariants(db, results, echo, trace, swap = null) {
  const { groupOf, members } = groups();
  const shown = new Set(results.map((r) => r.code));
  /** @type {Map<string, string[]>} */
  const want = new Map();
  for (const r of results) {
    const key = groupOf.get(r.code);
    if (key === undefined) continue;
    const others = /** @type {string[]} */ (members.get(key)).filter((c) => !shown.has(c));
    if (others.length) want.set(r.code, others);
  }
  if (want.size === 0) return results;
  const codes = [...new Set([...want.values()].flat())];
  /** @type {Map<string, ResultRow>} */
  const rows = new Map();
  for (let i = 0; i < codes.length; i += D1_PARAMS) {
    const chunk = codes.slice(i, i + D1_PARAMS);
    const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'variants', () => db.prepare(
      `SELECT ${swap ? RESULT_COLUMNS : VARIANT_COLUMNS} FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).all()));
    trace.d1Result(res);
    for (const row of res.results) rows.set(row.code, row);
  }
  return results.map((result) => {
    let r = result;
    let others = want.get(r.code) ?? [];
    if (swap && !swap.pinned.has(r.code) && !r.semesters.includes(swap.sem)) {
      const s = swap;
      const passing = others.filter((c) => { const row = rows.get(c); return row !== undefined && localMatchesFilters(row, s.constraints); });
      const rep = semesterRepresentative(r.code, passing, s.rank, (c) => c !== result.code && offeredIn(/** @type {ResultRow} */ (rows.get(c)), s.sem));
      if (rep !== r.code) {
        others = [...others.filter((c) => c !== rep), r.code].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        r = s.toModule(/** @type {ResultRow} */ (rows.get(rep)), r.score);
      }
    }
    const variants = others.flatMap((code) => {
      if (code === result.code) return [{ code, credits: result.credits }];
      const row = rows.get(code);
      return row && localMatchesFilters(row, echo) ? [{ code, credits: row.credits }] : [];
    });
    return variants.length ? { ...r, variants } : r;
  });
}

/**
 * @param {D1DatabaseSession} db
 * @param {string} q
 * @param {string[]} ignore
 * @param {Trace} trace
 * @returns {Promise<ParsedQuery>}
 */
async function parseWithCorpus(db, q, ignore, trace) {
  /** @type {import('./vector-bundle.js').Bundle | null} */
  let bundle = null;
  try { bundle = denseBundle(); } catch {}
  const b = bundle;
  /** @type {Map<string, boolean>} */
  const known = new Map();
  for (;;) {
    /** @type {Set<string>} */
    const asked = new Set();
    const parsed = parseQuery(q, intentContext((code) => {
      if (b && hasCode(b, code)) return true;
      if (!known.has(code)) asked.add(code);
      return known.get(code) === true;
    }), ignore);
    if (asked.size === 0) return parsed;
    const codes = [...asked];
    for (let i = 0; i < codes.length; i += D1_PARAMS) {
      const chunk = codes.slice(i, i + D1_PARAMS);
      const res = /** @type {D1Result<{ code: string }>} */ (await d1Timed(trace, 'pin', () => db.prepare(
        `SELECT code FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all()));
      trace.d1Result(res);
      const found = new Set(res.results.map((r) => r.code));
      for (const c of chunk) known.set(c, found.has(c));
    }
  }
}

const RELATED_K = 5;
const INTENT_PARAMS = /** @type {const} */ (['exam', 'su', 'hoursBelow', 'prereq']);
const STANDBY_RELATED_DEPTH = 50;
const RELATED_TEXT_CHARS = 2_000;

/** @param {{ title: string, description: string | null }} row */
const catalogueText = (row) => [row.title, row.description]
  .filter((s) => typeof s === 'string' && s.trim())
  .map((s) => { const t = /** @type {string} */ (s).replace(/\s+/g, ' ').trim(); return /[.!?]$/.test(t) ? t : `${t}.`; })
  .join(' ')
  .slice(0, RELATED_TEXT_CHARS);

/**
 * @param {SearchQuery} query
 * @param {Env} env
 * @param {Trace} trace
 * @param {Record<string, unknown>} log
 * @returns {Promise<{ response: Response, degraded: Degraded | null }>}
 */
async function runSearch({ q, echo: requestEcho, filter, mode, topK, ignore }, env, trace, log) {
  const db = readSession(env);
  const traceMode = oracleTraceMode(env);
  const ignoreAllow = traceMode === 'ignore' && requestEcho.ng === true;
  /** @type {FilterEcho & { ngIgnoreAllow?: true }} */
  const echo = ignoreAllow ? { ...requestEcho, ngIgnoreAllow: true } : requestEcho;
  /** @type {Record<string, unknown>} */
  const oracleLists = {};
  trace.reserve('pin', 'embed', 'vector', 'fts', 'hydrate');

  /** @type {ParsedQuery} */
  let parsed;
  try {
    parsed = await parseWithCorpus(db, q, ignore, trace);
  } catch (err) {
    return { response: upstream('d1', err), degraded: null };
  }
  log.route = parsed.kind;
  const collapsing = collapseOn(env);
  const singleList = !parsed.codeList && (mode === 'lexical' || (mode === 'vector' && denseBackend(env) === 'bundle'));
  const depth = ignoreAllow ? TRACE_FULL_DEPTH
    : !collapsing ? Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK) : singleList ? MAX_TOPK * 2 : MAX_TOPK;
  oracleLists.depth = depth;

  /** @type {Degraded | null} */
  let degraded = null;
  const tryDense = mode === 'vector' || (mode === 'hybrid' && !denseCircuit.open());
  if (mode === 'hybrid' && !tryDense) degraded = { source: denseCircuit.lastSource ?? 'workers-ai', reason: 'circuit-open' };
  /** @param {DenseFailure} err */
  const degrade = (err) => {
    degraded = { source: err.source, reason: err.timedOut ? 'timeout' : 'error' };
    log.degradedMessage = err.message;
  };

  const noClasses = unscheduled();
  const notOffered = parsed.codes
    .filter((t) => t.status === 'not-offered' || (t.status === 'unknown' && noClasses.has(t.code))).map((t) => t.code);
  /** @type {string[]} */
  let hiddenPins = [];

  /**
   * @param {ReturnType<typeof rowToModule>[]} results
   * @param {Record<string, number>} retrieval
   * @param {Record<string, unknown>} [extra]
   */
  const respond = (results, retrieval, extra = {}) => {
    if (degraded) {
      log.degraded = degraded;
      trace.describe('degraded', `${degraded.source}-${degraded.reason}`);
    }
    log.dense = mode === 'lexical' ? null : denseBackend(env);
    return {
      degraded,
      response: json({
        query: q,
        filters: requestEcho,
        count: results.length,
        mode,
        interpreted: parsed.interpreted,
        hiddenPins,
        notOffered,
        ...extra,
        ...(degraded ? { degraded } : {}),
        retrieval,
        results,
        ...(traceMode ? { oracle: oracleLists } : {}),
      }),
    };
  };

  /** @type {FilterEcho} */
  const intentFilter = { ...echo, ...parsed.constraints };
  if (echo.hoursBelow !== undefined && parsed.constraints.hoursBelow !== undefined) {
    intentFilter.hoursBelow = Math.min(echo.hoursBelow, parsed.constraints.hoursBelow);
  }
  /** @type {Constraints} */
  const constraints = {
    ...intentFilter,
    ...(parsed.level ? { levelWindow: parsed.level } : {}),
    ...(parsed.ranges ? { ranges: parsed.ranges } : {}),
  };
  const variantFilter = parsed.level ? { ...intentFilter, levelWindow: parsed.level } : intentFilter;

  if (echo.ng === true && (echo.sem === 3 || echo.sem === 4)) {
    log.counts = { returned: 0 };
    return respond([], { vector: 0, lexical: 0, fused: 0 }, { noMatch: { reason: 'ng-special-term' } });
  }
  const bit = ngBit(echo);
  const semBits = bit !== null && echo.sem === undefined && echo.study !== undefined
    ? { 1: bitOf(1, echo.study), 2: bitOf(2, echo.study) } : null;
  /** @param {ResultRow} row @param {number} [score] */
  const toModule = (row, score) => rowToModule(row, score, bit, semBits);
  const typed = new Set(parsed.codes.filter((t) => t.status === 'offered').map((t) => t.code));
  /**
   * @param {Constraints} resultConstraints
   * @param {string[]} ranked
   * @returns {SemesterSwap | null}
   */
  const semesterSwap = (resultConstraints, ranked) => (echo.sem === undefined ? null : {
    sem: echo.sem, constraints: resultConstraints, rank: new Map(ranked.map((c, i) => [c, i])), pinned: new Set([...typed, ...parsed.pins]), toModule,
  });

  if (parsed.kind === 'no-match') {
    const nm = /** @type {import('./query-intent.js').NoMatch} */ (parsed.noMatch);
    const listed = noClasses.get(nm.code);
    if (nm.reason === 'unknown-code' && !listed) {
      log.counts = { returned: 0 };
      return respond([], { vector: 0, lexical: 0, fused: 0 }, { noMatch: { reason: nm.reason, code: nm.code } });
    }
    /** @type {{ title: string, description: string | null } | null} */
    let row = listed ? { title: listed.title, description: listed.description } : null;
    if (!listed) {
      try {
        row = await d1Timed(trace, 'pin', () => db.prepare('SELECT title, description FROM catalogue_only WHERE code = ?').bind(nm.code).first());
      } catch (err) {
        console.warn(`catalogue_only lookup failed: ${/** @type {any} */ (err)?.message ?? err}`);
      }
    }
    /** @type {string[]} */
    let related = [];
    if (row && tryDense) {
      const text = catalogueText(row);
      const standbyRecheck = denseBackend(env) !== 'bundle' && (INTENT_PARAMS.some((k) => intentFilter[k] !== undefined) || echo.ng === true);
      const recheck = standbyRecheck || echo.ng === true;
      const depth = standbyRecheck ? STANDBY_RELATED_DEPTH : RELATED_K;
      const hits = await settle(denseRun(env, [text], trace, (vs) => vectorSearch(env, vs, intentFilter, filter, depth, trace)));
      if (hits.ok) related = hits.value.map((h) => h.code);
      else degrade(/** @type {DenseFailure} */ (hits.error));
      if (related.length && recheck) {
        const rows = await settle(fetchRows(db, related, trace));
        related = rows.ok ? related.filter((c) => {
          const r = rows.value.get(c);
          return r !== undefined && localMatchesFilters(r, intentFilter);
        }) : [];
        if (!rows.ok) console.warn(`related hydrate failed: ${/** @type {any} */ (rows.error)?.message ?? rows.error}`);
      }
      related = related.slice(0, RELATED_K);
    }
    log.counts = { returned: 0, related: related.length };
    if (listed) {
      return respond([], { vector: related.length, lexical: 0, fused: 0 }, {
        noMatch: { reason: 'ng-unscheduled', code: nm.code, title: listed.title, ngSemesters: listed.ngSemesters, related },
      });
    }
    return respond([], { vector: related.length, lexical: 0, fused: 0 }, {
      noMatch: { reason: nm.reason, code: nm.code, title: row?.title ?? null, related },
    });
  }

  if (parsed.kind === 'mask') {
    const maskConstraints = /** @type {Constraints & { ranges: CodeRange[] }} */ (constraints);
    /** @type {DenseHit[] | null} */
    let hits = null;
    const maskDepth = ignoreAllow ? TRACE_FULL_DEPTH
      : collapsing ? Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK * CANDIDATE_MULTIPLIER) : topK;
    oracleLists.maskDepth = maskDepth;
    if (tryDense && denseBackend(env) === 'bundle') {
      const r = await settle(denseRun(env, denseTexts(parsed), trace, (vs) => bundleHits(vs, maskConstraints, maskDepth, trace)));
      if (r.ok) hits = r.value;
      else if (mode === 'vector') return { response: upstream(r.error.source, r.error), degraded: null };
      else degrade(r.error);
    }
    /** @type {string[]} */
    let order;
    try {
      order = hits ? hits.map((h) => h.code) : await withTimeout('D1', D1_TIMEOUT_MS, () => rangeMembers(db, maskConstraints, maskDepth, trace));
    } catch (err) {
      return { response: upstream('d1-fts', err), degraded: null };
    }
    /** @type {Map<string, ResultRow>} */
    let rows;
    try {
      rows = await fetchRows(db, order, trace);
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
    oracleLists.mask = order;
    oracleLists.maskOrder = hits ? 'dense' : 'code';
    const score = new Map((hits ?? []).map((h) => [h.code, h.score]));
    let results = order.flatMap((code) => {
      const row = rows.get(code);
      if (!row || (hits && !localMatchesFilters(row, maskConstraints))) return [];
      return [toModule(row, score.get(code))];
    });
    if (collapsing) {
      const { groupOf } = groups();
      const seen = new Set();
      results = results.filter((r) => { const k = groupKeyOf(groupOf, r.code); return seen.has(k) ? false : (seen.add(k), true); }).slice(0, topK);
      try {
        results = await attachVariants(db, results, variantFilter, trace, semesterSwap(maskConstraints, order));
      } catch (err) {
        return { response: upstream('d1', err), degraded: null };
      }
    } else {
      results = results.slice(0, topK);
    }
    log.counts = { members: order.length, returned: results.length, order: hits ? 'dense' : 'code' };
    return respond(results, { vector: hits ? order.length : 0, lexical: hits ? 0 : order.length, fused: results.length });
  }

  const lookup = [...new Set([...parsed.pins, ...parsed.codes.filter((t) => t.status === 'offered').map((t) => t.code)])];
  const pinning = lookup.length
    ? settle(d1Timed(trace, 'pin', () => db.prepare(lookup.length === 1
      ? `SELECT ${RESULT_COLUMNS} FROM modules WHERE code = ?`
      : `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${lookup.map(() => '?').join(',')})`).bind(...lookup).all()))
    : null;

  /** @type {(Constraints & { ranges: CodeRange[] }) | null} */
  const codeConstraints = parsed.codeList
    ? { ...constraints, ranges: parsed.ranges ? intersectRanges(parsed.codeList, parsed.ranges) : parsed.codeList }
    : null;
  const codeByDense = codeConstraints !== null && denseBackend(env) === 'bundle';
  const codeCons = codeConstraints;
  /** @returns {Promise<string[]>} */
  const codeOrder = () => withTimeout('D1', D1_TIMEOUT_MS, () => rangeMembers(db, /** @type {Constraints & { ranges: CodeRange[] }} */ (codeCons), depth, trace));

  let topCosine = Infinity;
  const tau = noSignalTau(env);
  const dense = tryDense
    ? settle(denseRun(env, denseTexts(parsed), trace, async (vs) => ({
      main: await vectorSearch(env, vs, constraints, filter, depth, trace, parsed.noSignal && tau !== null ? (s) => { topCosine = s; } : undefined),
      code: codeByDense && codeCons ? await bundleHits(vs, codeCons, depth, trace) : null,
    })))
    : null;

  const lexical = mode !== 'vector'
    ? settle(withTimeout('D1', D1_TIMEOUT_MS, () => lexicalSearch(db, parsed.lexical, constraints, depth, trace, parsed.fts)))
    : null;
  const codeEarly = codeCons && (!tryDense || !codeByDense) ? settle(codeOrder()) : null;

  const [pin, vec, lex, early] = await Promise.all([pinning, dense, lexical, codeEarly]);

  const { groupOf } = groups();
  /** @type {ReturnType<typeof rowToModule>[]} */
  const pinned = [];
  /** @type {Set<string>} */
  const groupsShown = new Set();
  if (pin) {
    if (!pin.ok) return { response: upstream('d1', pin.error), degraded: null };
    const res = /** @type {D1Result<ResultRow>} */ (pin.value);
    trace.d1Result(res);
    const byCodeRow = new Map(res.results.map((r) => [r.code, r]));
    for (const code of parsed.pins) {
      const row = byCodeRow.get(code);
      if (!row || !localMatchesFilters(row, intentFilter)) continue;
      if (collapsing) {
        const k = groupKeyOf(groupOf, code);
        if (groupsShown.has(k)) continue;
        groupsShown.add(k);
      }
      pinned.push(toModule(row, 1));
    }
    hiddenPins = lookup.filter((code) => {
      const row = byCodeRow.get(code);
      return row !== undefined && !localMatchesFilters(row, intentFilter);
    });
  }

  /** @type {DenseHit[]} */
  let denseHits = [];
  /** @type {string[] | null} */
  let codeCodes = null;
  if (vec && vec.ok) {
    denseHits = vec.value.main;
    if (vec.value.code) codeCodes = vec.value.code.map((h) => h.code);
  } else if (vec) {
    const err = /** @type {DenseFailure} */ (vec.error);
    if (mode === 'vector') return { response: upstream(err.source, err), degraded: null };
    degrade(err);
  }

  /** @type {string[]} */
  let lexicalCodes = [];
  if (lex && !lex.ok) return { response: upstream('d1-fts', lex.error), degraded: null };
  if (lex) lexicalCodes = lex.value;

  oracleLists.pins = pinned.map((p) => p.code);
  oracleLists.dense = denseHits.map((h) => h.code);
  oracleLists.lexical = lexicalCodes;
  oracleLists.topCosine = Number.isFinite(topCosine) ? topCosine : null;
  oracleLists.degraded = degraded !== null;
  if (vec && vec.ok && tau !== null && parsed.noSignal && topCosine < tau) {
    log.counts = { returned: 0, vector: denseHits.length, lexical: lexicalCodes.length };
    log.topCosine = Math.round(topCosine * 1e4) / 1e4;
    return respond([], { vector: denseHits.length, lexical: lexicalCodes.length, fused: 0 }, { noMatch: { reason: 'no-signal' } });
  }

  if (codeCons && codeCodes === null) {
    const got = early ?? await settle(codeOrder());
    if (!got.ok) return { response: upstream('d1-fts', got.error), degraded: null };
    codeCodes = got.value;
  }
  const vectorCodes = denseHits.map((h) => h.code);
  oracleLists.code = codeCodes;

  /** @type {string[][]} */
  const lists = mode === 'vector' ? [vectorCodes]
    : mode === 'lexical' || degraded ? [lexicalCodes]
      : [vectorCodes, lexicalCodes];
  if (codeCodes) lists.push(codeCodes);
  const pinnedCodes = new Set(pinned.map((p) => p.code));
  const fused = fuse(lists).filter((f) => !pinnedCodes.has(f.code));

  let results = [...pinned];
  const lexicalSet = new Set(lexicalCodes);
  const denseOnly = new Set([...vectorCodes, ...(codeByDense ? codeCodes ?? [] : [])].filter((c) => !lexicalSet.has(c)));
  /** @type {string[]} */
  const stale = [];
  /** @type {string[]} */
  const filteredOut = [];
  let next = 0;
  while (results.length < topK && next < fused.length) {
    const chunk = fused.slice(next, next + topK - results.length);
    next += chunk.length;
    /** @type {Map<string, ResultRow>} */
    let rows;
    try {
      rows = await fetchRows(db, chunk.map((f) => f.code), trace);
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
    for (const { code, score } of chunk) {
      const row = rows.get(code);
      if (!row) { stale.push(code); continue; }
      if (denseOnly.has(code) && !localMatchesFilters(row, constraints)) { filteredOut.push(code); continue; }
      if (collapsing) {
        const k = groupKeyOf(groupOf, code);
        if (groupsShown.has(k)) continue;
        groupsShown.add(k);
      }
      results.push(toModule(row, score));
    }
  }
  if (stale.length) console.warn(`stale vectors not present in D1: ${stale.join(', ')}`);
  if (filteredOut.length) console.warn(`dense rows whose D1 row fails the filters: ${filteredOut.join(', ')}`);
  if (collapsing) {
    try {
      results = await attachVariants(db, results, variantFilter, trace, semesterSwap(constraints, fused.map((f) => f.code)));
    } catch (err) {
      return { response: upstream('d1', err), degraded: null };
    }
  }
  const fusedCount = pinned.length + fused.length - stale.length - filteredOut.length;
  log.counts = {
    vector: vectorCodes.length, lexical: lexicalCodes.length, ...(codeCodes ? { code: codeCodes.length } : {}), fused: fusedCount,
    returned: results.length, stale: stale.length, filtered: filteredOut.length,
  };
  return respond(results, {
    vector: vectorCodes.length, lexical: lexicalCodes.length, ...(codeCodes ? { code: codeCodes.length } : {}), fused: fusedCount,
  });
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Trace} trace
 * @returns {Promise<Response>}
 */
export async function searchRoute(request, env, ctx, trace) {
  const url = new URL(request.url);
  const parsed = parseSearch(url.searchParams);
  const { log } = parsed;

  /**
   * @param {Response} response
   * @param {'hit' | 'miss' | 'bypass'} cache
   */
  const finish = (response, cache) => {
    const total = trace.total();
    response.headers.set('server-timing', trace.header(total));
    const cf = /** @type {{ colo?: string } | undefined} */ (request.cf);
    console.log(JSON.stringify({
      event: 'search', status: response.status, cache, ...log,
      spans: trace.durations(total), d1: trace.d1, colo: cf?.colo ?? null, version: appVersion(env),
    }));
    return response;
  };

  if (crossSite(request.headers)) {
    return finish(new Response(
      JSON.stringify({ error: 'cross_site', message: 'Searches sent from another site\'s page are refused. Search on this site instead.' }, null, 2),
      { status: 403, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } },
    ), 'bypass');
  }

  if (!parsed.query) {
    return finish(parsed.code ? json({ error: parsed.code, message: parsed.error }, 400) : bad(parsed.error), 'bypass');
  }

  const cache = caches.default;
  const cacheKey = canonicalCacheKey(url.origin, parsed.query, versionId(env));
  const tracing = oracleTraceMode(env) !== null;
  const hit = tracing ? undefined : await trace.time('cache', () => cache.match(cacheKey));
  trace.describe('cache', hit ? 'hit' : 'miss');
  if (hit) return finish(withHeaders(hit, { 'cache-control': cacheControl(hit.headers.has(DEGRADED_HEADER)) }), 'hit');

  const limiters = [env.SEARCH_LIMIT, env.SEARCH_LIMIT_MINUTE].filter((b) => b);
  if (limiters.length) {
    const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    const answers = await trace.time('limit', () => Promise.allSettled(limiters.map(async (b) => b.limit({ key }))));
    let allowed = true;
    for (const a of answers) {
      if (a.status === 'fulfilled') {
        if (!a.value.success) allowed = false;
        continue;
      }
      log.limiter = 'error';
      console.error(JSON.stringify({ event: 'limiter_error', message: /** @type {any} */ (a.reason)?.message ?? String(a.reason) }));
    }
    if (!allowed) {
      return finish(new Response(
        JSON.stringify({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' }, null, 2),
        { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'access-control-allow-origin': '*' } },
      ), 'miss');
    }
  }

  const { response, degraded } = await runSearch(parsed.query, env, trace, log);
  if (tracing) {
    const traced = new Response(response.body, response);
    traced.headers.set('cache-control', 'no-store');
    return finish(traced, 'bypass');
  }
  if (response.status === 200) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set('cache-control', cacheControl(degraded !== null));
    if (degraded) cacheable.headers.set(DEGRADED_HEADER, '1');
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return finish(cacheable, 'miss');
  }
  return finish(response, 'miss');
}
