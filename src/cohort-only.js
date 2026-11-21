// @ts-check

/**
 * @typedef {{ normalise: { find: string, flags: string, replace: string }[], remove: { pattern: string, flags: string }[],
 *   remainder: string, remainderFlags: string }} CohortOnlySpec
 */

/**
 * @param {string | null | undefined} prerequisite
 * @param {CohortOnlySpec} spec
 * @returns {boolean}
 */
export function isCohortOnly(prerequisite, spec) {
  if (prerequisite === null || prerequisite === undefined || prerequisite.trim() === '') return false;
  let s = prerequisite;
  for (const n of spec.normalise) s = s.replace(new RegExp(n.find, n.flags), n.replace);
  for (const r of spec.remove) s = s.replace(new RegExp(r.pattern, r.flags), ' ');
  return new RegExp(spec.remainder, spec.remainderFlags).test(s);
}
