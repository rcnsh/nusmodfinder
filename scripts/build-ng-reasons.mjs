// @ts-check
// Builds data/ng-reasons.json, the Worker's reason texts for exchange mode
// (docs/plans/phase4.md §2 "Storage"): one entry per rule id ingest can store
// in ng_rules (src/eligibility.js's built-ins plus every closed and note rule
// in data/ng-restrictions-<year>.json), and the source documents with their
// dates for /facets. D1 stores ids only, so a wording edit here rewrites no
// rows. Phase 6 6A: also NUS's rules about courses off the exchange list (the
// rules file's info entries with a `text`), with the scope each states, for
// /facets' `offListRules`. Deterministic; test/ng-reasons.node.test.js fails when the committed
// file differs from a rebuild. Usage: node scripts/build-ng-reasons.mjs
import { writeFileSync } from 'node:fs';
import { GRAD_LEVELS, NOT_NG_IN_SEM, OFF_NG_LIST, SEMESTER_MISMATCH } from '../src/eligibility.js';
import { DEFAULT_ACAD_YEAR, loadNgRestrictions } from './lib.mjs';

const OUT = new URL('../data/ng-reasons.json', import.meta.url);
const NG_PAGE = 'https://www.nus.edu.sg/registrar/prospective-students/non-graduating';

/** The NG list and rule D, which src/eligibility.js applies itself. */
const BUILT_IN = {
  [OFF_NG_LIST]: { kind: 'closed', text: 'Not on the Registrar\'s list of courses offered to exchange students.', cite: 'NG course list' },
  [NOT_NG_IN_SEM]: { kind: 'closed', text: 'Offered to exchange students only in the other semester.', cite: 'NG course list' },
  [SEMESTER_MISMATCH]: {
    kind: 'semester',
    text: 'The NG list offers it to exchange students in this semester, but NUSMods shows no classes for it then. Ask the department that teaches it whether it will run.',
    cite: 'NG course list; NUSMods',
  },
  // The PDF: "NOT available to exchange students unless specified in the list below" (the
  // restrictions list itself), so the text names no department approval it doesn't give. The list
  // can open a course to some years of study only (1-sea-l5-yr4-pg), so the text says "yours".
  [GRAD_LEVELS]: {
    kind: 'closed',
    text: 'Level 5000 and 6000 courses are graduate courses. Exchange students can take one only if NUS\'s restrictions list opens it to their year of study, and the list doesn\'t open this one to yours. If you need it, ask the department that teaches it.',
    cite: 'restrictions PDF §D',
  },
};

/** @param {string} acadYear */
export function buildNgReasons(acadYear) {
  const rules = /** @type {import('../src/eligibility.js').Rules & { rules: { id: string, effect: string, note?: string, reason: string, cite?: string }[],
    info?: { id: string, text?: string, scope?: Record<string, unknown> }[] }} */ (loadNgRestrictions(acadYear));
  /** @type {Record<string, { kind: string, text: string, cite: string }>} */
  const reasons = { ...BUILT_IN };
  for (const r of rules.rules) {
    if (r.effect !== 'closed' && r.effect !== 'note') continue;
    if (reasons[r.id]) throw new Error(`ng-reasons: duplicate id ${r.id}`);
    reasons[r.id] = { kind: r.effect === 'closed' ? 'closed' : r.note ?? 'note', text: r.reason, cite: r.cite ?? 'restrictions PDF' };
  }
  return {
    acadYear,
    generator: 'scripts/build-ng-reasons.mjs',
    // docs/evidence/phase4/sources.md: the documents and their "updated as at" dates.
    sources: [
      { name: 'Courses offered to exchange (NG) students', updatedAsAt: '01 Sep 2026', url: NG_PAGE },
      { name: 'Course restrictions for exchange (NG) students', updatedAsAt: '31 Aug 2026', url: NG_PAGE },
    ],
    reasons,
    offListRules: (rules.info ?? []).filter((i) => i.text !== undefined).map((i) => ({ id: i.id, text: i.text, scope: i.scope ?? {} })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(OUT, `${JSON.stringify(buildNgReasons(DEFAULT_ACAD_YEAR), null, 1)}\n`);
  console.log(`wrote ${OUT.pathname}`);
}
