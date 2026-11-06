// @ts-check
// Reference reading of the P-6 cohort-only prerequisite rule
// (eval/prereg/cohort-only-prereq.json). 3H-0 derives `prereq_cohort_only`
// from the same JSON; this module exists so the rule has one executable
// reading that the P-6 tests and the corpus count share.
import { readFileSync } from 'node:fs';

/** @type {any} */
export const COHORT_ONLY = JSON.parse(readFileSync(new URL('./cohort-only-prereq.json', import.meta.url), 'utf8'));

/**
 * @param {string | null | undefined} prerequisite
 * @param {any} [spec]
 * @returns {boolean} true iff the text is only a cohort or programme restriction (NULL is false)
 */
export function isCohortOnly(prerequisite, spec = COHORT_ONLY) {
  if (prerequisite === null || prerequisite === undefined || prerequisite.trim() === '') return false;
  let s = prerequisite;
  for (const n of spec.normalise) s = s.replace(new RegExp(n.find, n.flags), n.replace);
  for (const r of spec.remove) s = s.replace(new RegExp(r.pattern, r.flags), ' ');
  return new RegExp(spec.remainder, spec.remainderFlags).test(s);
}
