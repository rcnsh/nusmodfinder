// @ts-check
// Admin routes used by scripts/ingest.mjs, scripts/verify.mjs and
// scripts/vectors.mjs: /admin/hashes, /admin/ingest, /admin/delete,
// /admin/facets, /admin/vectorize, /admin/verify and /admin/vectors.
//
// D1-only mode (Phase 3 runbook step 4, B3-5): `?d1Only=1` on /admin/ingest
// and /admin/delete writes D1 and nothing else, with no getByIds, AI.run or
// Vectorize call. The vectors reach Vectorize later, from the sha-checked
// bundle, through /admin/vectors (runbook step 8).
//
// Embedding runs here rather than in the ingest script so no Cloudflare API
// token has to exist on disk; the script streams batches in over HTTP and the
// Worker uses its own AI, Vectorize and D1 bindings. The routes do not exist
// unless an INGEST_SECRET is bound, so a deployed Worker has no admin surface.
import { DEFAULT_MODEL, EMBEDDING_DIMS } from './embedding.js';
import { bad, json, upstream } from './http.js';
import { computeFacets } from './modules.js';
import { ROW_COLUMNS, boundTuple, fieldsFromRow, ftsHash, rowHash, storedVectorMetadata } from './rowhash.js';
import { base64ToFloat32, float32ToBase64 } from './vector-bundle.js';

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

/**
 * When Vectorize accepted a mutation, by Cloudflare's clock: read just after
 * upsert/deleteByIds resolves (a Worker's clock advances only on I/O, so this
 * is the time that call returned), never before it. The mutation was stamped
 * at or before this instant, so once describe().processedUpToDatetime is
 * later than it, a later mutation has been processed and, mutations being
 * processed in order, this one too (scripts/ingest-core.mjs waitForMutation).
 * The same clock as processedUpToDatetime, so the ingest machine's clock never
 * enters the comparison.
 */
const acceptedAt = () => Date.now();

/** Vectorize getByIds is asked for at most this many ids per call. */
const GET_BY_IDS_CHUNK = 20;
/** Most codes one /admin/delete call takes. */
const DELETE_LIMIT = 100;
/** Most vectors /admin/verify compares, per call. */
const VERIFY_SAMPLE_LIMIT = 100;
/** Most vectors one /admin/vectors call upserts or deletes (the binding's upsert limit). */
export const VECTORS_LIMIT = 1000;
/** D1 binds at most 100 parameters per statement. */
const D1_PARAMS = 100;

/** @param {Request} request whether the call asks for the D1-only mode */
const d1OnlyOf = (request) => new URL(request.url).searchParams.get('d1Only') === '1';

/**
 * The `modules` rows for `codes`, by code, read in statements of at most 100
 * parameters, batched.
 * @param {D1Database} db
 * @param {string[]} codes
 * @returns {Promise<{ rows: Map<string, import('./rowhash.js').ModuleRow>, results: D1Result[] }>}
 */
async function rowsFor(db, codes) {
  if (codes.length === 0) return { rows: new Map(), results: [] };
  /** @type {D1PreparedStatement[]} */
  const stmts = [];
  for (let i = 0; i < codes.length; i += D1_PARAMS) {
    const chunk = codes.slice(i, i + D1_PARAMS);
    stmts.push(db.prepare(`SELECT ${ROW_COLUMNS.join(', ')}, row_hash FROM modules WHERE code IN (${chunk.map(() => '?').join(',')})`).bind(...chunk));
  }
  const results = /** @type {D1Result<import('./rowhash.js').ModuleRow>[]} */ (await db.batch(stmts));
  return { rows: new Map(results.flatMap((r) => r.results).map((r) => [r.code, r])), results };
}

/**
 * Sums D1 meta over the results of one batch or statement.
 * @param {D1Result[]} results
 */
const metaOf = (results) => ({
  rows_read: results.reduce((n, r) => n + (r.meta?.rows_read ?? 0), 0),
  rows_written: results.reduce((n, r) => n + (r.meta?.rows_written ?? 0), 0),
});

/**
 * The triggers 0006 creates. Without any one of them the FTS index or the
 * rowid it is keyed on drifts from `modules` (a missing insert trigger: new
 * modules never reach FTS).
 */
export const REQUIRED_TRIGGERS = ['modules_fts_insert', 'modules_fts_delete', 'modules_fts_update', 'modules_rowid_immutable'];

/**
 * Whether the database has migration 0006: the schema marker, the
 * external-content FTS table, all four of its triggers (the update trigger
 * addressed by rowid) and the row_hash column. Ingest refuses to write
 * without it: through the old triggers a full re-ingest reads ~46M rows
 * (FINDINGS B3). Reads a few sqlite_master rows.
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
              (SELECT json_group_array(name) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'modules') AS triggers,
              (SELECT count(*) FROM pragma_table_info('modules') WHERE name = 'row_hash') AS row_hash`).first();
  } catch {
    // No meta table (pre-0004): certainly not 0006.
  }
  const version = row?.version == null ? null : Number(row.version);
  const ftsExternal = /content\s*=\s*'modules'/i.test(row?.fts ?? '');
  const rowidTriggers = /old\.rowid/i.test(row?.trig ?? '');
  const present = new Set(/** @type {string[]} */ (JSON.parse(row?.triggers ?? '[]')));
  const missingTriggers = REQUIRED_TRIGGERS.filter((t) => !present.has(t));
  const rowHashColumn = Number(row?.row_hash ?? 0) === 1;
  return {
    version, ftsExternal, rowidTriggers, missingTriggers, rowHashColumn,
    ok: version !== null && version >= 6 && ftsExternal && rowidTriggers && missingTriggers.length === 0 && rowHashColumn,
  };
}

/**
 * GET /admin/hashes:
 * `{ schema, embeddingModel, acadYears, modules: { code: { textHash, rowHash, ftsHash } } }`.
 * `ftsHash` (src/rowhash.js) hashes the stored code, title and description,
 * the columns the 0006 FTS update trigger watches, so ingest charges FTS
 * writes only to upserts that change them; text_hash cannot tell (it also
 * covers the model and the embedded-text version, PR #13 review).
 * `acadYears` counts D1's rows per acad year (`{}` for an empty database), so
 * ingest can refuse to rewrite a database to another year.
 * `modules` and `acadYears` are null when the schema check fails (the
 * row_hash column may not exist), and ingest refuses.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleHashes(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  const schema = await schemaStatus(env.DB);
  const embeddingModel = env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
  if (!schema.ok) return json({ schema, embeddingModel, acadYears: null, modules: null });
  const { results } = /** @type {D1Result<{
    code: string, title: string, description: string, text_hash: string, row_hash: string | null, acad_year: string,
  }>} */ (await env.DB.prepare('SELECT code, title, description, text_hash, row_hash, acad_year FROM modules').all());
  const fts = await Promise.all(results.map((r) => ftsHash(r)));
  return json({
    schema, embeddingModel,
    acadYears: results.reduce((n, r) => ({ ...n, [r.acad_year]: (n[r.acad_year] ?? 0) + 1 }), /** @type {Record<string, number>} */ ({})),
    modules: Object.fromEntries(results.map((r, i) => [r.code, { textHash: r.text_hash, rowHash: r.row_hash, ftsHash: fts[i] }])),
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
 * POST /admin/ingest `{ modules: [...] }` (at most 100). With `?d1Only=1`
 * (runbook step 4) it writes the D1 rows and nothing else: no getByIds, no
 * AI.run, no Vectorize upsert, so `embedded` is 0 and `mutationId` null.
 * Otherwise each module may carry
 * `reembed: false` (scripts/ingest-core.mjs: its text_hash is unchanged, only
 * the row changed): its stored vector values are re-upserted with the new
 * metadata instead of being embedded again, but only if the stored vector says
 * it embeds this text (`metadata.textHash` equals the module's) and has the
 * index's dimensions. Otherwise (no vector, a vector from before textHash was
 * stored, or one Vectorize has not yet replaced with a newer embedding) it is
 * embedded after all, so stale values are never written back over a pending
 * upsert of new ones. Vectorize first, then one D1 batch writing every
 * column plus the row_hash computed here from exactly the bound values.
 * Answers `{ upserted, embedded, reused, mutationId, sentAt, meta: { rows_read, rows_written } }`;
 * ingest sums `meta.rows_written` against its write budget. `sentAt` is this
 * Worker's Date.now() once Vectorize has accepted the mutation (see
 * acceptedAt).
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
  if (d1OnlyOf(request)) return writeRows(env, batch, { embedded: 0, mutationId: null, sentAt: null, d1Only: true });

  /** @type {Map<string, VectorizeVector['values']>} */
  const values = new Map();
  const reuse = new Map(batch.filter((m) => m.reembed === false).map((m) => [m.code, m]));
  try {
    for (const [id, v] of await getVectors(env, [...reuse.keys()])) {
      const m = reuse.get(id);
      if (m && v.values?.length === EMBEDDING_DIMS && v.metadata?.textHash === m.textHash) values.set(id, v.values);
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
  /** @type {number} */
  let sentAt;
  try {
    const mutation = await vectorize(env).upsert(batch.map((m) => ({
      id: m.code,
      values: /** @type {VectorizeVector['values']} */ (values.get(m.code)),
      // level/credits are `number | null` (lib.mjs normalise) but Vectorize metadata
      // types exclude null; written as they always have been.
      metadata: /** @type {Record<string, VectorizeVectorMetadata>} */ (storedVectorMetadata(m)),
    })));
    mutationId = mutation.mutationId;
    sentAt = acceptedAt();
  } catch (err) {
    return upstream('vectorize', err);
  }
  return writeRows(env, batch, { embedded: toEmbed.length, mutationId, sentAt });
}

/**
 * The D1 half of /admin/ingest: one batch writing every column plus the
 * row_hash computed here from exactly the bound values.
 * @param {Env} env
 * @param {IngestModule[]} batch
 * @param {{ embedded: number, mutationId: string | null, sentAt: number | null, d1Only?: boolean }} done what the Vectorize half did
 */
async function writeRows(env, batch, { embedded, mutationId, sentAt, d1Only }) {
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
      upserted: batch.length, embedded, reused: d1Only ? 0 : batch.length - embedded,
      mutationId, sentAt, ...(d1Only ? { d1Only: true } : {}), meta: metaOf(results),
    });
  } catch (err) {
    return upstream('d1', err);
  }
}

/**
 * POST /admin/delete `{ codes: [...] }` (at most 100): removes modules that
 * left the corpus, in three steps:
 *  1. D1: clear the rows' text_hash ('', NOT NULL) and row_hash, so if a later
 *     step fails and the module comes back to the corpus, ingest sees no
 *     matching hash and re-embeds it rather than skipping it as unchanged with
 *     its vector gone (PR #13 review). 1 row written per code; no index or FTS
 *     trigger covers either column.
 *  2. Vectorize deleteByIds.
 *  3. D1 DELETE. If it fails, the row is still in D1, so the next run plans
 *     its delete again; deleting from D1 first would orphan the vector,
 *     invisible to a plan built from D1's codes (plan r2, objection #11).
 * Answers `{ deleted, codes, mutationId, sentAt, meta }`; meta covers both D1
 * statements; sentAt as for /admin/ingest.
 * With `?d1Only=1` (runbook step 4) only step 3 runs: the D1 rows are deleted
 * and their codes returned, for runbook step 8's deleteByIds. No Vectorize
 * call, so `mutationId` is null.
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
  const marks = codes.map(() => '?').join(',');
  if (d1OnlyOf(request)) {
    try {
      const res = /** @type {D1Result<{ code: string }>} */ (await env.DB.prepare(
        `DELETE FROM modules WHERE code IN (${marks}) RETURNING code`).bind(...codes).all());
      return json({ deleted: res.results.length, codes: res.results.map((r) => r.code), mutationId: null, sentAt: null, d1Only: true, meta: metaOf([res]) });
    } catch (err) {
      return upstream('d1', err);
    }
  }

  /** @type {D1Result} */
  let cleared;
  try {
    cleared = await env.DB.prepare(`UPDATE modules SET text_hash = '', row_hash = NULL WHERE code IN (${marks})`).bind(...codes).run();
  } catch (err) {
    return upstream('d1', err);
  }
  /** @type {string} */
  let mutationId;
  /** @type {number} */
  let sentAt;
  try {
    mutationId = (await vectorize(env).deleteByIds(codes)).mutationId;
    sentAt = acceptedAt();
  } catch (err) {
    return upstream('vectorize', err);
  }
  try {
    // RETURNING, not meta.changes: changes also counts the FTS trigger's writes.
    const res = /** @type {D1Result<{ code: string }>} */ (await env.DB.prepare(
      `DELETE FROM modules WHERE code IN (${marks}) RETURNING code`).bind(...codes).all());
    return json({ deleted: res.results.length, codes: res.results.map((r) => r.code), mutationId, sentAt, meta: metaOf([cleared, res]) });
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
 * POST /admin/verify `{ sampleSize?: number, sample?: string[], returnValues?: boolean, preDeploy?: boolean }`:
 * the D1 half of `npm run verify`. Reads every row once, recomputes its row_hash from the
 * stored columns, and compares Vectorize metadata (getByIds, textHash
 * included) with what the row implies for a sample of at most 100 codes (random unless `sample` names
 * them). The vector id listing comes from wrangler (scripts/verify.mjs).
 * - `returnValues`: each sampled vector's values come back as base64 float32
 *   (`sample.values`), so the script can compare them with the bundle's bits.
 * - `preDeploy` (runbook step 5, `npm run verify -- --pre-deploy`): no
 *   Vectorize call at all. Answers the row_hash check plus every row's code,
 *   text and row hashes and filter fields (`rows`), for the comparison with
 *   the manifest and the bundle.
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
  if (body?.preDeploy === true) {
    return json({
      codes: [...byCode.keys()],
      rowHash: { checked: rows.results.length, drift: rowHashDrift, missing: missingRowHash },
      rows: rows.results.map((r) => {
        const f = fieldsFromRow(r);
        return {
          code: r.code, textHash: r.text_hash, rowHash: r.row_hash ?? null, semesters: f.semesters, level: f.level,
          credits: f.credits, faculty: f.faculty, ng: f.ng, ngSemesters: f.ngSemesters ?? [],
        };
      }),
      meta: metaOf([rows]),
    });
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
  /** @type {Record<string, string>} */
  const values = {};
  for (const code of sample) {
    const row = byCode.get(code);
    const v = vectors.get(code);
    if (!v) { if (row) missingVectors.push(code); continue; }
    if (body?.returnValues === true && v.values) values[code] = float32ToBase64(/** @type {ArrayLike<number>} */ (v.values));
    if (!row) continue; // an extra vector: the id listing reports it
    // textHash included: a vector whose values embed another text drifts.
    const expected = storedVectorMetadata(fieldsFromRow(row));
    if (canonicalMetadata(v.metadata) !== canonicalMetadata(expected)) {
      metadataDrift.push({ code, expected, actual: v.metadata ?? null });
    }
  }
  return json({
    codes: [...byCode.keys()],
    rowHash: { checked: rows.results.length, drift: rowHashDrift, missing: missingRowHash },
    sample: { checked: sample.length, codes: sample, missingVectors, metadataDrift, ...(body?.returnValues === true ? { values } : {}) },
    meta: metaOf([rows]),
  });
}

/**
 * POST /admin/vectors (runbook step 8, B2-1, B3-3): brings the Vectorize
 * standby level with the bundle.
 * - `{ ids: string[], values: string }`: upserts at most 1,000 vectors.
 *   `values` is base64 little-endian float32, ids.length × 384 of them, read
 *   by scripts/vectors.mjs from the sha-checked bundle asset, never from this
 *   Worker's own bundle (the fixture, in a dev session). Each vector gets its
 *   full metadata from its D1 row (storedVectorMetadata, the new textHash
 *   included), so an upsert never wipes the filter properties. Refuses, with
 *   nothing written, ids that D1 does not hold.
 * - `{ deleteIds: string[] }`: deleteByIds for at most 1,000 codes that D1 no
 *   longer holds (runbook step 4's D1-only deletions). Refuses any code D1
 *   still holds.
 * Answers `{ upserted | deleted, mutationId, sentAt, meta }`; no D1 write,
 * no neuron.
 * @param {Request} request
 * @param {Env} env
 */
export async function handleVectors(request, env) {
  const denied = ingestGuard(request, env);
  if (denied) return denied;
  /** @type {any} */
  let body;
  try { body = await request.json(); } catch { return bad('Body must be JSON.'); }
  const codesOk = (/** @type {unknown} */ xs) => Array.isArray(xs) && xs.length > 0 && xs.length <= VECTORS_LIMIT
    && xs.every((c) => typeof c === 'string' && c.length > 0) && new Set(xs).size === xs.length;

  if (body?.deleteIds !== undefined) {
    if (!codesOk(body.deleteIds)) return bad(`deleteIds must be 1 to ${VECTORS_LIMIT} distinct module codes.`);
    /** @type {string[]} */
    const ids = body.deleteIds;
    let read;
    try { read = await rowsFor(env.DB, ids); } catch (err) { return upstream('d1', err); }
    const held = ids.filter((c) => read.rows.has(c));
    if (held.length) return bad(`Refusing to delete vectors D1 still holds: ${held.slice(0, 10).join(', ')}${held.length > 10 ? ', …' : ''}.`);
    try {
      const { mutationId } = await vectorize(env).deleteByIds(ids);
      return json({ deleted: ids.length, mutationId, sentAt: acceptedAt(), meta: metaOf(read.results) });
    } catch (err) {
      return upstream('vectorize', err);
    }
  }

  if (!codesOk(body?.ids) || typeof body?.values !== 'string') {
    return bad(`Body must be { ids: [1 to ${VECTORS_LIMIT} distinct codes], values: base64 float32 } or { deleteIds: [...] }.`);
  }
  /** @type {string[]} */
  const ids = body.ids;
  /** @type {Float32Array} */
  let values;
  try { values = base64ToFloat32(body.values); } catch (err) { return bad(`values: ${/** @type {Error} */ (err).message}`); }
  if (values.length !== ids.length * EMBEDDING_DIMS) {
    return bad(`values holds ${values.length} floats; ${ids.length} ids need ${ids.length * EMBEDDING_DIMS}.`);
  }
  if (!values.every((x) => Number.isFinite(x))) return bad('values must all be finite.');
  let read;
  try { read = await rowsFor(env.DB, ids); } catch (err) { return upstream('d1', err); }
  const unknown = ids.filter((c) => !read.rows.has(c));
  if (unknown.length) return bad(`D1 holds no row for ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ', …' : ''}; nothing was upserted.`);
  try {
    const { mutationId } = await vectorize(env).upsert(ids.map((id, i) => ({
      id,
      values: Array.from(values.subarray(i * EMBEDDING_DIMS, (i + 1) * EMBEDDING_DIMS)),
      // level/credits may be null; written as /admin/ingest writes them.
      metadata: /** @type {Record<string, VectorizeVectorMetadata>} */ (
        storedVectorMetadata(fieldsFromRow(/** @type {import('./rowhash.js').ModuleRow} */ (read.rows.get(id))))),
    })));
    return json({ upserted: ids.length, mutationId, sentAt: acceptedAt(), meta: metaOf(read.results) });
  } catch (err) {
    return upstream('vectorize', err);
  }
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
