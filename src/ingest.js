// @ts-check
// Admin routes used by scripts/ingest.mjs: /admin/hashes, /admin/ingest,
// /admin/facets.
//
// Embedding runs here rather than in the ingest script so no Cloudflare API
// token has to exist on disk; the script streams batches in over HTTP and the
// Worker uses its own AI, Vectorize and D1 bindings. The routes do not exist
// unless an INGEST_SECRET is bound, so a deployed Worker has no admin surface.
import { DEFAULT_MODEL } from './embedding.js';
import { bad, json, upstream } from './http.js';
import { computeFacets } from './modules.js';

/**
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: number[], workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acadYear: string, text: string, textHash: string,
 *   ng: boolean, ngSemesters?: number[],
 * }} IngestModule One module as posted by scripts/ingest.mjs.
 */

/**
 * @param {Request} request
 * @param {Env} env
 */
function ingestGuard(request, env) {
  if (!env.INGEST_SECRET) return json({ error: 'not_found' }, 404);
  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${env.INGEST_SECRET}`) return json({ error: 'unauthorized' }, 401);
  return null;
}

/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleHashes(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  const { results } = /** @type {D1Result<{ code: string, text_hash: string }>} */ (
    await env.DB.prepare('SELECT code, text_hash FROM modules').all());
  return json(Object.fromEntries(results.map((r) => [r.code, r.text_hash])));
}

/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleIngest(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;

  const body = /** @type {{ modules?: IngestModule[] } | null} */ (await request.json());
  const batch = body?.modules;
  if (!Array.isArray(batch) || batch.length === 0) return bad('Body must be { modules: [...] } with at least one module.');
  if (batch.length > 100) return bad(`Batch of ${batch.length} exceeds the 100-module limit.`);

  /** @type {number[][] | undefined} */
  let embeddings;
  try {
    const out = /** @type {{ data?: number[][] }} */ (
      await env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: batch.map((m) => m.text) }));
    embeddings = out?.data;
    if (!Array.isArray(embeddings) || embeddings.length !== batch.length) {
      throw new Error(`Expected ${batch.length} embeddings, got ${embeddings?.length}`);
    }
  } catch (err) {
    return upstream('workers-ai', err);
  }

  try {
    // @ts-expect-error level/credits are `number | null` (lib.mjs normalise) but Vectorize metadata
    // types exclude null. Narrowing them would change what is written; Phase 0 makes no behaviour change.
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

// Guarded: rebuilds the precomputed facet row. Called by the ingest script once
// the corpus has finished loading.
/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleFacetsRebuild(request, env) {
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
