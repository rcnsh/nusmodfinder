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
export const NORMALISER_VERSION = 2;

/**
 * The fields of one module that D1 stores and Vectorize filters on.
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null,
 *   department: string | null, faculty: string | null, level: number | null,
 *   semesters: number[], workload: string | null, prerequisite: string | null,
 *   preclusion: string | null, acadYear: string, textHash: string,
 *   ng: boolean, ngSemesters?: number[],
 *   examSemesters?: number[], su?: boolean, gradingBasis?: string | null, workloadHours?: number | null,
 *   prereqNone?: boolean, prereqCohortOnly?: boolean,
 *   ngAllow?: number, ngRules?: Record<string, string[]> | null,
 *   examDates?: ExamDate[],
 * }} RowFields
 *   The 3H-0 fields (plan 3H "Data") are optional for callers that build
 *   rows by hand (tests); a missing one is written as its neutral value.
 *   So are Phase 4's: a missing ngAllow is 0, closed everywhere (plan §2),
 *   and 5A's: missing examDates is [], no exam.
 * @typedef {{ sem: number, date: string, durationMins: number | null }} ExamDate
 *   One exam (Phase 5 5A, migrations/0010_exam_dates.sql): the semester, the
 *   date as moduleInfo gives it (ISO UTC) and the duration in minutes.
 */

/**
 * The `modules` columns /admin/ingest writes, in bind order (row_hash last).
 */
export const ROW_COLUMNS = ['code', 'title', 'description', 'credits', 'department', 'faculty', 'level',
  'semesters', 'workload', 'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters',
  'exam_semesters', 'su', 'grading_basis', 'workload_hours', 'prereq_none', 'prereq_cohort_only',
  'ng_allow', 'ng_rules', 'exam_dates'];

/**
 * The upsert's SET list (src/ingest.js writeRows): every ROW_COLUMNS column
 * but the key, plus row_hash, so a new column can't keep its old value under a
 * new hash (docs/plans/phase4.md §5).
 */
export const UPSERT_SET = [...ROW_COLUMNS.filter((c) => c !== 'code'), 'row_hash'].map((c) => `${c}=excluded.${c}`).join(', ');

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
    JSON.stringify(m.examSemesters ?? []), m.su ? 1 : 0, m.gradingBasis ?? null, m.workloadHours ?? null,
    m.prereqNone ? 1 : 0, m.prereqCohortOnly ? 1 : 0,
    m.ngAllow ?? 0, m.ngRules ? JSON.stringify(m.ngRules) : null,
    JSON.stringify(m.examDates ?? []),
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
 * A catalogue_only row (migrations/0008_catalogue.sql) as /admin/catalogue
 * writes it and ingest compares it: the hash of exactly the bound values.
 * @param {{ code: string, title: string, description: string | null, acadYear: string }} r
 * @returns {Promise<string>} 32 hex characters
 */
export async function catalogueRowHash(r) {
  return (await sha256Hex(JSON.stringify(['catalogue/1', r.code, r.title, r.description ?? null, r.acadYear]))).slice(0, 32);
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
 *   ng_semesters: string | null, exam_semesters: string | null, su: number, grading_basis: string | null,
 *   workload_hours: number | null, prereq_none: number, prereq_cohort_only: number,
 *   ng_allow?: number | null, ng_rules?: string | null, exam_dates?: string | null, row_hash?: string | null,
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
    examSemesters: JSON.parse(row.exam_semesters ?? '[]'), su: row.su === 1, gradingBasis: row.grading_basis,
    workloadHours: row.workload_hours, prereqNone: row.prereq_none === 1, prereqCohortOnly: row.prereq_cohort_only === 1,
    ngAllow: row.ng_allow ?? 0, ngRules: row.ng_rules ? JSON.parse(row.ng_rules) : null,
    examDates: JSON.parse(row.exam_dates ?? '[]'),
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

/**
 * Phase 7 7D: the key of a catalogue, over its catalogue-only codes alone, so
 * it can be read from D1 `catalogue_only` (GET /admin/hashes, the deploy
 * guard, rollback) and computed from a corpus or the bundled catalogue file
 * (`catalogue-codes-data`) alike. The codes search answers `not-offered` for
 * are the bundled file's; the titles it names are D1's. Order and duplicates
 * do not count.
 * @param {Iterable<string>} codes
 * @returns {Promise<string>} 12 hex characters
 */
export async function catalogueKey(codes) {
  return (await sha256Hex(['catalogue-key/1', ...[...new Set(codes)].sort()].join('\n'))).slice(0, 12);
}
