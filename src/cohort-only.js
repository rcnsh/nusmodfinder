// @ts-check
// `prereq_cohort_only`: a prerequisite text that is only a cohort or
// programme restriction, by the pattern list
// (eval/query-rules/cohort-only-prereq.json, mirrored into
// data/cohort-only-prereq.json by scripts/build-catalogue-data.mjs, since the eval
// workspace and the Worker cannot read eval/). The same reading as
// eval/query-rules/cohort-only.mjs; test/intents-data.node.test.js holds them equal.

/**
 * @typedef {{ normalise: { find: string, flags: string, replace: string }[], remove: { pattern: string, flags: string }[],
 *   remainder: string, remainderFlags: string }} CohortOnlySpec
 */

/**
 * @param {string | null | undefined} prerequisite
 * @param {CohortOnlySpec} spec
 * @returns {boolean} true iff the text is only a cohort or programme restriction (NULL is false)
 */
export function isCohortOnly(prerequisite, spec) {
  if (prerequisite === null || prerequisite === undefined || prerequisite.trim() === '') return false;
  let s = prerequisite;
  for (const n of spec.normalise) s = s.replace(new RegExp(n.find, n.flags), n.replace);
  for (const r of spec.remove) s = s.replace(new RegExp(r.pattern, r.flags), ' ');
  return new RegExp(spec.remainder, spec.remainderFlags).test(s);
}
