// @ts-check
// Phase 6 6A (docs/plans/phase6.md §3 "6A"): the NG-listed codes with no
// classes this year. NUS lists them for exchange students, NUSMods has no
// offering for them, so D1 has no `modules` row (only a `catalogue_only` one,
// which holds no units, faculty or restrictions). This file holds each one's
// fields and the allow mask and rule ids ingest would store for a row, so
// /module/:code answers it like a row with no classes.
//
// Pure, like src/groups.js: scripts/build-ng-unscheduled.mjs writes the file
// (data/ng-unscheduled.json, test/fixtures/ng-unscheduled.json), and the
// Worker reads it through src/ng-unscheduled.js, by the bare name
// `ng-unscheduled-data`.

/** The file's schema; bump on a change to its shape. */
export const NG_UNSCHEDULED_SCHEMA = 'vnm-ng-unscheduled/1';

/**
 * One NG-listed code with no offered row: the fields a row has, its workload
 * as /module/:code answers it (src/workload.js), its group's other codes
 * (groups-v1 over the offered rows plus the file's codes), and what
 * src/eligibility.js storedEligibility gives it with the year's rules.
 * @typedef {{
 *   code: string, title: string, description: string, credits: number | null, faculty: string | null,
 *   department: string | null, level: number | null, ngSemesters: number[],
 *   workload: import('./workload.js').Workload | { raw: string } | null,
 *   prerequisite: string | null, preclusion: string | null, gradingBasis: string | null,
 *   otherCodes: string[], ngAllow: number, ngRules: Record<string, string[]> | null,
 * }} NgUnscheduledEntry
 * @typedef {'production' | 'pinned' | 'fixture'} NgUnscheduledCorpus
 * @typedef {{
 *   schema: string, generator: string, corpus: NgUnscheduledCorpus, acadYear: string, dataVersion: string,
 *   groups: string, count: number, modules: NgUnscheduledEntry[],
 * }} NgUnscheduledFile
 */

/** The file's bytes: one entry per line. @param {NgUnscheduledFile} f */
export function serializeNgUnscheduled(f) {
  const { modules, ...head } = f;
  const body = modules.map((e) => `  ${JSON.stringify(e)}`).join(',\n');
  return `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "modules": [${modules.length ? `\n${body}\n ` : ''}]\n}\n`;
}

/**
 * Code -> entry, after checking the schema.
 * @param {NgUnscheduledFile} f
 * @returns {Map<string, NgUnscheduledEntry>}
 */
export function parseNgUnscheduled(f) {
  if (f?.schema !== NG_UNSCHEDULED_SCHEMA) throw new Error(`ng-unscheduled file: schema ${f?.schema}, expected ${NG_UNSCHEDULED_SCHEMA}`);
  return new Map(f.modules.map((e) => [e.code, e]));
}
