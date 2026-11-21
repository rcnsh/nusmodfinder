// @ts-check
import { denseBundle } from './dense.js';
import { appVersion, json, withHeaders } from './http.js';
import {
  handleCatalogue, handleCatalogueHashes, handleDelete, handleFacetsRebuild, handleHashes, handleIngest, handleVectorizeInfo,
  handleVectors, handleVerify,
} from './ingest.js';
import { handleFacets, handleModule } from './modules.js';
import { notFoundPage, prefersHtml } from './not-found.js';
import { DATA_VERSION, searchRoute } from './search.js';
import { Trace } from './timing.js';

/** @param {Env} env */
function handleHealth(env) {
  const meta = /** @type {WorkerVersionMetadata | undefined} */ (env.CF_VERSION_METADATA);
  let vectors = null;
  try {
    const { header } = denseBundle();
    vectors = { corpus: header.corpus, count: header.count, dataVersion: header.dataVersion };
  } catch {}
  const response = json({
    ok: true, versionId: meta?.id ?? null, versionTag: meta?.tag || null, dataVersion: DATA_VERSION, vectors,
  });
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

  if (path === '/search') return searchRoute(request, env, ctx, trace);
  if (path === '/facets') return timed(handleFacets(env, trace), trace);
  if (path.startsWith('/module/')) return timed(handleModule(env, path.slice('/module/'.length), trace), trace);
  if (path === '/health') return handleHealth(env);
  if (path === '/admin/hashes' && request.method === 'GET') return handleHashes(request, env);
  if (path === '/admin/ingest' && request.method === 'POST') return handleIngest(request, env);
  if (path === '/admin/facets' && request.method === 'POST') return handleFacetsRebuild(request, env);
  if (path === '/admin/delete' && request.method === 'POST') return handleDelete(request, env);
  if (path === '/admin/vectorize' && request.method === 'GET') return handleVectorizeInfo(request, env);
  if (path === '/admin/verify' && request.method === 'POST') return handleVerify(request, env);
  if (path === '/admin/vectors' && request.method === 'POST') return handleVectors(request, env);
  if (path === '/admin/catalogue' && request.method === 'GET') return handleCatalogueHashes(request, env);
  if (path === '/admin/catalogue' && request.method === 'POST') return handleCatalogue(request, env);

  if ((request.method === 'GET' || request.method === 'HEAD') && prefersHtml(request.headers.get('accept'))) return notFoundPage();
  return json({ error: 'not_found', message: `No route for ${path}.` }, 404);
}

/**
 * @param {Promise<Response>} pending
 * @param {Trace} trace
 */
async function timed(pending, trace) {
  return withHeaders(await pending, { 'server-timing': trace.header() });
}

/** @param {Request} request */
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
