// @ts-check
// Builds data/ng-reasons.json, the Worker's reason texts for exchange mode
// one entry per rule id ingest can store
// in ng_rules (src/eligibility.js's built-ins plus every closed and note rule
// in data/ng-restrictions-<year>.json), and the source documents with their
// dates for /facets. D1 stores ids only, so a wording edit here rewrites no
// rows. It also holds NUS's rules about courses off the exchange list (the
// rules file's info entries with a `text`), with the scope each states, for
// /facets' `offListRules`. Deterministic; test/ng-reasons.node.test.js fails when the committed
// file differs from a rebuild. Usage: node scripts/build-ng-reasons.mjs
//
// The documents' dates come from the year's source manifest (data/ng-sources-<year>.json),
// the off-list rule's role (`off-list-rule`, rule E) from the year's overlay module, and the two
// unpublished-semester reasons (a semester NUS hasn't published) are worded from the year.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GRAD_LEVELS, NOT_NG_IN_SEM, OFF_NG_LIST, SEMESTER_MISMATCH, UNPUBLISHED_SEM, UNPUBLISHED_UNLISTED } from '../src/eligibility.js';
import { rolesOf } from './build-ng-restrictions.mjs';
import { DEFAULT_ACAD_YEAR, loadNgRestrictions } from './lib.mjs';
import { documentOf, latestRevision, previousYear, readManifest, yearLabel } from './ng-sources.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
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

/**
 * The two unpublished-semester reasons, worded from the year (ADR 0015): for a year Y, "On NUS's <Y-1> list; NUS hasn't
 * published <Y>'s yet", each year as the page labels it.
 * @param {string} acadYear
 */
export function unpublishedReasons(acadYear) {
  const last = yearLabel(previousYear(acadYear));
  const now = yearLabel(acadYear);
  return {
    [UNPUBLISHED_SEM]: { kind: 'ask', text: `On NUS's ${last} list; NUS hasn't published ${now}'s yet.`, cite: `NG course list, ${last}` },
    [UNPUBLISHED_UNLISTED]: { kind: 'closed', text: `Not on NUS's ${last} list for this semester, and NUS hasn't published ${now}'s yet.`, cite: `NG course list, ${last}` },
  };
}

/**
 * @param {string} acadYear
 * @param {{ root?: string }} [o]
 */
export async function buildNgReasons(acadYear, { root = ROOT } = {}) {
  const rules = /** @type {import('../src/eligibility.js').Rules & { rules: { id: string, effect: string, note?: string, reason: string, cite?: string }[],
    info?: { id: string, text?: string, scope?: Record<string, unknown> }[] }} */ (loadNgRestrictions(acadYear, { dataDir: pathToFileURL(join(root, 'data/')) }));
  const manifest = readManifest(acadYear, { root });
  if (!manifest || manifest.stub) throw new Error(`ng-reasons: data/ng-sources-${acadYear}.json is missing or a stub`);
  const rev = latestRevision(manifest);
  const dated = (/** @type {string} */ id) => {
    const d = rev && documentOf(rev, id);
    if (!d?.updatedAsAt) throw new Error(`ng-reasons: the source manifest's ${id} document has no "updated as at" date`);
    return d.updatedAsAt;
  };
  const roles = rolesOf((await import(pathToFileURL(join(root, manifest.overlay)).href)).OVERLAY);
  /** @type {Record<string, { kind: string, text: string, cite: string }>} */
  const reasons = { ...BUILT_IN, ...unpublishedReasons(acadYear) };
  for (const r of rules.rules) {
    if (r.effect !== 'closed' && r.effect !== 'note') continue;
    if (reasons[r.id]) throw new Error(`ng-reasons: duplicate id ${r.id}`);
    reasons[r.id] = { kind: r.effect === 'closed' ? 'closed' : r.note ?? 'note', text: r.reason, cite: r.cite ?? 'restrictions PDF' };
  }
  return {
    acadYear,
    generator: 'scripts/build-ng-reasons.mjs',
    // The documents and their "updated as at" dates, from the newest revision of the year's
    // source manifest.
    sources: [
      { name: 'Courses offered to exchange (NG) students', updatedAsAt: dated('ng-list'), url: NG_PAGE },
      { name: 'Course restrictions for exchange (NG) students', updatedAsAt: dated('restrictions'), url: NG_PAGE },
    ],
    reasons,
    // `role`: the page's line for courses off the list is the `off-list-rule` (public/shortlist.js).
    offListRules: (rules.info ?? []).filter((i) => i.text !== undefined)
      .map((i) => ({ id: i.id, text: i.text, scope: i.scope ?? {}, ...(i.id === roles['off-list-rule'] ? { role: 'off-list-rule' } : {}) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT, `${JSON.stringify(await buildNgReasons(DEFAULT_ACAD_YEAR), null, 1)}\n`);
  console.log(`wrote ${OUT.pathname}`);
}
