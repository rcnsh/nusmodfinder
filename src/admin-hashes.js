// @ts-check
// What GET /admin/hashes answers, computed from `SELECT` results alone, so the Worker route
// (src/ingest.js handleHashes, over its D1 binding) and the deploy guard (scripts/guard.mjs,
// over Cloudflare's D1 REST query endpoint) run the same code over the same rows (Phase 7 7B,
// G1; test/admin-hashes-rest.test.js proves they agree). A query is any function from a
// statement and its params to `{ results }`: `d1Query(env.DB)` in the Worker, the REST client's
// `query` in Node. Read-only statements only. WebCrypto only: no bindings, no Node APIs.
import { ROW_COLUMNS, ftsHash } from './rowhash.js';

/**
 * One read: a statement and its params, answering D1's result shape.
 * @typedef {(sql: string, params?: unknown[]) => Promise<{ results: any[], meta?: { rows_read?: number } }>} Query
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, missingTriggers: string[],
 *   rowHashColumn: boolean, missingColumns: string[], ok: boolean,
 * }} SchemaStatus
 * @typedef {{ textHash: string, rowHash: string | null, ftsHash: string }} ModuleHashes
 * @typedef {{
 *   schema: SchemaStatus, embeddingModel: string, acadYears: Record<string, number> | null,
 *   modules: Record<string, ModuleHashes> | null,
 * }} AdminHashes
 */

/**
 * The triggers 0006 creates. Without any one of them the FTS index or the
 * rowid it is keyed on drifts from `modules` (a missing insert trigger: new
 * modules never reach FTS).
 */
export const REQUIRED_TRIGGERS = ['modules_fts_insert', 'modules_fts_delete', 'modules_fts_update', 'modules_rowid_immutable'];

/** The schema check's one statement (a few sqlite_master rows). */
export const SCHEMA_SQL = `SELECT (SELECT value FROM meta WHERE key = 'schema') AS version,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts') AS fts,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts_update') AS trig,
              (SELECT json_group_array(name) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'modules') AS triggers,
              (SELECT count(*) FROM pragma_table_info('modules') WHERE name = 'row_hash') AS row_hash,
              (SELECT json_group_array(name) FROM pragma_table_info('modules')) AS columns`;

/** The hashes' one statement: every `modules` row (~6.8k rows read in production). */
export const HASHES_SQL = 'SELECT code, title, description, text_hash, row_hash, acad_year FROM modules';

/**
 * A Query over a D1 binding (typed by shape, so the Node scripts that import this need no
 * Workers types).
 * @param {{ prepare: (sql: string) => { bind: (...values: unknown[]) => { all: () => Promise<any> } } }} db
 * @returns {Query}
 */
export const d1Query = (db) => (sql, params = []) => db.prepare(sql).bind(...params).all();

/**
 * Whether the database has migration 0006: the schema marker, the
 * external-content FTS table, all four of its triggers (the update trigger
 * addressed by rowid) and the row_hash column; and every column the upsert
 * binds (ROW_COLUMNS, so a later migration such as 0009 or 0010). Ingest refuses to write
 * without it: through the old triggers a full re-ingest reads ~46M rows
 * (FINDINGS B3).
 * @param {Query} query
 * @returns {Promise<SchemaStatus>}
 */
export async function schemaStatus(query) {
  /** @type {any} */
  let row = null;
  try {
    row = (await query(SCHEMA_SQL)).results[0] ?? null;
  } catch (err) {
    // No meta table (pre-0004): certainly not 0006. Any other failure (D1 down, a refused
    // token over REST) is not a schema answer, so it goes on up.
    if (!/no such table/i.test(String(/** @type {Error} */ (err)?.message))) throw err;
  }
  const version = row?.version == null ? null : Number(row.version);
  const ftsExternal = /content\s*=\s*'modules'/i.test(row?.fts ?? '');
  const rowidTriggers = /old\.rowid/i.test(row?.trig ?? '');
  const present = new Set(/** @type {string[]} */ (JSON.parse(row?.triggers ?? '[]')));
  const missingTriggers = REQUIRED_TRIGGERS.filter((t) => !present.has(t));
  const rowHashColumn = Number(row?.row_hash ?? 0) === 1;
  // Every column the upsert binds (Phase 4: 0009's ng_allow, ng_rules; 5A: 0010's exam_dates).
  const columns = new Set(/** @type {string[]} */ (JSON.parse(row?.columns ?? '[]')));
  const missingColumns = ROW_COLUMNS.filter((c) => !columns.has(c));
  return {
    version, ftsExternal, rowidTriggers, missingTriggers, rowHashColumn, missingColumns,
    ok: version !== null && version >= 6 && ftsExternal && rowidTriggers && missingTriggers.length === 0 && rowHashColumn
      && missingColumns.length === 0,
  };
}

/**
 * The /admin/hashes body:
 * `{ schema, embeddingModel, acadYears, modules: { code: { textHash, rowHash, ftsHash } } }`.
 * `ftsHash` (src/rowhash.js) hashes the stored code, title and description,
 * the columns the 0006 FTS update trigger watches, so ingest charges FTS
 * writes only to upserts that change them; text_hash cannot tell (it also
 * covers the model and the embedded-text version, PR #13 review).
 * `acadYears` counts D1's rows per acad year (`{}` for an empty database), so
 * ingest can refuse to rewrite a database to another year.
 * `modules` and `acadYears` are null when the schema check fails (the
 * row_hash column may not exist), and ingest and the guard refuse.
 * @param {Query} query
 * @param {{ embeddingModel: string }} o
 * @returns {Promise<AdminHashes>}
 */
export async function adminHashes(query, { embeddingModel }) {
  const schema = await schemaStatus(query);
  if (!schema.ok) return { schema, embeddingModel, acadYears: null, modules: null };
  const { results } = /** @type {{ results: {
    code: string, title: string, description: string, text_hash: string, row_hash: string | null, acad_year: string,
  }[] }} */ (await query(HASHES_SQL));
  const fts = await Promise.all(results.map((r) => ftsHash(r)));
  /** @type {Record<string, number>} */
  const acadYears = {};
  for (const r of results) acadYears[r.acad_year] = (acadYears[r.acad_year] ?? 0) + 1;
  return {
    schema, embeddingModel, acadYears,
    modules: Object.fromEntries(results.map((r, i) => [r.code, { textHash: r.text_hash, rowHash: r.row_hash, ftsHash: fts[i] }])),
  };
}
