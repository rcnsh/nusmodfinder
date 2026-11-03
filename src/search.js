// @ts-check
// GET /search: parameter validation, the canonical cache key, the rate
// limiter, both retrievers (run concurrently), rank fusion, hydration, and the
// keyword-only fallback when the dense half fails. Every response carries
// Server-Timing, and each request writes one structured log line.
import dataVersion from './data-version.json';
import { DEFAULT_MODEL } from './embedding.js';
import { appVersion, bad, json, upstream, withHeaders } from './http.js';
import { lexicalSearch } from './lexical.js';
import { MODULE_CODE_RE, RESULT_COLUMNS, d1Timed, readSession, rowToModule } from './modules.js';
import {
  AI_TIMEOUT_MS, D1_TIMEOUT_MS, TimeoutError, VECTORIZE_TIMEOUT_MS, denseCircuit, withTimeout,
} from './upstream.js';

/**
 * @typedef {import('./modules.js').ResultRow} ResultRow
 * @typedef {import('./timing.js').Trace} Trace
 * @typedef {{ sem?: number, level?: number, credits?: number, faculty?: string, ng?: boolean }} FilterEcho
 * @typedef {Record<string, string | number | boolean>} VectorFilter
 * @typedef {'hybrid' | 'vector' | 'lexical'} Mode
 * @typedef {{ q: string, echo: FilterEcho, filter: VectorFilter, mode: Mode, topK: number }} SearchQuery
 * @typedef {{ source: string, reason: 'error' | 'timeout' | 'circuit-open' }} Degraded
 */

const MAX_QUERY_CHARS = 200;
// Each retriever's depth is capped at 50. That was Vectorize's ceiling with
// metadata returned; the metadata is no longer requested (so the ceiling is
// 100), but a deeper list would change rankings, which Phase 1 must not.
const MAX_TOPK = 50;
const DEFAULT_TOPK = 20;      // R3: at most 20 results
// The structured log carries the query text cut to this length. Search text is
// public and contains no identifiers; headers and IPs are never logged.
const LOGGED_QUERY_CHARS = 100;

// Cache lifetimes. A degraded (keyword-only) answer is cached briefly so a
// recovered upstream is used again within a minute.
const CACHE_TTL_S = 3600;
const DEGRADED_CACHE_TTL_S = 60;

// Bumped by ingest (src/data-version.json), so a deploy after an ingest gets
// fresh cache keys without a D1 read on every request.
export const DATA_VERSION = String(dataVersion.version);

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
 * The query text every later stage sees, and the cache key holds: trimmed,
 * runs of whitespace collapsed to one space, ASCII letters lower-cased. Only
 * ASCII: full Unicode lower-casing maps the Kelvin sign (U+212A) to `k`, which
 * would make the pin match codes that the raw query never matched. Neither retriever
 * can tell the difference: the FTS tokeniser lower-cases and splits on
 * non-word characters, the pin upper-cases, and bge-small-en-v1.5 is an
 * uncased model (its BertTokenizer has do_lower_case: true and splits on
 * whitespace). The fake embedder lower-cases too; a test pins that.
 * @param {string} trimmed
 */
const canonicalQuery = (trimmed) => trimmed.replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * Validates every parameter /search reads. Unknown parameters are ignored.
 * @param {URLSearchParams} params
 * @returns {{ log: Record<string, unknown>, error: string, query?: undefined } | { log: Record<string, unknown>, query: SearchQuery, error?: undefined }}
 */
export function parseSearch(params) {
  const raw = params.get('q');
  const trimmed = raw?.trim() ?? null;
  const q = trimmed === null ? null : canonicalQuery(trimmed);
  /** @type {Record<string, unknown>} */
  const log = { q: q?.slice(0, LOGGED_QUERY_CHARS) ?? null, qLength: q?.length ?? null, degraded: null };

  // R6: missing, empty or over-long queries are 400s that name the problem.
  if (trimmed === null || q === null) return { log, error: 'Missing required query parameter "q".' };
  if (trimmed === '') return { log, error: 'Query parameter "q" was empty.' };
  if (trimmed.length > MAX_QUERY_CHARS) {
    return { log, error: `Query parameter "q" was ${trimmed.length} characters; the maximum is ${MAX_QUERY_CHARS}.` };
  }

  const { echo, filter, errors } = parseFilters(params);
  // faculty is free text: log only whether it was set, never its value.
  log.filters = { ...echo, ...(echo.faculty !== undefined ? { faculty: true } : {}) };
  if (errors.length) return { log, error: errors.join('; ') };

  // Retrieval mode. Defaults to the hybrid that ships; `vector` and `lexical`
  // exist so the evaluation harness can measure each half on its own, which is
  // what the gate is actually about.
  const mode = params.get('mode') ?? 'hybrid';
  if (mode !== 'hybrid' && mode !== 'vector' && mode !== 'lexical') {
    log.mode = 'invalid';
    return { log, error: `Unknown mode "${mode}"; expected hybrid, vector or lexical.` };
  }
  log.mode = mode;

  // R6/L-limits: topK above the ceiling is clamped, not rejected. An empty
  // topK= is the default (B8), not Number('') = 0 clamped to 1.
  const rawTopK = params.get('topK')?.trim() ?? '';
  const requestedTopK = rawTopK === '' ? DEFAULT_TOPK : Number(rawTopK);
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.trunc(requestedTopK), 1), MAX_TOPK)
    : DEFAULT_TOPK;
  log.topK = topK;

  return { log, query: { q, echo, filter, mode, topK } };
}

/**
 * The cache key for a validated search (B7): only the parameters that change
 * the answer, in their parsed form, sorted, with defaults omitted, plus the
 * data version. Spelling, order and junk parameters all map to one entry.
 * @param {string} origin
 * @param {SearchQuery} query
 */
export function canonicalCacheKey(origin, { q, echo, mode, topK }) {
  /** @type {[string, string][]} */
  const pairs = [['q', q], ['v', DATA_VERSION]];
  if (echo.sem !== undefined) pairs.push(['sem', String(echo.sem)]);
  if (echo.level !== undefined) pairs.push(['level', String(echo.level)]);
  if (echo.credits !== undefined) pairs.push(['credits', String(echo.credits)]);
  if (echo.faculty !== undefined) pairs.push(['faculty', echo.faculty]);
  if (echo.ng === true) pairs.push(['ng', '1']);
  if (mode !== 'hybrid') pairs.push(['mode', mode]);
  if (topK !== DEFAULT_TOPK) pairs.push(['topK', String(topK)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return new Request(`${origin}/search?${new URLSearchParams(pairs)}`, { method: 'GET' });
}

/**
 * The cache key a /search URL maps to, or null if its parameters are invalid
 * (invalid requests are never cached).
 * @param {string | URL} url
 */
export function searchCacheKey(url) {
  const u = new URL(url);
  const { query } = parseSearch(u.searchParams);
  return query ? canonicalCacheKey(u.origin, query) : null;
}

/**
 * @param {ResultRow} row
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
 * Turns a promise into one that always fulfils, so Promise.all waits for
 * every branch and the caller decides which failure wins.
 * @template T
 * @param {Promise<T>} p
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error: any }>}
 */
const settle = (p) => p.then((value) => ({ ok: /** @type {const} */ (true), value }), (error) => ({ ok: /** @type {const} */ (false), error }));

/** A dense-half failure, attributed to the binding that failed. */
class DenseFailure extends Error {
  /** @param {'workers-ai' | 'vectorize'} source @param {any} cause */
  constructor(source, cause) {
    super(cause?.message ?? String(cause), { cause });
    this.source = source;
    this.timedOut = cause instanceof TimeoutError;
  }
}

/**
 * Embed the query, then ask Vectorize. Embedding and vector search are
 * attributed separately: guessing the source from the message text
 * mislabelled Workers AI failures as Vectorize.
 * @param {Env} env
 * @param {string} q
 * @param {VectorFilter} filter
 * @param {number} depth
 * @param {Trace} trace
 * @returns {Promise<string[]>}
 */
async function denseSearch(env, q, filter, depth, trace) {
  /** @type {number[] | undefined} */
  let values;
  try {
    const embedded = /** @type {{ data?: number[][] }} */ (await trace.time('embed', () =>
      withTimeout('Workers AI', AI_TIMEOUT_MS, (signal) =>
        env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: [q] }, { signal }))));
    values = embedded?.data?.[0];
    if (!Array.isArray(values)) throw new Error('Workers AI returned no embedding for the query.');
  } catch (err) {
    throw new DenseFailure('workers-ai', err);
  }
  const vector = values;
  try {
    // Only ids are read, so no metadata or values are requested.
    const result = await trace.time('vector', () => withTimeout('Vectorize', VECTORIZE_TIMEOUT_MS, () =>
      env.VECTORIZE.query(vector, { topK: depth, ...(Object.keys(filter).length ? { filter } : {}) })));
    return (result?.matches ?? []).map((m) => m.id);
  } catch (err) {
    throw new DenseFailure('vectorize', err);
  }
}

/**
 * @param {D1DatabaseSession} db
 * @param {string[]} codes
 * @param {Trace} trace
 * @returns {Promise<Map<string, ResultRow>>}
 */
async function fetchRows(db, codes, trace) {
  if (codes.length === 0) return new Map();
  const placeholders = codes.map(() => '?').join(',');
  const res = /** @type {D1Result<ResultRow>} */ (await d1Timed(trace, 'hydrate', () => db.prepare(
    `SELECT ${RESULT_COLUMNS} FROM modules WHERE code IN (${placeholders})`,
  ).bind(...codes).all()));
  trace.d1Result(res);
  return new Map(res.results.map((r) => [r.code, r]));
}

/**
 * Runs a validated search. Pin lookup, lexical retrieval and embed→Vectorize
 * start together (B4); hydration follows once all three have settled.
 * @param {SearchQuery} query
 * @param {Env} env
 * @param {Trace} trace
 * @param {Record<string, unknown>} log Filled with what the request turned out to be.
 * @returns {Promise<{ response: Response, degraded: Degraded | null }>}
 */
async function runSearch({ q, echo, filter, mode, topK }, env, trace, log) {
  const db = readSession(env);
  const depth = Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK);
  // Spans in pipeline order, whichever branch finishes first.
  trace.reserve('pin', 'embed', 'vector', 'fts', 'hydrate');

  // R5: an exact module code jumps to the front, if it exists and the filters allow it.
  const upper = q.toUpperCase();
  const pinning = MODULE_CODE_RE.test(upper)
    ? settle(d1Timed(trace, 'pin', () => db.prepare(`SELECT ${RESULT_COLUMNS} FROM modules WHERE code = ?`).bind(upper).all()))
    : null;

  // Dense retrieval. In hybrid mode a failure degrades to keyword-only results
  // (B6); in vector mode it fails loudly, because the eval measures that half.
  // A dense half that keeps failing is skipped outright for a while, so it does
  // not add its timeout to every search.
  /** @type {Degraded | null} */
  let degraded = null;
  let dense = null;
  if (mode === 'vector' || (mode === 'hybrid' && !denseCircuit.open())) {
    dense = settle(denseSearch(env, q, filter, depth, trace).then(
      (codes) => { denseCircuit.success(); return codes; },
      (err) => { denseCircuit.failure(err.source); throw err; },
    ));
  } else if (mode === 'hybrid') {
    degraded = { source: denseCircuit.lastSource ?? 'workers-ai', reason: 'circuit-open' };
  }

  // Lexical retrieval over the same corpus, fused by rank.
  const lexical = mode !== 'vector'
    ? settle(withTimeout('D1', D1_TIMEOUT_MS, () => lexicalSearch(db, q, echo, depth, trace)))
    : null;

  const [pin, vec, lex] = await Promise.all([pinning, dense, lexical]);

  /** @type {ReturnType<typeof rowToModule> | null} */
  let pinned = null;
  if (pin) {
    if (!pin.ok) return { response: upstream('d1', pin.error), degraded: null };
    const res = /** @type {D1Result<ResultRow>} */ (pin.value);
    trace.d1Result(res);
    const row = res.results[0] ?? null;
    if (row && localMatchesFilters(row, echo)) pinned = rowToModule(row, 1);
  }

  /** @type {string[]} */
  let vectorCodes = [];
  if (vec && vec.ok) vectorCodes = vec.value;
  else if (vec) {
    const err = /** @type {DenseFailure} */ (vec.error);
    if (mode === 'vector') return { response: upstream(err.source, err), degraded: null };
    degraded = { source: err.source, reason: err.timedOut ? 'timeout' : 'error' };
    log.degradedMessage = err.message;
  }

  /** @type {string[]} */
  let lexicalCodes = [];
  if (lex && !lex.ok) return { response: upstream('d1-fts', lex.error), degraded: null };
  if (lex) lexicalCodes = lex.value;

  if (degraded) {
    log.degraded = degraded;
    trace.describe('degraded', `${degraded.source}-${degraded.reason}`);
  }

  const lists = mode === 'vector' ? [vectorCodes]
    : mode === 'lexical' || degraded ? [lexicalCodes]
      : [vectorCodes, lexicalCodes];
  const fused = fuse(lists).filter((f) => f.code !== pinned?.code);

  // Hydrate only as many fused candidates as the response shows (B8). A
  // candidate missing from D1 means a stale index: drop it and hydrate the
  // next one, so the page is the same as hydrating every candidate would give.
  const results = pinned ? [pinned] : [];
  /** @type {string[]} */
  const stale = [];
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
      results.push(rowToModule(row, score));
    }
  }
  if (stale.length) console.warn(`stale vectors not present in D1: ${stale.join(', ')}`);
  // Candidates after fusion that exist in D1, as far as hydration saw.
  const fusedCount = (pinned ? 1 : 0) + fused.length - stale.length;
  log.counts = {
    vector: vectorCodes.length, lexical: lexicalCodes.length, fused: fusedCount,
    returned: results.length, stale: stale.length,
  };

  return {
    degraded,
    response: json({
      query: q,
      filters: echo,
      count: results.length,
      mode,
      ...(degraded ? { degraded } : {}),
      retrieval: { vector: vectorCodes.length, lexical: lexicalCodes.length, fused: fusedCount },
      results,
    }),
  };
}

/**
 * GET /search, from validation to the logged response.
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Trace} trace Started at fetch entry, so `total` covers everything.
 * @returns {Promise<Response>}
 */
export async function searchRoute(request, env, ctx, trace) {
  const url = new URL(request.url);
  const parsed = parseSearch(url.searchParams);
  const { log } = parsed;

  /**
   * Sets Server-Timing and writes the log line. The spans are taken once, so
   * the header and the log agree.
   * @param {Response} response Must have mutable headers.
   * @param {'hit' | 'miss' | 'bypass'} cache `bypass`: invalid, never looked up.
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

  // Invalid requests are answered before the cache or any binding is touched.
  if (!parsed.query) return finish(bad(parsed.error), 'bypass');

  // Identical searches are common — a shared link, a reload, a load test,
  // the evaluation harness running the same fixture repeatedly. Serving
  // those from cache costs zero D1 rows, zero Vectorize queries and zero
  // Workers AI calls. The key is canonical (B7), and needs no D1 read.
  const cache = caches.default;
  const cacheKey = canonicalCacheKey(url.origin, parsed.query);
  const hit = await trace.time('cache', () => cache.match(cacheKey));
  trace.describe('cache', hit ? 'hit' : 'miss');
  // The stored copy has no Server-Timing; this request's spans are set fresh.
  if (hit) return finish(withHeaders(hit, {}), 'hit');

  // Guardrail: /search is the only route that spends metered upstream quota.
  // It fails open: a broken limiter must not take search down with it.
  if (env.SEARCH_LIMIT) {
    const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
    /** @type {boolean} */
    let allowed = true;
    try {
      ({ success: allowed } = await trace.time('limit', () => env.SEARCH_LIMIT.limit({ key })));
    } catch (err) {
      log.limiter = 'error';
      console.error(JSON.stringify({ event: 'limiter_error', message: /** @type {any} */ (err)?.message ?? String(err) }));
    }
    if (!allowed) {
      return finish(new Response(
        JSON.stringify({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' }, null, 2),
        { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'access-control-allow-origin': '*' } },
      ), 'miss');
    }
  }

  const { response, degraded } = await runSearch(parsed.query, env, trace, log);
  // Only successful responses are cached; a 400 or a 502 must stay live.
  if (response.status === 200) {
    const cacheable = new Response(response.body, response);
    cacheable.headers.set('cache-control', `public, max-age=${degraded ? DEGRADED_CACHE_TTL_S : CACHE_TTL_S}`);
    // Cloned before Server-Timing is set, so the cache never stores spans.
    ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
    return finish(cacheable, 'miss');
  }
  return finish(response, 'miss');
}
