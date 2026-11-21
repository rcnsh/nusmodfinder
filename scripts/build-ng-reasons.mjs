// @ts-check
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

const BUILT_IN = {
  [OFF_NG_LIST]: { kind: 'closed', text: 'Not on the Registrar\'s list of courses offered to exchange students.', cite: 'NG course list' },
  [NOT_NG_IN_SEM]: { kind: 'closed', text: 'Offered to exchange students only in the other semester.', cite: 'NG course list' },
  [SEMESTER_MISMATCH]: {
    kind: 'semester',
    text: 'The NG list offers it to exchange students in this semester, but NUSMods shows no classes for it then. Ask the department that teaches it whether it will run.',
    cite: 'NG course list; NUSMods',
  },
  [GRAD_LEVELS]: {
    kind: 'closed',
    text: 'Level 5000 and 6000 courses are graduate courses. Exchange students can take one only if NUS\'s restrictions list opens it to their year of study, and the list doesn\'t open this one to yours. If you need it, ask the department that teaches it.',
    cite: 'restrictions PDF §D',
  },
};

/** @param {string} acadYear */
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
    sources: [
      { name: 'Courses offered to exchange (NG) students', updatedAsAt: dated('ng-list'), url: NG_PAGE },
      { name: 'Course restrictions for exchange (NG) students', updatedAsAt: dated('restrictions'), url: NG_PAGE },
    ],
    reasons,
    offListRules: (rules.info ?? []).filter((i) => i.text !== undefined)
      .map((i) => ({ id: i.id, text: i.text, scope: i.scope ?? {}, ...(i.id === roles['off-list-rule'] ? { role: 'off-list-rule' } : {}) })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT, `${JSON.stringify(await buildNgReasons(DEFAULT_ACAD_YEAR), null, 1)}\n`);
  console.log(`wrote ${OUT.pathname}`);
}
