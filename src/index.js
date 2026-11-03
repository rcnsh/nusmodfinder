import page from './page.html';

// Overridable so the embedding model can be swapped without a code change, and
// so the upstream-failure path (R7) can be exercised against a bogus model id.
const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';
const MAX_QUERY_CHARS = 200;
const MAX_TOPK = 50;          // Vectorize caps topK at 50 when metadata is returned
const DEFAULT_TOPK = 20;      // R3: at most 20 results
const MODULE_CODE_RE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;

// Reciprocal-rank fusion constant. 60 is the value from the original Cormack et
// al. RRF paper and the usual default; it damps the top of each list so neither
// retriever can dominate on rank alone.
const RRF_K = 60;
// Provenance for the Non-Graduating course list, surfaced in /facets so the UI
// can say how old it is. Bump this when data/ng-courses-*.json is regenerated.
const NG_LIST_UPDATED = '01 Sep 2026';
// Each retriever contributes a deeper list than we return, so a document ranked
// mid-list by one engine and top by the other can still surface.
const CANDIDATE_MULTIPLIER = 3;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });

const bad = (message) => json({ error: 'bad_request', message }, 400);
const upstream = (source, err) =>
  json({ error: 'upstream_failure', source, message: err?.message ?? String(err) }, 502);

const SELECT_COLUMNS =
  'code, title, description, credits, department, faculty, level, semesters, workload, prerequisite, preclusion, acad_year, ng, ng_semesters';

function rowToModule(row, score) {
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

// Reads sem/level/credits/faculty off the query string. Returns the echoed
// filters plus the Vectorize metadata filter they translate to (R4).
function parseFilters(params) {
  const echo = {};
  const filter = {};
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

function localMatchesFilters(row, echo) {
  if (echo.ng === true && row.ng !== 1) return false;
  if (echo.sem !== undefined && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.level !== undefined && row.level !== echo.level) return false;
  if (echo.credits !== undefined && row.credits !== echo.credits) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  return true;
}

// Stopwords are dropped before the FTS5 query is built. Without this, a natural
// question like "how do i start my own company" matches every "Design Your Own
// Course" record on the word "own" and buries the real answers. This is the same
// list the offline BM25 baseline uses, so neither retriever gets an easier query.
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);

// FTS5 MATCH is its own query language: unescaped user text is a syntax error
// waiting to happen. Reduce the query to bare tokens, quote each one, and OR
// them together — recall comes from the OR, ranking from bm25().
function ftsTokens(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  // If the query is nothing but stopwords, keep them rather than matching nothing.
  const tokens = all.filter((t) => !STOPWORDS.has(t));
  return tokens.length ? tokens : all;
}

// FTS5 MATCH is its own query language: unescaped user text is a syntax error
// waiting to happen. Reduce the query to bare tokens, quote each one, and OR
// them together — recall comes from the OR, ranking from the rank column.
function ftsMatchExpression(tokens) {
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(' OR ');
}

// Lexical half of the hybrid retriever. Filters are applied in SQL so the two
// halves see the same candidate universe (R4 holds on both paths).
async function lexicalSearch(env, query, echo, limit) {
  const match = ftsMatchExpression(ftsTokens(query));
  if (!match) return [];
  return runFts(env, match, echo, limit);
}

async function runFts(env, match, echo, limit) {
  const where = ['modules_fts MATCH ?'];
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

  const { results } = await env.DB.prepare(sql).bind(...binds, limit * 4).all();

  return results
    .filter((r) => echo.sem === undefined || JSON.parse(r.semesters ?? '[]').includes(echo.sem))
    .slice(0, limit)
    .map((r) => r.code);
}

// Reciprocal-rank fusion: each list contributes 1/(k + rank) to a document's
// score. Rank-based, so the vector engine's cosine scores and FTS5's bm25
// values never have to be made commensurable.
function fuse(lists) {
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
  const tiebreak = (code) => {
    let h = 0;
    for (let i = 0; i < code.length; i++) h = (Math.imul(h, 31) + code.charCodeAt(i)) | 0;
    return h;
  };
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || tiebreak(a[0]) - tiebreak(b[0]) || a[0].localeCompare(b[0]))
    .map(([code, score]) => ({ code, score }));
}

async function fetchRows(env, codes) {
  if (codes.length === 0) return new Map();
  const placeholders = codes.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS} FROM modules WHERE code IN (${placeholders})`,
  ).bind(...codes).all();
  return new Map(results.map((r) => [r.code, r]));
}

async function handleSearch(request, env) {
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
  if (errors.length) return bad(errors.join('; '));

  // Retrieval mode. Defaults to the hybrid that ships; `vector` and `lexical`
  // exist so the evaluation harness can measure each half on its own, which is
  // what the gate is actually about.
  const mode = params.get('mode') ?? 'hybrid';
  if (!['hybrid', 'vector', 'lexical'].includes(mode)) {
    return bad(`Unknown mode "${mode}"; expected hybrid, vector or lexical.`);
  }

  const requestedTopK = Number(params.get('topK') ?? DEFAULT_TOPK);
  // R6/L-limits: topK above the Vectorize ceiling is clamped, not rejected.
  const topK = Number.isFinite(requestedTopK)
    ? Math.min(Math.max(Math.trunc(requestedTopK), 1), MAX_TOPK)
    : DEFAULT_TOPK;

  // R5: an exact module code jumps to the front, if it exists and the filters allow it.
  let pinned = null;
  const upper = q.toUpperCase();
  if (MODULE_CODE_RE.test(upper)) {
    try {
      const row = await env.DB.prepare(`SELECT ${SELECT_COLUMNS} FROM modules WHERE code = ?`).bind(upper).first();
      if (row && localMatchesFilters(row, echo)) pinned = rowToModule(row, 1);
    } catch (err) {
      return upstream('d1', err);
    }
  }

  const depth = Math.min(topK * CANDIDATE_MULTIPLIER, MAX_TOPK);

  // Dense retrieval. Failures here are fatal: returning only lexical hits and
  // calling it a search would hide a broken embedding path behind plausible
  // results (R7 — never an empty or quietly degraded 200).
  let vectorCodes = [];
  if (mode !== 'lexical') {
    // Embedding and vector search are attributed separately: guessing the
    // source from the message text mislabelled Workers AI failures as Vectorize.
    let values;
    try {
      const embedded = await env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: [q] });
      values = embedded?.data?.[0];
      if (!Array.isArray(values)) throw new Error('Workers AI returned no embedding for the query.');
    } catch (err) {
      return upstream('workers-ai', err);
    }
    try {
      const result = await env.VECTORIZE.query(values, {
        topK: depth,
        returnMetadata: 'indexed',
        ...(Object.keys(filter).length ? { filter } : {}),
      });
      vectorCodes = (result?.matches ?? []).map((m) => m.id);
    } catch (err) {
      return upstream('vectorize', err);
    }
  }

  // Lexical retrieval over the same corpus, fused by rank.
  let lexicalCodes = [];
  if (mode !== 'vector') {
    try {
      lexicalCodes = await lexicalSearch(env, q, echo, depth);
    } catch (err) {
      return upstream('d1-fts', err);
    }
  }

  const lists = mode === 'vector' ? [vectorCodes] : mode === 'lexical' ? [lexicalCodes] : [vectorCodes, lexicalCodes];
  const fused = fuse(lists).filter((f) => f.code !== pinned?.code);

  let rows;
  try {
    rows = await fetchRows(env, fused.map((f) => f.code));
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

  return json({
    query: q,
    filters: echo,
    count: Math.min(results.length, topK),
    mode,
    retrieval: { vector: vectorCodes.length, lexical: lexicalCodes.length, fused: results.length },
    results: results.slice(0, topK),
  });
}

// The faculty filter is only usable if the caller knows the exact strings D1
// stores, so the page fetches them from here rather than hardcoding 26 names.
async function handleFacets(env) {
  try {
    // One row, not three full-table aggregates. The live computation below cost
    // 9,842 D1 rows read on EVERY page load (1,364 + 7,303 + 1,175) to produce
    // about 35 rows of output — the single largest source of row reads in the
    // app. It is now rebuilt at ingest time via POST /admin/facets.
    const cached = await env.DB.prepare('SELECT value FROM meta WHERE key = ?').bind('facets').first();
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
    return json(await computeFacets(env), 200);
  } catch (err) {
    return upstream('d1', err);
  }
}

async function computeFacets(env) {
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

// Guarded: rebuilds the precomputed facet row. Called by the ingest script once
// the corpus has finished loading.
async function handleFacetsRebuild(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  try {
    const facets = await computeFacets(env);
    await env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES ('facets', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).bind(JSON.stringify(facets), new Date().toISOString()).run();
    return json({ rebuilt: 'facets', faculties: facets.faculties.length, levels: facets.levels.length, ng: facets.ng.count });
  } catch (err) {
    return upstream('d1', err);
  }
}

async function handleModule(env, code) {
  const upper = decodeURIComponent(code).toUpperCase();
  if (!MODULE_CODE_RE.test(upper)) return bad(`"${upper}" is not a module code.`);
  let row;
  try {
    row = await env.DB.prepare('SELECT * FROM modules WHERE code = ?').bind(upper).first();
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

// --- ingest ----------------------------------------------------------------
// Embedding runs here rather than in the ingest script so no Cloudflare API
// token has to exist on disk; the script streams batches in over HTTP and the
// Worker uses its own AI, Vectorize and D1 bindings. The route does not exist
// unless an INGEST_SECRET is bound, so a deployed Worker has no admin surface.
function ingestGuard(request, env) {
  if (!env.INGEST_SECRET) return json({ error: 'not_found' }, 404);
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.INGEST_SECRET}`) return json({ error: 'unauthorized' }, 401);
  return null;
}

async function handleHashes(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  const { results } = await env.DB.prepare('SELECT code, text_hash FROM modules').all();
  return json(Object.fromEntries(results.map((r) => [r.code, r.text_hash])));
}

async function handleIngest(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;

  const body = await request.json();
  const batch = body?.modules;
  if (!Array.isArray(batch) || batch.length === 0) return bad('Body must be { modules: [...] } with at least one module.');
  if (batch.length > 100) return bad(`Batch of ${batch.length} exceeds the 100-module limit.`);

  let embeddings;
  try {
    const out = await env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: batch.map((m) => m.text) });
    embeddings = out?.data;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, got ${embeddings?.length}`);
    }
  } catch (err) {
    return upstream('workers-ai', err);
  }

  try {
    await env.VECTORIZE.upsert(batch.map((m, i) => ({
      id: m.code,
      values: embeddings[i],
      metadata: {
        code: m.code,
        sem1: m.semesters.includes(1), sem2: m.semesters.includes(2),
        sem3: m.semesters.includes(3), sem4: m.semesters.includes(4),
        level: m.level, credits: m.credits, faculty: m.faculty ?? '', ng: m.ng === true,
      },
    })));
  } catch (err) {
    return upstream('vectorize', err);
  }

  try {
    const stmt = env.DB.prepare(
      `INSERT INTO modules (code, title, description, credits, department, faculty, level,
                            semesters, workload, prerequisite, preclusion, acad_year, text_hash,
                            ng, ng_semesters)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET
         title=excluded.title, description=excluded.description, credits=excluded.credits,
         department=excluded.department, faculty=excluded.faculty, level=excluded.level,
         semesters=excluded.semesters, workload=excluded.workload,
         prerequisite=excluded.prerequisite, preclusion=excluded.preclusion,
         acad_year=excluded.acad_year, text_hash=excluded.text_hash,
         ng=excluded.ng, ng_semesters=excluded.ng_semesters`,
    );
    await env.DB.batch(batch.map((m) => stmt.bind(
      m.code, m.title, m.description, m.credits, m.department, m.faculty, m.level,
      JSON.stringify(m.semesters), m.workload, m.prerequisite, m.preclusion, m.acadYear, m.textHash,
      m.ng ? 1 : 0, JSON.stringify(m.ngSemesters ?? []),
    )));
  } catch (err) {
    return upstream('d1', err);
  }

  return json({ upserted: batch.length });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/index.html') {
      return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    if (path === '/search') {
      // Identical searches are common — a shared link, a reload, a load test,
      // the evaluation harness running the same fixture repeatedly. Serving
      // those from cache costs zero D1 rows, zero Vectorize queries and zero
      // Workers AI calls. Keyed on the full URL, so filters vary the entry.
      const cache = caches.default;
      const cacheKey = new Request(url.toString(), { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) return hit;

      // Guardrail: /search is the only route that spends metered upstream quota.
      if (env.SEARCH_LIMIT) {
        const key = request.headers.get('cf-connecting-ip') ?? 'anonymous';
        const { success } = await env.SEARCH_LIMIT.limit({ key });
        if (!success) {
          return new Response(
            JSON.stringify({ error: 'rate_limited', message: 'Too many searches from this address. Try again in a minute.' }, null, 2),
            { status: 429, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'access-control-allow-origin': '*' } },
          );
        }
      }
      const response = await handleSearch(request, env);
      // Only successful responses are cached; a 400 or a 502 must stay live.
      if (response.status === 200) {
        const cacheable = new Response(response.body, response);
        cacheable.headers.set('cache-control', 'public, max-age=3600');
        ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));
        return cacheable;
      }
      return response;
    }
    if (path === '/facets') return handleFacets(env);
    if (path.startsWith('/module/')) return handleModule(env, path.slice('/module/'.length));
    if (path === '/admin/hashes' && request.method === 'GET') return handleHashes(request, env);
    if (path === '/admin/ingest' && request.method === 'POST') return handleIngest(request, env);
    if (path === '/admin/facets' && request.method === 'POST') return handleFacetsRebuild(request, env);

    return json({ error: 'not_found', message: `No route for ${path}.` }, 404);
  },
};
