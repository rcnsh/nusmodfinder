// @ts-check
import { ROW_COLUMNS, catalogueKey, catalogueRowHash, fieldsFromRow, ftsHash, rowHash } from './rowhash.js';

/**
 * @typedef {(sql: string, params?: unknown[]) => Promise<{ results: any[], meta?: { rows_read?: number } }>} Query
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, missingTriggers: string[],
 *   rowHashColumn: boolean, missingColumns: string[], ok: boolean,
 * }} SchemaStatus
 * @typedef {{ textHash: string, rowHash: string | null, ftsHash: string }} ModuleHashes
 * @typedef {{
 *   schema: SchemaStatus, embeddingModel: string, acadYears: Record<string, number> | null,
 *   modules: Record<string, ModuleHashes> | null, rowHashDrift: string[] | null,
 *   catalogueKey: string | null, catalogueDrift: string[] | null,
 * }} AdminHashes
 */

export const REQUIRED_TRIGGERS = ['modules_fts_insert', 'modules_fts_delete', 'modules_fts_update', 'modules_rowid_immutable'];

export const SCHEMA_SQL = `SELECT (SELECT value FROM meta WHERE key = 'schema') AS version,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts') AS fts,
              (SELECT sql FROM sqlite_master WHERE name = 'modules_fts_update') AS trig,
              (SELECT json_group_array(name) FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'modules') AS triggers,
              (SELECT count(*) FROM pragma_table_info('modules') WHERE name = 'row_hash') AS row_hash,
              (SELECT json_group_array(name) FROM pragma_table_info('modules')) AS columns`;

export const HASHES_SQL = `SELECT ${ROW_COLUMNS.join(', ')}, row_hash FROM modules`;

export const CATALOGUE_TABLE_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalogue_only'";

export const CATALOGUE_ROWS_SQL = 'SELECT code, title, description, acad_year, row_hash FROM catalogue_only';

/** @param {{ code: string, title: string, description: string | null, acad_year: string, row_hash: string | null }} r */
export async function verifiedCatalogueHash(r) {
  const recomputed = await catalogueRowHash({ code: r.code, title: r.title, description: r.description ?? null, acadYear: r.acad_year });
  return r.row_hash === recomputed ? recomputed : null;
}

/** @param {import('./rowhash.js').ModuleRow} r */
export async function verifiedRowHash(r) {
  let recomputed;
  try { recomputed = await rowHash(fieldsFromRow(r)); } catch { return null; }
  return r.row_hash === recomputed ? recomputed : null;
}

/**
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
 * @param {{ prepare: (sql: string) => { bind: (...values: unknown[]) => { all: () => Promise<any> } } }} db
 * @returns {Query}
 */
export const d1Query = (db) => (sql, params = []) => db.prepare(sql).bind(...params).all();

/**
 * @param {Query} query
 * @returns {Promise<SchemaStatus>}
 */
export async function schemaStatus(query) {
  /** @type {any} */
  let row = null;
  try {
    row = (await query(SCHEMA_SQL)).results[0] ?? null;
  } catch (err) {
    if (!/no such table/i.test(String(/** @type {Error} */ (err)?.message))) throw err;
  }
  const version = row?.version == null ? null : Number(row.version);
  const ftsExternal = /content\s*=\s*'modules'/i.test(row?.fts ?? '');
  const rowidTriggers = /old\.rowid/i.test(row?.trig ?? '');
  const present = new Set(/** @type {string[]} */ (JSON.parse(row?.triggers ?? '[]')));
  const missingTriggers = REQUIRED_TRIGGERS.filter((t) => !present.has(t));
  const rowHashColumn = Number(row?.row_hash ?? 0) === 1;
  const columns = new Set(/** @type {string[]} */ (JSON.parse(row?.columns ?? '[]')));
  const missingColumns = ROW_COLUMNS.filter((c) => !columns.has(c));
  return {
    version, ftsExternal, rowidTriggers, missingTriggers, rowHashColumn, missingColumns,
    ok: version !== null && version >= 6 && ftsExternal && rowidTriggers && missingTriggers.length === 0 && rowHashColumn
      && missingColumns.length === 0,
  };
}

/**
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
