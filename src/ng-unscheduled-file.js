// @ts-check

export const NG_UNSCHEDULED_SCHEMA = 'vnm-ng-unscheduled/1';

/**
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null, faculty: string | null,
 *   department: string | null, level: number | null, ngSemesters: number[],
 *   workload: import('./workload.js').Workload | { raw: string } | null,
 *   prerequisite: string | null, preclusion: string | null, gradingBasis: string | null,
 *   otherCodes: string[], ngAllow: number, ngRules: Record<string, string[]> | null,
 *   ngUnpublished?: number[],
 * }} NgUnscheduledEntry
 * @typedef {'production' | 'pinned' | 'fixture'} NgUnscheduledCorpus
 * @typedef {{
 *   schema: string, generator: string, corpus: NgUnscheduledCorpus, acadYear: string, dataVersion: string,
 *   groups: string, count: number, modules: NgUnscheduledEntry[],
 * }} NgUnscheduledFile
 */

/** @param {NgUnscheduledFile} f */
export function serializeNgUnscheduled(f) {
  const { modules, ...head } = f;
  const body = modules.map((e) => `  ${JSON.stringify(e)}`).join(',\n');
  return `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "modules": [${modules.length ? `\n${body}\n ` : ''}]\n}\n`;
}

/**
 * @param {NgUnscheduledFile} f
 * @returns {Map<string, NgUnscheduledEntry>}
 */
export function parseNgUnscheduled(f) {
  if (f?.schema !== NG_UNSCHEDULED_SCHEMA) throw new Error(`ng-unscheduled file: schema ${f?.schema}, expected ${NG_UNSCHEDULED_SCHEMA}`);
  return new Map(f.modules.map((e) => [e.code, e]));
}
