// @ts-check
// The Worker entry point: routing only. Each route lives in its own module so
// search (search.js), module/facet reads (modules.js) and the admin ingest
// routes (ingest.js) can change independently.
import { appVersion, json, withHeaders } from './http.js';
import { handleFacetsRebuild, handleHashes, handleIngest } from './ingest.js';
import { handleFacets, handleModule } from './modules.js';
import page from './page.html';
import { searchRoute } from './search.js';
import { Trace } from './timing.js';

/**
 * GET /health: which version is serving. Deliberately touches no binding but
 * version_metadata, so it costs nothing and works when D1 is down.
 * @param {Env} env
 */
function handleHealth(env) {
  const meta = /** @type {WorkerVersionMetadata | undefined} */ (env.CF_VERSION_METADATA);
  const response = json({ ok: true, versionId: meta?.id ?? null, versionTag: meta?.tag || null });
  response.headers.set('cache-control', 'no-store');
  return response;
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {ExecutionContext} ctx
 * @param {Trace} trace
 * @returns {Promise<Response> | Response}
 */
function route(request, env, ctx, trace) {
  const path = new URL(request.url).pathname;

  if (path === '/' || path === '/index.html') {
    return new Response(page, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (path === '/search') return searchRoute(request, env, ctx, trace);
  if (path === '/facets') return timed(handleFacets(env, trace), trace);
  if (path.startsWith('/module/')) return timed(handleModule(env, path.slice('/module/'.length), trace), trace);
  if (path === '/health') return handleHealth(env);
  if (path === '/admin/hashes' && request.method === 'GET') return handleHashes(request, env);
  if (path === '/admin/ingest' && request.method === 'POST') return handleIngest(request, env);
  if (path === '/admin/facets' && request.method === 'POST') return handleFacetsRebuild(request, env);

  return json({ error: 'not_found', message: `No route for ${path}.` }, 404);
}

/**
 * Adds Server-Timing (`d1`, `total`) to a /module or /facets response.
 * @param {Promise<Response>} pending
 * @param {Trace} trace
 */
async function timed(pending, trace) {
  return withHeaders(await pending, { 'server-timing': trace.header() });
}

/**
 * The request's id for an error report: the cf-ray Cloudflare assigned, so a
 * user's report can be matched to the logs, else a fresh random id.
 * @param {Request} request
 */
const requestId = (request) => request.headers.get('cf-ray') ?? crypto.randomUUID();

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const trace = new Trace();
    /** @type {Response} */
    let response;
    try {
      response = await route(request, env, ctx, trace);
    } catch (err) {
      // Anything a route did not handle (B5): a JSON 500 the caller can quote,
      // never workerd's bare "error code: 1101".
      const id = requestId(request);
      const e = /** @type {any} */ (err);
      console.error(JSON.stringify({
        event: 'unhandled', requestId: id, path: new URL(request.url).pathname,
        name: e?.name ?? null, message: e?.message ?? String(err), stack: e?.stack ?? null,
      }));
      response = json({ error: 'internal', requestId: id }, 500);
      response.headers.set('cache-control', 'no-store');
    }
    return withHeaders(response, { 'x-app-version': appVersion(env) });
  },
};
