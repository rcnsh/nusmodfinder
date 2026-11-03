// @ts-check
// Admin routes used by scripts/ingest.mjs and scripts/verify.mjs:
// /admin/hashes, /admin/ingest, /admin/delete, /admin/facets,
// /admin/vectorize and /admin/verify.
//
// Embedding runs here rather than in the ingest script so no Cloudflare API
// token has to exist on disk; the script streams batches in over HTTP and the
// Worker uses its own AI, Vectorize and D1 bindings. The routes do not exist
// unless an INGEST_SECRET is bound, so a deployed Worker has no admin surface.
import { DEFAULT_MODEL } from './embedding.js';
import { bad, json, upstream } from './http.js';
import { computeFacets } from './modules.js';
import { ROW_COLUMNS, boundTuple, fieldsFromRow, rowHash, vectorMetadata } from './rowhash.js';

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
 * The index binding as the async-mutation (post-beta) API it is: upsert and
 * deleteByIds answer `{ mutationId }` and describe() reports
 * processedUpToMutation. `wrangler types` declares the binding with the beta
 * `VectorizeIndex` type, which has neither.
 * @param {Env} env
 */
const vectorize = (env) => /** @type {Vectorize} */ (/** @type {unknown} */ (env.VECTORIZE));

/** Vectorize getByIds is asked for at most this many ids per call. */
const GET_BY_IDS_CHUNK = 20;
/** Most codes one /admin/delete call takes. */
const DELETE_LIMIT = 100;
/** Most vectors /admin/verify compares, per call. */
const VERIFY_SAMPLE_LIMIT = 100;

/**
 * Sums D1 meta over the results of one batch or statement.
 * @param {D1Result[]} results
 */
const metaOf = (results) => ({
  rows_read: results.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0),
  rows_written: results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0),
});

/**
 * Whether the database has migration 0006: the schema marker, the
 * external-content FTS table, triggers addressed by rowid and the row_hash
 * column. Ingest refuses to write without it: through the old triggers a full
 * re-ingest reads ~46M rows (FINDINGS B3). Reads a few sqlite_master rows.
 * @param {D1Database} db
 * @returns {Promise<import('../scripts/ingest-core.mjs').SchemaStatus>}
 */
export async function schemaStatus(db) {
  /** @type {any} */
  let row = null;
  try {
    row = await db.prepare(
      `SELECT (SELECT value FROM meta WHERE key = 'schema') AS version,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts') AS fts,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts_update') AS trig,
              (SELECT count(*) FROM pragma_table_info('modules') WHERE name = 'row_hash') AS row_hash`).first();
  } catch {
    // No meta table (pre-0004): certainly not 0006.
  }
  const version = row?.version == null ? null : Number(row.version);
  const ftsExternal = /content\s*=\s*'modules'/i.test(row?.fts ?? '');
  const rowidTriggers = /old\.rowid/i.test(row?.trig ?? '');
  const rowHashColumn = Number(row?.row_hash ?? 0) === 1;
  return {
    version, ftsExternal, rowidTriggers, rowHashColumn,
    ok: version !== null && version >= 6 && ftsExternal && rowidTriggers && rowHashColumn,
  };
}

/**
 * GET /admin/hashes: `{ schema, embeddingModel, modules: { code: { textHash, rowHash } } }`.
 * `modules` is null when the schema check fails (the row_hash column may not
 * exist), and ingest refuses.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleHashes(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  const schema = await schemaStatus(env.DB);
  const embeddingModel = env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
  if (!schema.ok) return json({ schema, embeddingModel, modules: null });
  const { results } = /** @type {D1Result<{ code: string, text_hash: string, row_hash: string | null }>} */ (
    await env.DB.prepare('SELECT code, text_hash, row_hash FROM modules').all());
  return json({
    schema, embeddingModel,
    modules: Object.fromEntries(results.map((r) => [r.code, { textHash: r.text_hash, rowHash: r.row_hash }])),
  });
}

/**
 * Vectorize getByIds over any number of ids.
 * @param {Env} env
 * @param {string[]} ids
 */
async function getVectors(env, ids) {
  /** @type {Map<string, VectorizeVector>} */
  const out = new Map();
  for (let i = 0; i < ids.length; i += GET_BY_IDS_CHUNK) {
    for (const v of await env.VECTORIZE.getByIds(ids.slice(i, i + GET_BY_IDS_CHUNK))) out.set(v.id, v);
  }
  return out;
}

/**
 * POST /admin/ingest `{ modules: [...] }` (at most 100). Each module may carry
 * `reembed: false` (scripts/ingest-core.mjs: its text_hash is unchanged, only
 * the row changed): its stored vector values are re-upserted with the new
 * metadata instead of being embedded again; if Vectorize has no vector for it,
 * it is embedded after all. Vectorize first, then one D1 batch writing every
 * column plus the row_hash computed here from exactly the bound values.
 * Answers `{ upserted, embedded, reused, mutationId, meta: { rows_read, rows_written } }`;
 * ingest sums `meta.rows_written` against its write budget.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleIngest(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;

  const body = /** @type {{ modules?: (IngestModule & { reembed?: boolean })[] } | null} */ (await request.json());
  const batch = body?.modules;
  if (!Array.isArray(batch) || batch.length === 0) return bad('Body must be { modules: [...] } with at least one module.');
  if (batch.length > 100) return bad(`Batch of ${batch.length} exceeds the 100-module limit.`);

  /** @type {Map<string, VectorizeVector['values']>} */
  const values = new Map();
  const reuse = batch.filter((m) => m.reembed === false);
  try {
    for (const [id, v] of await getVectors(env, reuse.map((m) => m.code))) {
      if (v.values && v.values.length) values.set(id, v.values);
    }
  } catch (err) {
    return upstream('vectorize', err);
  }
  const toEmbed = batch.filter((m) => !values.has(m.code));

  if (toEmbed.length) {
    try {
      const out = /** @type {{ data?: number[][] }} */ (
        await env.AI.run(env.EMBEDDING_MODEL ?? DEFAULT_MODEL, { text: toEmbed.map((m) => m.text) }));
      const embeddings = out?.data;
      if (!Array.isArray(embeddings) || embeddings.length !== toEmbed.length) {
        throw new Error(`Expected ${toEmbed.length} embeddings, got ${embeddings?.length}`);
      }
      toEmbed.forEach((m, i) => values.set(m.code, embeddings[i]));
    } catch (err) {
      return upstream('workers-ai', err);
    }
  }

  /** @type {string} */
  let mutationId;
  try {
    const mutation = await vectorize(env).upsert(batch.map((m) => ({
      id: m.code,
      values: /** @type {VectorizeVector['values']} */ (values.get(m.code)),
      // level/credits are `number | null` (lib.mjs normalise) but Vectorize metadata
      // types exclude null; written as they always have been.
      metadata: /** @type {Record<string, VectorizeVectorMetadata>} */ (vectorMetadata(m)),
    })));
    mutationId = mutation.mutationId;
  } catch (err) {
    return upstream('vectorize', err);
  }

  try {
    const hashes = await Promise.all(batch.map((m) => rowHash(m)));
    const stmt = env.DB.prepare(
      `INSERT INTO modules (${ROW_COLUMNS.join(', ')}, row_hash)
       VALUES (${ROW_COLUMNS.map(() => '?').join(',')},?)
       ON CONFLICT(code) DO UPDATE SET
         title=excluded.title, description=excluded.description, credits=excluded.credits,
         department=excluded.department, faculty=excluded.faculty, level=excluded.level,
         semesters=excluded.semesters, workload=excluded.workload,
         prerequisite=excluded.prerequisite, preclusion=excluded.preclusion,
         acad_year=excluded.acad_year, text_hash=excluded.text_hash,
         ng=excluded.ng, ng_semesters=excluded.ng_semesters, row_hash=excluded.row_hash`,
    );
    const results = await env.DB.batch(batch.map((m, i) => stmt.bind(...boundTuple(m), hashes[i])));
    return json({
      upserted: batch.length, embedded: toEmbed.length, reused: batch.length - toEmbed.length,
      mutationId, meta: metaOf(results),
    });
  } catch (err) {
    return upstream('d1', err);
  }
}

/**
 * POST /admin/delete `{ codes: [...] }` (at most 100): removes modules that
 * left the corpus. Vectorize deleteByIds first, then D1: if the D1 delete
 * fails, the row is still in D1, so the next run plans its delete again; the
 * other order would orphan the vector, invisible to a plan built from D1's
 * codes (plan r2, objection #11). Answers `{ deleted, mutationId, meta }`.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleDelete(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  /** @type {any} */
  let body;
  try { body = await request.json(); } catch { return bad('Body must be JSON.'); }
  const codes = body?.codes;
  if (!Array.isArray(codes) || codes.length === 0 || !codes.every((c) => typeof c === 'string' && c.length > 0)) {
    return bad('Body must be { codes: [...] } with at least one module code.');
  }
  if (codes.length > DELETE_LIMIT) return bad(`${codes.length} codes exceed the ${DELETE_LIMIT}-code limit.`);

  /** @type {string} */
  let mutationId;
  try {
    mutationId = (await vectorize(env).deleteByIds(codes)).mutationId;
  } catch (err) {
    return upstream('vectorize', err);
  }
  try {
    // RETURNING, not meta.changes: changes also counts the FTS trigger's writes.
    const res = /** @type {D1Result<{ code: string }>} */ (await env.DB.prepare(
      `DELETE FROM modules WHERE code IN (${codes.map(() => '?').join(',')}) RETURNING code`).bind(...codes).all());
    return json({ deleted: res.results.length, codes: res.results.map((r) => r.code), mutationId, meta: metaOf([res]) });
  } catch (err) {
    return upstream('d1', err);
  }
}

/**
 * GET /admin/vectorize: the index's describe(), for ingest's mutation wait.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleVectorizeInfo(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  try {
    return json(await vectorize(env).describe());
  } catch (err) {
    return upstream('vectorize', err);
  }
}

/** Metadata as compared by verify: keys sorted, null and absent alike. @param {Record<string, unknown> | undefined} m */
const canonicalMetadata = (m) => JSON.stringify(Object.fromEntries(
  Object.entries(m ?? {}).filter(([, v]) => v !== null && v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1))));

/**
 * POST /admin/verify `{ sampleSize?: number, sample?: string[] }`: the D1 half
 * of `npm run verify`. Reads every row once, recomputes its row_hash from the
 * stored columns, and compares Vectorize metadata (getByIds) with what the row
 * implies for a sample of at most 100 codes (random unless `sample` names
 * them). The vector id listing comes from wrangler (scripts/verify.mjs).
 * @param {Request} request
 * @param {Env} env
 */
export async function handleVerify(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  /** @type {any} */
  let body;
  try { body = await request.json(); } catch { return bad('Body must be JSON.'); }
  const sampleSize = Math.min(Number.isInteger(body?.sampleSize) ? body.sampleSize : VERIFY_SAMPLE_LIMIT, VERIFY_SAMPLE_LIMIT);
  if (body?.sample !== undefined && (!Array.isArray(body.sample) || body.sample.length > VERIFY_SAMPLE_LIMIT)) {
    return bad(`sample must be an array of at most ${VERIFY_SAMPLE_LIMIT} codes.`);
  }

  /** @type {D1Result<import('./rowhash.js').ModuleRow>} */
  let rows;
  try {
    rows = await env.DB.prepare(`SELECT ${ROW_COLUMNS.join(', ')}, row_hash FROM modules ORDER BY code`).all();
  } catch (err) {
    return upstream('d1', err);
  }
  const byCode = new Map(rows.results.map((r) => [r.code, r]));
  const rowHashDrift = [];
  const missingRowHash = [];
  for (const r of rows.results) {
    if (r.row_hash == null) { missingRowHash.push(r.code); continue; }
    const recomputed = await rowHash(fieldsFromRow(r));
    if (recomputed !== r.row_hash) rowHashDrift.push({ code: r.code, stored: r.row_hash, recomputed });
  }

  /** @type {string[]} */
  let sample = body?.sample ?? [];
  if (body?.sample === undefined) {
    const codes = [...byCode.keys()];
    for (let i = codes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [codes[i], codes[j]] = [codes[j], codes[i]];
    }
    sample = codes.slice(0, sampleSize).sort();
  }
  /** @type {Map<string, VectorizeVector>} */
  let vectors;
  try {
    vectors = await getVectors(env, sample);
  } catch (err) {
    return upstream('vectorize', err);
  }
  const missingVectors = [];
  const metadataDrift = [];
  for (const code of sample) {
    const row = byCode.get(code);
    const v = vectors.get(code);
    if (!v) { if (row) missingVectors.push(code); continue; }
    if (!row) continue; // an extra vector: the id listing reports it
    const expected = vectorMetadata(fieldsFromRow(row));
    if (canonicalMetadata(v.metadata) !== canonicalMetadata(expected)) {
      metadataDrift.push({ code, expected, actual: v.metadata ?? null });
    }
  }
  return json({
    codes: [...byCode.keys()],
    rowHash: { checked: rows.results.length, drift: rowHashDrift, missing: missingRowHash },
    sample: { checked: sample.length, codes: sample, missingVectors, metadataDrift },
    meta: metaOf([rows]),
  });
}

// Guarded: rebuilds the precomputed facet row. Called by the ingest script once
// the corpus has finished loading. An optional body `{ ngList: { updatedAsAt,
// source, count } }` (from data/ng-courses-*.json) is stored as meta('ng_list')
// first, so /facets reports the NG list date from the file itself (O3). Admin
// reads and writes go to the primary (env.DB), never a replica.
/**
 * @param {Request} request
 * @param {Env} env
 */
export async function handleFacetsRebuild(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;

  /** @type {import('./modules.js').NgList | null} */
  let ngList = null;
  const text = await request.text();
  if (text.trim() !== '') {
    /** @type {any} */
    let body;
    try { body = JSON.parse(text); } catch { return bad('Body must be JSON.'); }
    if (body?.ngList !== undefined) {
      const { updatedAsAt, source, count } = body.ngList ?? {};
      const okString = (/** @type {unknown} */ v) => v === null || typeof v === 'string';
      if (!okString(updatedAsAt) || !okString(source) || !Number.isInteger(count) || count < 0) {
        return bad('ngList must be { updatedAsAt: string | null, source: string | null, count: non-negative integer }.');
      }
      ngList = { updatedAsAt, source, count };
    }
  }

  try {
    const now = new Date().toISOString();
    const upsertMeta = env.DB.prepare(
      `INSERT INTO meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    if (ngList) await upsertMeta.bind('ng_list', JSON.stringify(ngList), now).run();
    const facets = await computeFacets(env.DB);
    await upsertMeta.bind('facets', JSON.stringify(facets), now).run();
    return json({
      rebuilt: 'facets', faculties: facets.faculties.length, levels: facets.levels.length, ng: facets.ng.count,
      ngListUpdatedAsAt: facets.ng.updatedAsAt,
    });
  } catch (err) {
    return upstream('d1', err);
  }
}
