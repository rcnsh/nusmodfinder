// @ts-check
// The workload /module/:code answers. Pure: no bindings, no JSON
// imports, so the Node tests import it as the Worker does.

/**
 * @typedef {{ lecture: number, tutorial: number, lab: number, project: number, prep: number, total: number }} Workload
 */

/**
 * The workload /module/:code answers, from the stored `workload` column
 * (the JSON of moduleInfo's value): NUSMods' 5-number array as named hours a
 * week with their total; `{ raw }` when moduleInfo gives anything else (two
 * modules give a string such as `3-.5-0--0-6.5`, which has six parts); null
 * when it is not listed: absent, or all zero. The total is the column
 * workload_hours (scripts/lib.mjs workloadHours) wherever that is not null.
 * @param {string | null} stored
 * @returns {Workload | { raw: string } | null}
 */
export function moduleWorkload(stored) {
  if (stored === null) return null;
  const value = JSON.parse(stored);
  if (!Array.isArray(value) || value.length !== 5 || !value.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0)) {
    return { raw: typeof value === 'string' ? value : stored };
  }
  const total = value.reduce((sum, x) => sum + x, 0);
  if (total === 0) return null;
  const [lecture, tutorial, lab, project, prep] = value;
  return { lecture, tutorial, lab, project, prep, total };
}
