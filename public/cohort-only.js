// @ts-check
// The cohort-only prerequisite rule (3H-0 P-6), for the page (Phase 5 5C). The
// detail says "No course prerequisite" when a rule names only NUS intake years
// or programmes; /module/:code does not answer prereq_cohort_only, so the page
// reads the text with the same rule ingest uses. COHORT_ONLY mirrors
// data/cohort-only-prereq.json and isCohortOnly is src/cohort-only.js;
// test/web/format.node.test.js holds the copy equal to the data and the result
// equal to ingest on every fixture course.

/**
 * @typedef {{ normalise: { find: string, flags: string, replace: string }[], remove: { pattern: string, flags: string }[],
 *   remainder: string, remainderFlags: string }} CohortOnlySpec
 */

export const COHORT_ONLY = Object.freeze({
  "schema": "vnm-3h-cohort-only/1",
  "from": "eval/prereg/cohort-only-prereq.json (P-6, unchanged)",
  "normalise": [
    {
      "find": "(THEN|AND|OR)",
      "flags": "g",
      "replace": " $1 ",
      "why": "EduRec glues connectors to words (DegreeTHENmust, (Hons)ANDmust); upper-case only, so programme names are untouched"
    },
    {
      "find": "\\s+",
      "flags": "g",
      "replace": " ",
      "why": "collapse whitespace"
    }
  ],
  "remove": [
    {
      "name": "degree-wrapper",
      "pattern": "\\b(?:if|must be) undertaking an? (?:undergraduate degree|graduate degree(?: coursework| research)?)\\b(?: then\\b)?",
      "flags": "gi",
      "why": "the degree-type condition every rule starts with; a degree type is a programme restriction"
    },
    {
      "name": "cohort",
      "pattern": "\\bmust (?:not )?be in one of the cohorts (?:from|to|prior to|after|before|between) \\d{4}(?: (?:and|to) \\d{4})?(?: inclusive)?",
      "flags": "gi",
      "why": "a matriculation-cohort restriction"
    },
    {
      "name": "programme",
      "pattern": "\\bmust (?:not )?be undertaking (?:1 of )?\\d{4}[A-Z0-9]{2,}\\b.*?(?=\\s*\\)*\\s*(?:\\b(?:and|or)\\b\\s*\\(*\\s*(?:must|the student|if)\\b|$))",
      "flags": "gi",
      "why": "a programme restriction: one programme code (e.g. 0200ACCHON) or a list of them, up to the next clause"
    }
  ],
  "remainder": "^[\\s()]*(?:(?:and|or|then)\\b[\\s()]*)*$",
  "remainderFlags": "i"
});

/**
 * @param {string | null | undefined} prerequisite
 * @param {CohortOnlySpec} [spec]
 * @returns {boolean} true iff the text is only a cohort or programme restriction (null is false)
 */
export function isCohortOnly(prerequisite, spec = COHORT_ONLY) {
  if (prerequisite === null || prerequisite === undefined || prerequisite.trim() === '') return false;
  let s = prerequisite;
  for (const n of spec.normalise) s = s.replace(new RegExp(n.find, n.flags), n.replace);
  for (const r of spec.remove) s = s.replace(new RegExp(r.pattern, r.flags), ' ');
  return new RegExp(spec.remainder, spec.remainderFlags).test(s);
}
