// @ts-check
// GET /search: the cache, rate limiter, filter parsing, both retrievers, rank
// fusion and hydration. Every response carries Server-Timing, and each request
// writes one structured log line.
import { DEFAULT_MODEL } from './embedding.js';
import { appVersion, bad, json, upstream, withHeaders } from './http.js';
import { lexicalSearch } from './lexical.js';
import { MODULE_CODE_RE, SELECT_COLUMNS, rowToModule } from './modules.js';

/**
 * @typedef {import('./modules.js').ModuleRow} ModuleRow
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {{ sem?: number, level?: number, credits?: number, faculty?: string, ng?: boolean }} FilterEcho
 * @typedef {Record<string, string | number | boolean>} VectorFilter
 */

const MAX_QUERY_CHARS = 200;
const MAX_TOPK = 50;          // Vectorize caps topK at 50 when metadata is returned
const DEFAULT_TOPK = 20;      // R3: at most 20 results
// The structured log carries the query text cut to this length. Search text is
// public and contains no identifiers; headers and IPs are never logged.
const LOGGED_QUERY_CHARS = 100;

// Reciprocal-rank fusion constant. 60 is the value from the original Cormack et
// al. RRF paper and the usual default; it damps the top of each list so neither
// retriever can dominate on rank alone.
const RRF_K = 60;
// Each retriever contributes a deeper list than we return, so a document ranked
// mid-list by one engine and top by the other can still surface.
const CANDIDATE_MULTIPLIER = 3;

// Reads sem/level/credits/faculty off the query string. Returns the echoed
// filters plus the Vectorize metadata filter they translate to (R4).
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

  const level = params.get('level');
  if (level !== null && level !== '') {
    const n = Number(level);
    if (!Number.isInteger(n) || n < 1 || n > 8) errors.push('level must be an integer from 1 to 8');
    else { echo.level = n; filter.level = n; }
  }

  const credits = params.get('credits');
  if (credits !== null && credits !== '') {
    const n = Number(credits);
    if (!Number.isFinite(n) || n < 0) errors.push('credits must be a non-negative number');
    else { echo.credits = n; filter.credits = n; }
  }

  const faculty = params.get('faculty');
  if (faculty !== null && faculty.trim() !== '') {
    echo.faculty = faculty.trim();
    filter.faculty = faculty.trim();
  }

  // Exchange-student availability. Only `true` narrows: ng=false would mean
  // "show me courses I am NOT allowed to take", which nobody wants.
  const ng = params.get('ng');
  if (ng !== null && ng !== '' && ng !== 'false' && ng !== '0') {
    echo.ng = true;
    filter.ng = true;
  }

  return { echo, filter, errors };
}

/**
 * @param {ModuleRow} row
 * @param {FilterEcho} echo
 */
function localMatchesFilters(row, echo) {
  if (echo.ng === true && row.ng !== 1) return false;
  if (echo.sem !== undefined && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.level !== undefined && row.level !== echo.level) return false;
  if (echo.credits !== undefined && row.credits !== echo.credits) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  return true;
}

// Reciprocal-rank fusion: each list contributes 1/(k + rank) to a document's
// score. Rank-based, so the vector engine's cosine scores and FTS5's bm25
// values never have to be made commensurable.
/** @param {string[][]} lists */
function fuse(lists) {
  /** @type {Map<string, number>} */
  const scores = new Map();
  for (const list of lists) {
    list.forEach((code, i) => {
      scores.set(code, (scores.get(code) ?? 0) + 1 / (RRF_K + i + 1));
    });
  }
  // RRF produces exact ties constantly (any two documents at the same rank in
  // exactly one list each). Breaking them alphabetically systematically favours
  // early-alphabet codes, which correlates with whatever a fixture happens to
  // contain. A stable hash of the id is arbitrary but unbiased.
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
 * @param {Env} env
 * @param {string[]} codes
 * @param {Trace} trace
 * @returns {Promise<Map<string, ModuleRow>>}
 */
async function fetchRows(env, codes, trace) {
  if (codes.length === 0) return new Map();
  const placeholders = codes.map(() => '?').join(',');
  const res = /** @type {D1Result<ModuleRow>} */ (await trace.time('hydrate', () => env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM modules WHERE code IN (${placeholders})`,
  ).bind(...codes).all()));
  trace.d1Result(res);
  return new Map(res.results.map((r) => [r.code, r]));
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {Trace} trace
 * @param {Record<string, unknown>} log Filled with what the request turned out to be.
 */
async function handleSearch(request, env, trace, log) {
  const params = new URL(request.url).searchParams;
  const raw = params.get('q');

  // R6: missing, empty or over-long queries are 400s that name the problem.
  if (raw === null) return bad('Missing required query parameter "q".');
  const q = raw.trim();
  if (q === '') return bad('Query parameter "q" was empty.');
  if (q.length > MAX_QUERY_CHARS) {
    return bad(`Query parameter "q" was ${q.length} characters; the maximum is ${MAX_QUERY_CHARS}.`);
  }

  const { echo, filter, errors } = parseFilters(params);
  // faculty is free text: log only whether it was set, never its value.
  log.filters = { ...echo, ...(echo.faculty !== undefined ? { faculty: true } : {}) };
  if (errors.length) return bad(errors.join('; '));

  // Retrieval mode. Defaults to the hybrid that ships; `vector` and `lexical`
  // exist so the evaluation harness can measure each half on its own, which is
  // what the gate is actually about.
  const mode = params.get('mode') ?? 'hybrid';
  if (!['hybrid', 'vector', 'lexical'].includes(mode)) {
    log.mode = 'invalid';
    return bad(`Unknown mode "${mode}"; expected hybrid, vector or lexical.`);
  }
  log.mode = mode;

  const requestedTopK = Number(params.get('topK') ?? DEFAULT_TOPK);
  // R6/L-limits: topK above the Vectorize ceiling is clamped, not rejected.
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.trunc(requestedTopK), 1), MAX_TOPK)
    : DEFAULT_TOPK;
  log.topK = topK;

  // R5: an exact module code jumps to the front, if it exists and the filters allow it.
  /** @type {ReturnType<typeof rowToModule> | null} */
  let pinned = null;
  const upper = q.toUpperCase();
  if (MODULE_CODE_RE.test(upper)) {
    try {
      // .all() rather than .first() only to get the D1 meta for the log; code is
      // the primary key, so the row is the same.
      const res = /** @type {D1Result<ModuleRow>} */ (await trace.time('pin', () =>
        env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM modules WHERE code = ?`).bind(upper).all()));
      trace.d1Result(res);
      const row = res.results[0] ?? null;
      if (row && localMatchesFilters(row, echo)) pinned = rowToModule(row, 1);
    } catch (err) {
      return upstream('d1', err);
    }
  }

  const depth = Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK);

  // Dense retrieval. Failures here are fatal: returning only lexical hits and
  // calling it a search would hide a broken embedding path behind plausible
  // results (R7 — never an empty or quietly degraded 200).
  /** @type {string[]} */
  let vectorCodes = [];
  if (mode !== 'lexical') {
    // Embedding and vector search are attributed separately: guessing the
    // source from the message text mislabelled Workers AI failures as Vectorize.
    let values;
    try {
      const embedded = /** @type {{ data?: number[][] }} */ (await trace.time('embed', () => env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: [q] })));
      values = embedded?.data?.[0];
      if (!Array.isArray(values)) throw new Error('Workers AI returned no embedding for the query.');
    } catch (err) {
      return upstream('workers-ai', err);
    }
    try {
      const result = await trace.time('vector', () => env.VECTORIZE.query(values, {
        topK: depth,
        returnMetadata: 'indexed',
        ...(Object.keys(filter).length ? { filter } : {}),
      }));
      vectorCodes = (result?.matches ?? []).map((m) => m.id);
    } catch (err) {
      return upstream('vectorize', err);
    }
  }

  // Lexical retrieval over the same corpus, fused by rank.
  /** @type {string[]} */
  let lexicalCodes = [];
  if (mode !== 'vector') {
    try {
      lexicalCodes = await lexicalSearch(env.DB, q, echo, depth, trace);
    } catch (err) {
      return upstream('d1-fts', err);
    }
  }

  const lists = mode === 'vector' ? [vectorCodes] : mode === 'lexical' ? [lexicalCodes] : [vectorCodes, lexicalCodes];
  const fused = fuse(lists).filter((f) => f.code !== pinned?.code);

  /** @type {Map<string, ModuleRow>} */
  let rows;
  try {
    rows = await fetchRows(env, fused.map((f) => f.code), trace);
  } catch (err) {
    return upstream('d1', err);
  }

  const results = pinned ? [pinned] : [];
  const stale = [];
  for (const { code, score } of fused) {
    const row = rows.get(code);
    // A hit whose module is gone from D1 means a stale index. Drop it and keep
    // serving the rest rather than emitting a half-populated result.
    if (!row) { stale.push(code); continue; }
    results.push(rowToModule(row, score));
  }
  if (stale.length) console.warn(`stale vectors not present in D1: ${stale.join(', ')}`);
  log.counts = {
    vector: vectorCodes.length, lexical: lexicalCodes.length, fused: results.length,
    returned: Math.min(results.length, topK), stale: stale.length,
  };

  return json({
    query: q,
    filters: echo,
    count: Math.min(results.length, topK),
    mode,
    retrieval: { vector: vectorCodes.length, lexical: lexicalCodes.length, fused: results.length },
    results: results.slice(0, topK),
  });
}

/**
 * GET /search, from cache lookup to the logged response.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Trace} trace Started at fetch entry, so `total` covers everything.
 * @returns {Promise<Response>}
 */
export async function searchRoute(request, env, ctx, trace) {
  const url = new URL(request.url);
  const q = url.searchParams.get('q')?.trim() ?? null;
  /** @type {Record<string, unknown>} */
  const log = { q: q?.slice(0, LOGGED_QUERY_CHARS) ?? null, qLength: q?.length ?? null };

  /**
   * Sets Server-Timing and writes the log line. The spans are taken once, so
   * the header and the log agree.
   * @param {Response} response Must have mutable headers.
   * @param {'hit' | 'miss'} cache
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

  // Identical searches are common — a shared link, a reload, a load test,
  // the evaluation harness running the same fixture repeatedly. Serving
  // those from cache costs zero D1 rows, zero Vectorize queries and zero
  // Workers AI calls. Keyed on the full URL, so filters vary the entry.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: 'GET' });
  const hit = await trace.time('cache', () => cache.match(cacheKey));
  trace.describe('cache', hit ? 'hit' : 'miss');
  // The stored copy has no Server-Timing; this request's spans are set fresh.
  if (hit) return finish(withHeaders(hit, {}), 'hit');

  // Guardrail: /search is the only route that spends metered upstream quota.
  if (env.SEARCH_LIMIT) {
    const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    const { success } = await trace.time('limit', () => env.SEARCH_LIMIT.limit({ key }));
    if (!success) {
      return finish(new Response(
        JSON.stringify({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' }, null, 2),
        { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'access-control-allow-origin': '*' } },
      ), 'miss');
    }
  }
  const response = await handleSearch(request, env, trace, log);
  // Only successful responses are cached; a 400 or a 502 must stay live.
  if (response.status === 200) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set('cache-control', 'public, max-age=3600');
    // Cloned before Server-Timing is set, so the cache never stores spans.
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return finish(cacheable, 'miss');
  }
  return finish(response, 'miss');
}
