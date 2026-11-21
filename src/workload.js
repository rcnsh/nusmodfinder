// @ts-check

/**
 * @typedef {{ lecture: number, tutorial: number, lab: number, project: number, prep: number, total: number }} Workload
 */

/**
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
