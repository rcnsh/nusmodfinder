// @ts-check
// Phase 6 6A (docs/plans/phase6.md §3 "6A"): the NG-listed codes with no
// classes this year (data/ng-unscheduled.json, test/fixtures/ng-unscheduled.json),
// built by scripts/build-ng-unscheduled.mjs.
// - Every production entry's allow mask and rule ids are what eligibility()
//   gives from the entry's own fields and listed semesters under the committed
//   rules, recomputed here with no cache, so a stale mask fails CI.
// - Every production code is on the year's NG list, for exactly the semesters
//   it lists.
// - The fixture file is what the build writes from its hand-kept source.
// - Where the moduleInfo cache exists (the re-ingest machine), the production
//   file is what the build writes from it and holds exactly the NG codes with
//   no offered row; CI has no cache and skips that, saying why, as the
//   production groups' check does.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIXTURE_SOURCE, NG_UNSCHEDULED_SCHEMA, OUTPUTS, build, productionCorpusPath } from '../scripts/build-ng-unscheduled.mjs';
import { DEFAULT_ACAD_YEAR, loadNgRestrictions } from '../scripts/lib.mjs';
import { bitOf, storedEligibility } from '../src/eligibility.js';

/** @param {string} rel */
const read = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
/** @typedef {import('../src/ng-unscheduled-file.js').NgUnscheduledFile} NgUnscheduledFile */
/** @typedef {import('../src/ng-unscheduled-file.js').NgUnscheduledEntry} NgUnscheduledEntry */

const production = /** @type {NgUnscheduledFile} */ (read(OUTPUTS.production));
const fixtureFile = /** @type {NgUnscheduledFile} */ (read(OUTPUTS.fixture));
const rules = loadNgRestrictions(production.acadYear);
const ngList = read(`data/ng-courses-${production.acadYear}.json`);

/**
 * The entries whose stored eligibility is not what eligibility() gives now,
 * from their own fields: a course with no classes, on the NG list for the
 * semesters it lists.
 * @param {NgUnscheduledFile} file
 */
const stale = (file) => file.modules.filter((e) => {
  const m = {
    code: e.code, title: e.title, department: e.department, faculty: e.faculty, level: e.level,
    semesters: [], ng: true, ngSemesters: e.ngSemesters, prerequisite: e.prerequisite,
  };
  const want = storedEligibility(m, rules);
  return e.ngAllow !== want.ngAllow || JSON.stringify(e.ngRules) !== JSON.stringify(want.ngRules);
}).map((e) => e.code);

describe('data/ng-unscheduled.json', () => {
  it('names its schema, corpus, the data version of the production bundle and the year of the reason texts', () => {
    expect(production).toMatchObject({ schema: NG_UNSCHEDULED_SCHEMA, corpus: 'production', acadYear: DEFAULT_ACAD_YEAR });
    expect(production.dataVersion).toBe(read('data/vectors.json').bundles.production.dataVersion);
    expect(production.acadYear).toBe(read('data/ng-reasons.json').acadYear);
    expect(production.count).toBe(production.modules.length);
    expect(production.modules.map((e) => e.code)).toEqual([...production.modules.map((e) => e.code)].sort());
  });

  it('holds some codes, every one in data/catalogue-codes.json now that it follows the same corpus (Phase 7 7D)', () => {
    // How many follows NUSMods (40 in the first 7D corpus, 43 after the first refresh), so no count is pinned.
    expect(production.count).toBeGreaterThan(0);
    const catalogue = new Set(read('data/catalogue-codes.json').codes);
    expect(production.modules.map((e) => e.code).filter((c) => !catalogue.has(c))).toEqual([]);
  });

  it('every entry\'s allow mask and rule ids are eligibility()\'s from its own fields, recomputed with the committed rules', () => {
    expect(stale(production)).toEqual([]);
    // PF2102 is closed at grad in Sem 1 (4-be-l1234-grad), so an entry left open there is caught.
    const pf = /** @type {NgUnscheduledEntry} */ (production.modules.find((e) => e.code === 'PF2102'));
    expect(pf.ngAllow & bitOf(1, 'grad')).toBe(0);
    const doctored = { ...production, modules: production.modules.map((e) => (e.code === 'PF2102' ? { ...e, ngAllow: e.ngAllow | bitOf(1, 'grad') } : e)) };
    expect(stale(doctored)).toEqual(['PF2102']);
  });

  it('every code is on the year\'s NG list for exactly the semesters it lists', () => {
    for (const e of production.modules) {
      const listed = Object.entries(/** @type {Record<string, string[]>} */ (ngList.semesters))
        .filter(([, codes]) => codes.includes(e.code)).map(([sem]) => Number(sem)).sort();
      expect(e.ngSemesters, e.code).toEqual(listed);
      expect(listed.length, e.code).toBeGreaterThan(0);
    }
  });

  it('holds the fields a row has, with the workload as /module/:code answers it', () => {
    const ee = /** @type {NgUnscheduledEntry} */ (production.modules.find((e) => e.code === 'EE4407'));
    expect(ee).toMatchObject({
      title: 'Analog Electronics', credits: 4, level: 4, faculty: 'College of Design and Engineering',
      department: 'Electrical and Computer Engineering', ngSemesters: [1], gradingBasis: 'Graded',
      workload: { lecture: 2, tutorial: 1, lab: 0.5, project: 1.5, prep: 5, total: 10 },
    });
    const fin = /** @type {NgUnscheduledEntry} */ (production.modules.find((e) => e.code === 'FIN3701B'));
    expect(fin.otherCodes).toEqual(['FIN3701A', 'FIN3701C', 'FIN3701D']);
    expect(fin.ngSemesters).toEqual([1, 2]);
    for (const e of production.modules) {
      expect(Object.keys(e), e.code).toEqual(['code', 'title', 'description', 'credits', 'faculty', 'department', 'level',
        'ngSemesters', 'workload', 'prerequisite', 'preclusion', 'gradingBasis', 'otherCodes', 'ngAllow', 'ngRules']);
      expect(e.otherCodes, e.code).not.toContain(e.code);
    }
  });

  const restored = existsSync(productionCorpusPath());
  const why = '`current` is not restored here (npm run corpus -- restore); CI checks the masks above';
  it.skipIf(!restored)(`is what the build writes from \`current\`, with exactly the NG codes that have no offered row (skipped when ${why})`, async () => {
    expect(await build('production')).toBe(readFileSync(new URL(`../${OUTPUTS.production}`, import.meta.url), 'utf8'));
  }, 60_000);
});

describe('test/fixtures/ng-unscheduled.json', () => {
  it('is what the build writes from its hand-kept source', async () => {
    expect(await build('fixture')).toBe(readFileSync(new URL(`../${OUTPUTS.fixture}`, import.meta.url), 'utf8'));
    expect(fixtureFile.corpus).toBe('fixture');
    expect(fixtureFile.modules.map((e) => e.code)).toEqual(['EE4407', 'EE4438', 'ESP4403', 'NGN2001D', 'PF2102', 'PF2505']);
    expect(read(FIXTURE_SOURCE).records.map((/** @type {{ moduleCode: string }} */ r) => r.moduleCode).sort())
      .toEqual(fixtureFile.modules.map((e) => e.code));
  });

  it('holds no code the fixture corpus offers, and groups NGN2001D with the fixture\'s NGN2001F and NGN2001G', () => {
    const offered = new Set(read('test/fixtures/corpus.json').modules.map((/** @type {{ code: string }} */ m) => m.code));
    for (const e of fixtureFile.modules) expect(offered.has(e.code), e.code).toBe(false);
    expect(fixtureFile.modules.find((e) => e.code === 'NGN2001D')?.otherCodes).toEqual(['NGN2001F', 'NGN2001G']);
    expect(stale(fixtureFile)).toEqual([]);
  });
});
