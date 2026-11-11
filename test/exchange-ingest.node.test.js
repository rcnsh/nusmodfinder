// @ts-check
// Phase 4 4A, Node side (docs/plans/phase4.md §2 "Storage", §5): ingest
// computes the allow mask and rule ids from the NG list and the restrictions
// data; both reach the row hash, the upsert's SET list and the schema guard;
// the Worker's reason texts are the build of the rules file and know every
// id ingest stores.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildNgReasons } from '../scripts/build-ng-reasons.mjs';
import { describeSchemaProblem } from '../scripts/ingest-core.mjs';
import { DEFAULT_ACAD_YEAR, loadNgCourses, loadNgRestrictions, offeredModules } from '../scripts/lib.mjs';
import { eligibilityMask, storedEligibility } from '../src/eligibility.js';
import { bitOf } from '../src/ng-bit.js';
import { ROW_COLUMNS, UPSERT_SET, boundTuple, rowHash } from '../src/rowhash.js';

/** @param {string} path */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** @type {FixtureCorpus} */
const fixture = JSON.parse(read('./fixtures/corpus.json'));
const rules = loadNgRestrictions(DEFAULT_ACAD_YEAR);

const record = {
  moduleCode: 'CS3244', title: 'Machine Learning', department: 'Computer Science', faculty: 'Computing',
  description: 'Machine learning.', moduleCredit: '4', semesterData: [{ semester: 1 }, { semester: 2 }],
};

describe('offeredModules computes exchange eligibility at ingest', () => {
  it('stores the mask and the rule ids per bit; a module off the NG list stores 0 and null', async () => {
    const ng = await loadNgCourses(DEFAULT_ACAD_YEAR);
    const [cs3244] = offeredModules([record], DEFAULT_ACAD_YEAR, ng).modules;
    expect(cs3244.ngSemesters).toEqual([2]);
    expect(cs3244.ngAllow).toBe(eligibilityMask(cs3244, rules).allow);
    expect(cs3244.ngAllow & bitOf(1, 'ug3')).toBe(0);
    expect(cs3244.ngAllow & bitOf(2, 'ug3')).not.toBe(0);
    expect(cs3244.ngRules?.[String(Math.log2(bitOf(1, 'ug3')))]).toEqual(['ng-list:not-in-semester']);
    expect(cs3244.ngRules?.[String(Math.log2(bitOf(2, 'ug3')))]).toBeUndefined();
    const [off] = offeredModules([{ ...record, moduleCode: 'CS9999' }], DEFAULT_ACAD_YEAR, ng).modules;
    expect(off).toMatchObject({ ng: false, ngAllow: 0, ngRules: null });
  });

  it('refuses an NG list without restrictions data, and leaves eligibility neutral without an NG list', () => {
    const ng = { available: true, bySem: new Map([['CS3244', [2]]]), updatedAsAt: null, source: null, total: 1, rules: null };
    expect(() => offeredModules([record], DEFAULT_ACAD_YEAR, ng)).toThrow(/without restrictions data/);
    expect(offeredModules([record], DEFAULT_ACAD_YEAR, null).modules[0]).toMatchObject({ ngAllow: 0, ngRules: null });
  });

  it('the committed fixture corpus carries exactly what ingest computes', () => {
    for (const m of fixture.modules) expect({ ngAllow: m.ngAllow, ngRules: m.ngRules }, m.code).toEqual(storedEligibility(m, rules));
  });
});

describe('the row and its writes (plan §5)', () => {
  it('ng_allow and ng_rules are bound and hashed, so a rules-only change rewrites the row', async () => {
    const m = /** @type {NormalisedModule} */ (fixture.modules.find((x) => x.code === 'CS3244'));
    // 5A's exam_dates follows them (test/exam-dates.node.test.js).
    expect(ROW_COLUMNS.slice(-3, -1)).toEqual(['ng_allow', 'ng_rules']);
    expect(boundTuple(m).slice(-3, -1)).toEqual([m.ngAllow, JSON.stringify(m.ngRules)]);
    const base = await rowHash(m);
    expect(await rowHash({ ...m, ngAllow: m.ngAllow ^ 1 })).not.toBe(base);
    expect(await rowHash({ ...m, ngRules: { ...m.ngRules, 0: ['x'] } })).not.toBe(base);
  });

  it('the upsert\'s SET list is built from ROW_COLUMNS: every column but the key, and row_hash', () => {
    const set = UPSERT_SET.split(', ').map((p) => p.split('=')[0]);
    expect(set).toEqual([...ROW_COLUMNS.filter((c) => c !== 'code'), 'row_hash']);
    for (const p of UPSERT_SET.split(', ')) expect(p).toMatch(/^(\w+)=excluded\.\1$/);
  });

  it('the schema guard refuses a database without 0009\'s columns, and a Worker too old to say', () => {
    const ok = { version: 6, ftsExternal: true, rowidTriggers: true, missingTriggers: [], rowHashColumn: true };
    expect(describeSchemaProblem({ ...ok, missingColumns: [], ok: true })).toBeNull();
    expect(describeSchemaProblem({ ...ok, missingColumns: ['ng_allow', 'ng_rules'], ok: false })).toMatch(/ng_allow, ng_rules.*0009_exchange/);
    expect(describeSchemaProblem({ ...ok, ok: true })).toMatch(/older than this script/);
    expect(describeSchemaProblem({ ...ok, version: 5, missingColumns: [], ok: false })).toMatch(/migration 0006/);
  });
});

describe('the Worker\'s reason texts (data/ng-reasons.json)', () => {
  const file = JSON.parse(read('../data/ng-reasons.json'));

  it('are what scripts/build-ng-reasons.mjs builds from the rules file', () => {
    expect(file).toEqual(buildNgReasons(DEFAULT_ACAD_YEAR));
  });

  it('know every rule id ingest can store, and every id the fixture stores', () => {
    for (const r of rules.rules) if (r.effect === 'closed' || r.effect === 'note') expect(file.reasons[r.id], r.id).toBeDefined();
    for (const m of fixture.modules) {
      for (const id of Object.values(m.ngRules ?? {}).flat()) expect(file.reasons[id], `${m.code} ${id}`).toBeDefined();
    }
  });

  it('rule D says the list opens no course to the student\'s year of study, not to everyone (5G review: CAS5101)', () => {
    // A level 5000 Southeast Asian Studies course: rule 1-sea-l5-yr4-pg opens it to 4th-years and
    // graduates, so a 3rd-year is closed by rule D alone while a 4th-year is open.
    const cas = /** @type {any} */ ({
      code: 'CAS5101', title: 'Theorizing from Asia', department: 'Southeast Asian Studies',
      faculty: 'Arts and Social Science', level: 5, semesters: [1], ng: true, ngSemesters: [1],
    });
    const { ngAllow, ngRules } = storedEligibility(cas, rules);
    expect(ngRules[String(Math.log2(bitOf(1, 'ug3')))]).toEqual(['D-grad-levels-closed-exchange']);
    expect(ngAllow & bitOf(1, 'ug4')).not.toBe(0);
    const text = file.reasons['D-grad-levels-closed-exchange'].text;
    expect(text).toMatch(/your year of study|to yours/);
    expect(text).not.toMatch(/doesn't open this one\./);
  });

  it('name the sources with the dates docs/evidence/phase4/sources.md records', () => {
    const md = read('../docs/evidence/phase4/sources.md');
    const dateOf = (/** @type {string} */ f) => new RegExp(`^\\| \`${f}\` \\|[^|]*\\| ([^|]+) \\|`, 'm').exec(md)?.[1].trim();
    expect(file.sources.map((/** @type {{ updatedAsAt: string }} */ s) => s.updatedAsAt))
      .toEqual([dateOf('ng-courses.pdf'), dateOf('non-graduating-course-restrictions.pdf')]);
  });
});
