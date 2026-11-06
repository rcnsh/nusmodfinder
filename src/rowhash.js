// @ts-check
// What ingest compares to decide what to write (FINDINGS B2), shared by the
// Worker (src/ingest.js) and the Node scripts (scripts/ingest-core.mjs,
// scripts/lib.mjs), so both sides hash the same bytes. WebCrypto only: no
// bindings, no Node APIs.
//
// row_hash = sha256(normaliser version + the exact tuple /admin/ingest binds
// into `modules` + the Vectorize metadata), so any field D1 stores or
// Vectorize filters on changes it: semesters, NG flags, credits, prereqs, the
// text hash. text_hash (scripts/lib.mjs) covers only what is embedded.

/**
 * Bump when normalise() (scripts/lib.mjs) changes what it derives from a
 * NUSMods record without the derived values themselves changing shape, so
 * every row is rewritten once.
 */
export const NORMALISER_VERSION = 1;

/**
 * The fields of one module that D1 stores and Vectorize filters on.
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: number[], workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acadYear: string, textHash: string,
 *   ng: boolean, ngSemesters?: number[],
 * }} RowFields
 */

/**
 * The `modules` columns /admin/ingest writes, in bind order (row_hash last).
 */
export const ROW_COLUMNS = ['code', 'title', 'description', 'credits', 'department', 'faculty', 'level',
  'semesters', 'workload', 'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters'];

/**
 * Exactly the values /admin/ingest binds for ROW_COLUMNS, in order.
 * @param {RowFields} m
 * @returns {(string | number | null)[]}
 */
export function boundTuple(m) {
  return [
    m.code, m.title, m.description, m.credits, m.department, m.faculty, m.level,
    JSON.stringify(m.semesters), m.workload, m.prerequisite, m.preclusion, m.acadYear, m.textHash,
    m.ng ? 1 : 0, JSON.stringify(m.ngSemesters ?? []),
  ];
}

/**
 * The Vectorize metadata for a module: the properties /search filters on.
 * @param {RowFields} m
 */
export function vectorMetadata(m) {
  return {
    code: m.code,
    sem1: m.semesters.includes(1),
    sem2: m.semesters.includes(2),
    sem3: m.semesters.includes(3),
    sem4: m.semesters.includes(4),
    level: m.level,
    credits: m.credits,
    faculty: m.faculty ?? '',
    ng: m.ng === true,
  };
}

/**
 * Everything stored with a module's vector: the filter properties above plus
 * `textHash`, which names the text the vector's values embed, so a reader can
 * tell whether stored values are still the right ones (ingest's row-only
 * reuse, verify). Never a metadata index: /search does not filter on it. Not
 * in row_hash separately: textHash is already in the bound tuple.
 * @param {RowFields} m
 */
export function storedVectorMetadata(m) {
  return { ...vectorMetadata(m), textHash: m.textHash };
}

/** @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {RowFields} m
 * @returns {Promise<string>} 32 hex characters
 */
export async function rowHash(m) {
  return (await sha256Hex(JSON.stringify([NORMALISER_VERSION, boundTuple(m), vectorMetadata(m)]))).slice(0, 32);
}

/**
 * The columns the 0006 FTS update trigger watches, in its order: it fires
 * only when `code`, `title` or `description` differs (`IS NOT`, byte
 * equality) between the old and the new row. /admin/hashes reports this hash
 * of the stored columns, and ingest compares it with the corpus's to know
 * whether an upsert writes FTS rows. text_hash cannot tell: it also covers
 * the embedding model, the embedded-text version and text built from more
 * than these columns.
 */
export const FTS_COLUMNS = /** @type {const} */ (['code', 'title', 'description']);

/**
 * @param {{ code: string, title: string, description: string }} m
 * @returns {Promise<string>} 32 hex characters
 */
export async function ftsHash(m) {
  return (await sha256Hex(JSON.stringify([m.code, m.title, m.description]))).slice(0, 32);
}

/**
 * A `modules` row as D1 returns it.
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: string | null, workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acad_year: string, text_hash: string, ng: number,
 *   ng_semesters: string | null, row_hash?: string | null,
 * }} ModuleRow
 */

/**
 * The fields a stored row was written from, so its row_hash can be
 * recomputed (verify) and its Vectorize metadata re-derived.
 * @param {ModuleRow} row
 * @returns {RowFields}
 */
export function fieldsFromRow(row) {
  return {
    code: row.code, title: row.title, description: row.description, credits: row.credits,
    department: row.department, faculty: row.faculty, level: row.level,
    semesters: JSON.parse(row.semesters ?? '[]'), workload: row.workload,
    prerequisite: row.prerequisite, preclusion: row.preclusion, acadYear: row.acad_year,
    textHash: row.text_hash, ng: row.ng === 1, ngSemesters: JSON.parse(row.ng_semesters ?? '[]'),
  };
}

/**
 * The cache-key data version (src/data-version.json, `DATA_VERSION` in
 * search.js) for a set of ingested rows: a hash of every code with its
 * row_hash, so it changes exactly when what D1 serves changes.
 * @param {{ code: string, rowHash: string }[]} rows
 * @returns {Promise<string>} 12 hex characters
 */
export async function dataVersion(rows) {
  const lines = rows.map((r) => `${r.code} ${r.rowHash}`).sort();
  return (await sha256Hex(lines.join('\n'))).slice(0, 12);
}
