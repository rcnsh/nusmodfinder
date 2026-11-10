// @ts-check
// 3H-0 (docs/plans/phase3.md 3H "Data"): the fields the 3H intents filter on,
// derived by normalise() (scripts/lib.mjs), bound by ingest and hashed into
// row_hash (src/rowhash.js), and carried in the bundle's filter table
// (src/vector-bundle.js, bytes 20–27).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COHORT_ONLY, isCohortOnly } from '../eval/prereg/cohort-only.mjs';
import { isCohortOnly as workerCohortOnly } from '../src/cohort-only.js';
import { normalise } from '../scripts/lib.mjs';
import { NORMALISER_VERSION, ROW_COLUMNS, boundTuple, fieldsFromRow, rowHash } from '../src/rowhash.js';
import { BUNDLE_SCHEMA, decodeFilterRow, encodeBundle, parseBundle } from '../src/vector-bundle.js';

const COHORT = 'If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2017 inclusive';
const COURSE = 'If undertaking an Undergraduate DegreeTHEN( must have completed 1 of EC2204 at a grade of at least D, any Courses beginning with ACC1701 at a grade of at least DANDmust be in one of the cohorts from 2017 inclusive )';

/** @param {Record<string, unknown>} over */
const record = (over = {}) => ({
  moduleCode: 'CS1010S', title: 'Programming Methodology', description: 'Intro to programming.', moduleCredit: '4',
  department: 'Computer Science', faculty: 'Computing',
  semesterData: [{ semester: 1, examDate: '2026-11-25T01:00:00.000Z' }, { semester: 2 }],
  workload: [2, 1, 1, 3, 3], attributes: { su: true }, gradingBasisDescription: 'Graded',
  ...over,
});
/** @param {Record<string, unknown>} over */
const norm = (over = {}) => /** @type {NormalisedModule} */ (normalise(/** @type {any} */ (record(over)), '2026-2027').module);

describe('normalise() derives the 3H fields', () => {
  it('exam semesters: the offered semesters with an examDate, sorted', () => {
    expect(norm().examSemesters).toEqual([1]);
    expect(norm({ semesterData: [{ semester: 2, examDate: 'x' }, { semester: 1, examDate: 'y' }] }).examSemesters).toEqual([1, 2]);
    expect(norm({ semesterData: [{ semester: 1 }, { semester: 2 }] }).examSemesters).toEqual([]);
  });

  it('S/U: attributes.su, and the grading basis as given', () => {
    expect(norm()).toMatchObject({ su: true, gradingBasis: 'Graded' });
    expect(norm({ attributes: {}, gradingBasisDescription: 'Completed Satisfactory/Unsatisfactory' }))
      .toMatchObject({ su: false, gradingBasis: 'Completed Satisfactory/Unsatisfactory' });
    expect(norm({ attributes: undefined, gradingBasisDescription: undefined })).toMatchObject({ su: false, gradingBasis: null });
  });

  it('workload hours: the array\'s sum; NULL when missing, unparseable or all zero (C-11)', () => {
    expect(norm().workloadHours).toBe(10);
    expect(norm({ workload: [0, 0, 0, 0, 0] }).workloadHours).toBeNull();
    expect(norm({ workload: '3-.5-0--0-6.5' }).workloadHours).toBeNull();
    expect(norm({ workload: undefined }).workloadHours).toBeNull();
    expect(norm({ workload: [1, 'x', 2] }).workloadHours).toBeNull();
    expect(norm({ workload: [0.5, 0.5, 0, 0, 1.5] }).workloadHours).toBe(2.5);
  });

  it('prerequisites: none iff the field is absent (C-5); cohort-only by the P-6 rule (A2-12, A3-7)', () => {
    expect(norm({ prerequisite: undefined })).toMatchObject({ prereqNone: true, prereqCohortOnly: false });
    // ACC1701XA's and ACC2706's texts, the P-6 rule's own checks (cohort-only-prereq.json).
    expect(isCohortOnly(COHORT)).toBe(true);
    expect(norm({ prerequisite: COHORT })).toMatchObject({ prereqNone: false, prereqCohortOnly: true });
    expect(norm({ prerequisite: COURSE })).toMatchObject({ prereqNone: false, prereqCohortOnly: false });
  });
});

describe('row_hash and the bound tuple', () => {
  it('the normaliser version is 2, and every 3H field is a column ingest binds', () => {
    expect(NORMALISER_VERSION).toBe(2);
    expect(ROW_COLUMNS).toEqual(expect.arrayContaining(['exam_semesters', 'su', 'grading_basis', 'workload_hours', 'prereq_none', 'prereq_cohort_only']));
    expect(boundTuple(norm()).length).toBe(ROW_COLUMNS.length);
  });

  it('a stored row reads back to the fields it was written from, so verify recomputes the same row_hash', async () => {
    const m = norm({ prerequisite: undefined, workload: [0, 0, 0, 0, 0] });
    const tuple = boundTuple(m);
    const row = /** @type {any} */ (Object.fromEntries(ROW_COLUMNS.map((c, i) => [c, tuple[i]])));
    expect(await rowHash(fieldsFromRow(row))).toBe(await rowHash(m));
  });

  it('each 3H field changes the row hash', async () => {
    const base = await rowHash(norm());
    for (const over of [{ attributes: {} }, { gradingBasisDescription: 'Pass and Fail' }, { semesterData: [{ semester: 1 }, { semester: 2 }] },
      { workload: [2, 1, 1, 3, 4] }]) {
      expect(await rowHash(norm(over)), JSON.stringify(over)).not.toBe(base);
    }
  });
});

describe('the bundle filter table', () => {
  it('carries the 3H fields under schema vnm-vectors/3 (Phase 4 added ng_allow)', async () => {
    expect(BUNDLE_SCHEMA).toBe('vnm-vectors/3');
    const a = norm();
    const b = norm({ moduleCode: 'CS1010X', semesterData: [{ semester: 1 }, { semester: 3, examDate: 'z' }], attributes: {},
      gradingBasisDescription: 'Completed Satisfactory/Unsatisfactory', workload: undefined, prerequisite: COHORT });
    const v = new Array(384).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    const bytes = await encodeBundle({ corpus: 'fixture', embedding: 'e', model: 'm', modules: [a, b], vectorOf: () => v });
    const bundle = parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    expect(decodeFilterRow(bundle, 0)).toMatchObject({
      examSemesters: [1], su: true, suGrading: false, workloadHours: 10, prereqNone: true, prereqCohortOnly: false,
    });
    expect(decodeFilterRow(bundle, 1)).toMatchObject({
      examSemesters: [3], su: false, suGrading: true, workloadHours: null, prereqNone: false, prereqCohortOnly: true,
    });
  });
});

describe('the fixture (C-15)', () => {
  it('holds an example of every 3H case: mixed per-semester exams, CS/CU grading, unlisted workload, no prerequisite, cohort-only', () => {
    const { modules } = /** @type {FixtureCorpus} */ (JSON.parse(readFileSync(new URL('./fixtures/corpus.json', import.meta.url), 'utf8')));
    const has = (/** @type {(m: NormalisedModule) => boolean} */ p) => modules.filter(p).length;
    expect(has((m) => m.examSemesters.length > 0 && m.examSemesters.length < m.semesters.length)).toBeGreaterThan(0);
    expect(has((m) => m.examSemesters.length === 0)).toBeGreaterThan(0);
    expect(has((m) => m.su)).toBeGreaterThan(0);
    expect(has((m) => m.gradingBasis === 'Completed Satisfactory/Unsatisfactory')).toBeGreaterThan(0);
    expect(has((m) => m.workload !== null && m.workloadHours === null)).toBeGreaterThan(0);
    expect(has((m) => m.workloadHours !== null && m.workloadHours < 10)).toBeGreaterThan(0);
    expect(has((m) => m.prereqNone)).toBeGreaterThan(0);
    expect(has((m) => m.prereqCohortOnly)).toBeGreaterThan(0);
  });
});

describe('the cohort-only rule normalise() applies', () => {
  it('is the P-6 rule: data/cohort-only-prereq.json mirrors it, and src/ reads it as eval/prereg does', () => {
    const mirror = JSON.parse(readFileSync(new URL('../data/cohort-only-prereq.json', import.meta.url), 'utf8'));
    for (const k of ['normalise', 'remove', 'remainder', 'remainderFlags']) expect(mirror[k], k).toEqual(COHORT_ONLY[k]);
    const { modules } = /** @type {FixtureCorpus} */ (JSON.parse(readFileSync(new URL('./fixtures/corpus.json', import.meta.url), 'utf8')));
    const texts = [COHORT, COURSE, '', null, ...modules.map((m) => m.prerequisite)];
    for (const t of texts) expect(workerCohortOnly(t, mirror), String(t)).toBe(isCohortOnly(t));
    expect(modules.filter((m) => workerCohortOnly(m.prerequisite, mirror)).length).toBeGreaterThan(0);
  });
});
