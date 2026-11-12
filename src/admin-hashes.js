// @ts-check
// What GET /admin/hashes answers, computed from `SELECT` results alone, so the Worker route
// (src/ingest.js handleHashes, over its D1 binding) and the deploy guard (scripts/guard.mjs,
// over Cloudflare's D1 REST query endpoint) run the same code over the same rows
// (test/admin-hashes-rest.test.js proves they agree). A query is any function from a
// statement and its params to `{ results }`: `d1Query(env.DB)` in the Worker, the REST client's
// `query` in Node. Read-only statements only. WebCrypto only: no bindings, no Node APIs.
//
// Every row's hash is recomputed from the row's own columns, with the functions ingest writes it
// with (src/rowhash.js rowHash, catalogueRowHash), never taken on trust from the stored row_hash:
// a row changed behind its row_hash (a hand `d1 execute`, an older writer, a
// one-table restore) is answered with rowHash null and named in rowHashDrift (catalogueDrift for
// catalogue_only), so the guard refuses it and the next ingest rewrites it. D1 bills rows, not
// columns, so reading every column reads as many rows as before.
import { ROW_COLUMNS, catalogueKey, catalogueRowHash, fieldsFromRow, ftsHash, rowHash } from './rowhash.js';

/**
 * One read: a statement and its params, answering D1's result shape.
 * @typedef {(sql: string, params?: unknown[]) => Promise<{ results: any[], meta?: { rows_read?: number } }>} Query
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, missingTriggers: string[],
 *   rowHashColumn: boolean, missingColumns: string[], ok: boolean,
 * }} SchemaStatus
 * @typedef {{ textHash: string, rowHash: string | null, ftsHash: string }} ModuleHashes `rowHash`: the stored
 *   row_hash when the row's columns hash to it, else null
 * @typedef {{
 *   schema: SchemaStatus, embeddingModel: string, acadYears: Record<string, number> | null,
 *   modules: Record<string, ModuleHashes> | null, rowHashDrift: string[] | null,
 *   catalogueKey: string | null, catalogueDrift: string[] | null,
 * }} AdminHashes `rowHashDrift` and `catalogueDrift`: the codes whose stored row_hash is missing or is not
 *   their columns' hash, sorted
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

/**
 * The hashes' one statement: every `modules` row with every column ingest binds (ROW_COLUMNS) and
 * row_hash (~6.8k rows read in production, as with fewer columns).
 */
export const HASHES_SQL = `SELECT ${ROW_COLUMNS.join(', ')}, row_hash FROM modules`;

/** Whether `catalogue_only` exists (migration 0008): one sqlite_master row. */
export const CATALOGUE_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalogue_only'";

/**
 * The catalogue's one statement: every `catalogue_only` row with the columns its row_hash covers
 * (~14.4k rows read in production).
 */
export const CATALOGUE_ROWS_SQL = 'SELECT code, title, description, acad_year, row_hash FROM catalogue_only';

/**
 * A catalogue_only row's hash as /admin/catalogue writes it, recomputed from its columns (the year
 * included); null when the stored row_hash is not it.
 * @param {{ code: string, title: string, description: string | null, acad_year: string, row_hash: string | null }} r
 */
export async function verifiedCatalogueHash(r) {
  const recomputed = await catalogueRowHash({ code: r.code, title: r.title, description: r.description ?? null, acadYear: r.acad_year });
  return r.row_hash === recomputed ? recomputed : null;
}

/**
 * A modules row's hash as /admin/ingest writes it (src/rowhash.js rowHash over fieldsFromRow),
 * recomputed from its columns; null when the stored row_hash is not it, or a column can't be read.
 * @param {import('./rowhash.js').ModuleRow} r
 */
export async function verifiedRowHash(r) {
  let recomputed;
  try { recomputed = await rowHash(fieldsFromRow(r)); } catch { return null; }
  return r.row_hash === recomputed ? recomputed : null;
}

/**
 * The catalogueKey (src/rowhash.js) of D1's catalogue_only codes: what the deploy
 * guard, rollback and verify --pre-deploy compare with the bundled catalogue file's
 * (data/catalogue-codes.json) or a deploy tag's; and the codes whose row_hash is not their columns'
 * Nulls without the table. `result` is the rows read's, for its meta.
 * @param {Query} query
 * @returns {Promise<{ key: string | null, drift: string[] | null, result: Awaited<ReturnType<Query>> | null }>}
 */
export async function storedCatalogueKey(query) {
  if (!(await query(CATALOGUE_TABLE_SQL)).results.length) return { key: null, drift: null, result: null };
  const result = await query(CATALOGUE_ROWS_SQL);
  const rows = /** @type {{ code: string, title: string, description: string | null, acad_year: string, row_hash: string | null }[]} */ (result.results);
  const verified = await Promise.all(rows.map((r) => verifiedCatalogueHash(r)));
  return {
    key: await catalogueKey(rows.map((r) => r.code)),
    drift: rows.filter((_, i) => verified[i] === null).map((r) => r.code).sort(),
    result,
  };
}

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
 * without it: through the old triggers a full re-ingest reads ~46M rows.
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
  // Every column the upsert binds (0009's ng_allow and ng_rules, 0010's exam_dates among them).
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
 * `{ schema, embeddingModel, acadYears, modules: { code: { textHash, rowHash, ftsHash } }, rowHashDrift, catalogueKey, catalogueDrift }`.
 * `rowHash` is recomputed from the row's columns (verifiedRowHash): the stored row_hash when they
 * hash to it, else null, and the code is in `rowHashDrift`. Ingest then rewrites the row (its
 * corpus hash differs from null), and the guard refuses until it has.
 * `ftsHash` (src/rowhash.js) hashes the stored code, title and description,
 * the columns the 0006 FTS update trigger watches, so ingest charges FTS
 * writes only to upserts that change them; text_hash cannot tell (it also
 * covers the model and the embedded-text version).
 * `acadYears` counts D1's rows per acad year (`{}` for an empty database), so
 * ingest can refuse to rewrite a database to another year.
 * `modules`, `rowHashDrift` and `acadYears` are null when the schema check fails (the
 * row_hash column may not exist), and ingest and the guard refuse.
 * `catalogueKey` and `catalogueDrift` are storedCatalogueKey's, null with the modules.
 * @param {Query} query
 * @param {{ embeddingModel: string }} o
 * @returns {Promise<AdminHashes>}
 */
export async function adminHashes(query, { embeddingModel }) {
  const schema = await schemaStatus(query);
  if (!schema.ok) return { schema, embeddingModel, acadYears: null, modules: null, rowHashDrift: null, catalogueKey: null, catalogueDrift: null };
  const { results } = /** @type {{ results: import('./rowhash.js').ModuleRow[] }} */ (await query(HASHES_SQL));
  const [fts, verified] = await Promise.all([Promise.all(results.map((r) => ftsHash(r))), Promise.all(results.map((r) => verifiedRowHash(r)))]);
  /** @type {Record<string, number>} */
  const acadYears = {};
  for (const r of results) acadYears[r.acad_year] = (acadYears[r.acad_year] ?? 0) + 1;
  const catalogue = await storedCatalogueKey(query);
  return {
    schema, embeddingModel, acadYears,
    modules: Object.fromEntries(results.map((r, i) => [r.code, { textHash: r.text_hash, rowHash: verified[i], ftsHash: fts[i] }])),
    rowHashDrift: results.filter((_, i) => verified[i] === null).map((r) => r.code).sort(),
    catalogueKey: catalogue.key, catalogueDrift: catalogue.drift,
  };
}
