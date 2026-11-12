// @ts-check
// Reference reading of the cohort-only prerequisite rule
// (eval/query-rules/cohort-only-prereq.json). The ingest derives
// `prereq_cohort_only` from the same rule (mirrored in data/cohort-only-prereq.json);
// this module gives it one executable reading that the query-rule tests and
// the corpus count share.
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
