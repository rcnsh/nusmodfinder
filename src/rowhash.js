// @ts-check

export const NORMALISER_VERSION = 2;

/**
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
 * @typedef {{ sem: number, date: string, durationMins: number | null }} ExamDate
 */

export const ROW_COLUMNS = ['code', 'title', 'description', 'credits', 'department', 'faculty', 'level',
  'semesters', 'workload', 'prerequisite', 'preclusion', 'acad_year', 'text_hash', 'ng', 'ng_semesters',
  'exam_semesters', 'su', 'grading_basis', 'workload_hours', 'prereq_none', 'prereq_cohort_only',
  'ng_allow', 'ng_rules', 'exam_dates'];

export const UPSERT_SET = [...ROW_COLUMNS.filter((c) => c !== 'code'), 'row_hash'].map((c) => `${c}=excluded.${c}`).join(', ');

/**
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

/** @param {RowFields} m */
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

/** @param {RowFields} m */
export function storedVectorMetadata(m) {
  return { ...vectorMetadata(m), textHash: m.textHash };
}

/**
 * @param {RowFields} m
 * @returns {Record<string, string | number | boolean>}
 */
export function vectorizeMetadata(m) {
  /** @type {Record<string, string | number | boolean>} */
  const out = {};
  for (const [k, v] of Object.entries(storedVectorMetadata(m))) if (v !== null) out[k] = v;
  return out;
}

/** @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {RowFields} m
 * @returns {Promise<string>}
 */
export async function rowHash(m) {
  return (await sha256Hex(JSON.stringify([NORMALISER_VERSION, boundTuple(m), vectorMetadata(m)]))).slice(0, 32);
}

/**
 * @param {{ code: string, title: string, description: string | null, acadYear: string }} r
 * @returns {Promise<string>}
 */
export async function catalogueRowHash(r) {
  return (await sha256Hex(JSON.stringify(['catalogue/1', r.code, r.title, r.description ?? null, r.acadYear]))).slice(0, 32);
}

export const FTS_COLUMNS = /** @type {const} */ (['code', 'title', 'description']);

/**
 * @param {{ code: string, title: string, description: string }} m
 * @returns {Promise<string>}
 */
export async function ftsHash(m) {
  return (await sha256Hex(JSON.stringify([m.code, m.title, m.description]))).slice(0, 32);
}

/**
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
 * @param {{ code: string, rowHash: string }[]} rows
 * @returns {Promise<string>}
 */
export async function dataVersion(rows) {
  const lines = rows.map((r) => `${r.code} ${r.rowHash}`).sort();
  return (await sha256Hex(lines.join('\n'))).slice(0, 12);
}

/**
 * @param {Iterable<string>} codes
 * @returns {Promise<string>}
 */
export async function catalogueKey(codes) {
  return (await sha256Hex(['catalogue-key/1', ...[...new Set(codes)].sort()].join('\n'))).slice(0, 12);
}
