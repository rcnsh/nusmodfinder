// @ts-check
// Phase 7 7D (ADR 0003, amendment "the eval's pinned NG files"): the eval
// normalises the pinned corpus with byte-identical copies of its year's NG
// list and restrictions from eval/pinned/, passed into the ranker's
// offeredModules, never the live data/ files through loadNgCourses. So a
// Registrar revision of either live file moves neither the eval nor the
// ranking lock. Compared module by module, not by a sha.
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PINNED_NG_FILES, pinnedModulesWith } from '../../eval/lib/corpus.mjs';
import { LOCK_INPUTS } from '../../eval/lib/ranking-lock.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { PINNED_ACAD_YEAR } from '../../scripts/pinned-corpus.mjs';

const ADR = 'docs/decisions/0003-eval-holdout-and-gate.md';
const sha256 = (/** @type {Buffer} */ b) => createHash('sha256').update(b).digest('hex');
const COURSES = `ng-courses-${PINNED_ACAD_YEAR}.json`;
const RESTRICTIONS = `ng-restrictions-${PINNED_ACAD_YEAR}.json`;

/** @type {string} */
let root;
/** @type {any[]} */
let records;
beforeAll(async () => {
  // A ranker tree: scripts/lib.mjs with the src/ and data/ it reads.
  root = await mkdtemp(join(tmpdir(), 'vnm-pinned-ng-'));
  for (const p of ['src', 'data', 'scripts/lib.mjs']) await cp(join(REPO, p), join(root, p), { recursive: true });
  // Records for the first 60 NG-listed codes, offered in both semesters, plus one off the list.
  const ng = JSON.parse(await readFile(join(REPO, 'eval/pinned', COURSES), 'utf8'));
  const codes = [...new Set(Object.values(/** @type {Record<string, string[]>} */ (ng.semesters)).flat())].sort().slice(0, 60);
  records = [...codes, 'ZZ1001'].map((moduleCode) => ({
    moduleCode, title: `Title ${moduleCode}`, description: `About ${moduleCode}.`, moduleCredit: '4',
    department: 'Computer Science', faculty: 'Computing', semesterData: [{ semester: 1 }, { semester: 2 }],
  }));
});
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe('the eval\'s pinned NG files', () => {
  it('are named for the pinned year and recorded in ADR 0003', async () => {
    expect(PINNED_NG_FILES.courses).toBe(`eval/pinned/${COURSES}`);
    expect(PINNED_NG_FILES.restrictions).toBe(`eval/pinned/${RESTRICTIONS}`);
    const adr = await readFile(join(REPO, ADR), 'utf8');
    for (const [label, rel] of [['pinned NG list', PINNED_NG_FILES.courses], ['pinned NG restrictions', PINNED_NG_FILES.restrictions]]) {
      const m = adr.match(new RegExp(`${label} sha256 \`([0-9a-f]{64})\``));
      expect(m, `${ADR} records no "${label} sha256"`).not.toBeNull();
      expect(sha256(await readFile(join(REPO, rel)))).toBe(/** @type {RegExpMatchArray} */ (m)[1]);
    }
  });

  it('an edit to either live NG file leaves the eval\'s modules identical', async () => {
    const before = await pinnedModulesWith(root, records);
    expect(before.modules.filter((m) => m.ng).length).toBeGreaterThan(50);
    // A revision of the live list: Sem 1 dropped. And of the restrictions: every rule closed.
    const live = join(root, 'data', COURSES);
    const ng = JSON.parse(await readFile(live, 'utf8'));
    await writeFile(live, JSON.stringify({ ...ng, updatedAsAt: '01 Jan 1999', semesters: { 2: ng.semesters[2] } }));
    const liveRules = join(root, 'data', RESTRICTIONS);
    const rules = JSON.parse(await readFile(liveRules, 'utf8'));
    await writeFile(liveRules, JSON.stringify({ ...rules, rules: rules.rules.map((/** @type {any} */ r) => ({ ...r, effect: 'closed' })) }));
    const after = await pinnedModulesWith(root, records);
    expect(after.modules.length).toBe(before.modules.length);
    for (let i = 0; i < before.modules.length; i++) expect(after.modules[i], before.modules[i].code).toEqual(before.modules[i]);
    expect(after.ngSha256).toBe(before.ngSha256);
    expect(after.ngRestrictionsSha256).toBe(before.ngRestrictionsSha256);
  });

  it('are inputs of the ranking lock', () => {
    expect(LOCK_INPUTS).toContain('eval/pinned');
  });

  it('records both sha256s, of the pinned copies', async () => {
    const { ngSha256, ngRestrictionsSha256 } = await pinnedModulesWith(root, records);
    expect(ngSha256).toBe(sha256(await readFile(join(REPO, PINNED_NG_FILES.courses))));
    expect(ngRestrictionsSha256).toBe(sha256(await readFile(join(REPO, PINNED_NG_FILES.restrictions))));
  });
});
