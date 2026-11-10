// @ts-check
// Phase 5 5A (docs/plans/phase5.md §3 "5A Exam dates"): the exam date and
// duration per semester, normalised from moduleInfo's semesterData, stored by
// migration 0010 as `exam_dates`, bound and hashed into row_hash; and the
// workload shape /module/:code answers.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeSchemaProblem } from '../scripts/ingest-core.mjs';
import { normalise } from '../scripts/lib.mjs';
import { moduleWorkload } from '../src/workload.js';
import { ROW_COLUMNS, boundTuple, fieldsFromRow, rowHash } from '../src/rowhash.js';

/** @param {string} path */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** @type {FixtureCorpus} */
const fixture = JSON.parse(read('./fixtures/corpus.json'));

/** @param {Record<string, unknown>} over */
const record = (over = {}) => ({
  moduleCode: 'CS2040', title: 'Data Structures and Algorithms', description: 'Data structures.', moduleCredit: '4',
  department: 'Computer Science', faculty: 'Computing',
  semesterData: [
    { semester: 2, examDate: '2027-04-28T05:00:00.000Z', examDuration: 120 },
    { semester: 1, examDate: '2026-11-25T01:00:00.000Z', examDuration: 90 },
  ],
  workload: [2, 1, 1, 3, 3],
  ...over,
});
/** @param {Record<string, unknown>} over */
const norm = (over = {}) => /** @type {NormalisedModule} */ (normalise(/** @type {any} */ (record(over)), '2026-2027').module);

describe('migrations/0010_exam_dates.sql', () => {
  const body = read('../migrations/0010_exam_dates.sql');

  it('adds exactly one column, exam_dates TEXT NOT NULL DEFAULT \'[]\'', () => {
    const sql = body.replace(/--[^\n]*/g, '').trim();
    expect(sql.replace(/\s+/g, ' ')).toBe("ALTER TABLE modules ADD COLUMN exam_dates TEXT NOT NULL DEFAULT '[]';");
  });

  it('applies after every earlier migration; a row ingest never touched reads []', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
    db.exec("INSERT INTO modules (code, title, description, acad_year, text_hash) VALUES ('A1', 'alpha', 'alpha one', 'y', 'h')");
    expect(db.prepare("SELECT exam_dates FROM modules WHERE code = 'A1'").get()).toEqual({ exam_dates: '[]' });
    const col = db.prepare("SELECT \"notnull\" AS nn, dflt_value AS d, type FROM pragma_table_info('modules') WHERE name = 'exam_dates'").get();
    expect(col).toEqual({ nn: 1, d: "'[]'", type: 'TEXT' });
  });
});

describe('normalise() derives examDates', () => {
  it('one { sem, date, durationMins } per offered semester with an exam, sorted by semester, the date as given (ISO UTC)', () => {
    expect(norm().examDates).toEqual([
      { sem: 1, date: '2026-11-25T01:00:00.000Z', durationMins: 90 },
      { sem: 2, date: '2027-04-28T05:00:00.000Z', durationMins: 120 },
    ]);
  });

  it('a module with no exam has []; a semester without an examDate, or with an empty one, is left out', () => {
    expect(norm({ semesterData: [{ semester: 1 }, { semester: 2 }] }).examDates).toEqual([]);
    expect(norm({ semesterData: [{ semester: 1, examDate: '' }, { semester: 2, examDate: '2027-04-28T05:00:00.000Z', examDuration: 120 }] }).examDates)
      .toEqual([{ sem: 2, date: '2027-04-28T05:00:00.000Z', durationMins: 120 }]);
  });

  it('a missing or non-numeric duration is null, not a guess', () => {
    expect(norm({ semesterData: [{ semester: 1, examDate: '2026-11-25T01:00:00.000Z' }] }).examDates)
      .toEqual([{ sem: 1, date: '2026-11-25T01:00:00.000Z', durationMins: null }]);
    expect(norm({ semesterData: [{ semester: 1, examDate: '2026-11-25T01:00:00.000Z', examDuration: '120' }] }).examDates[0].durationMins).toBeNull();
  });

  it('names exactly the semesters examSemesters (3H) names', () => {
    for (const over of [{}, { semesterData: [{ semester: 1 }, { semester: 3, examDate: 'z', examDuration: 60 }] }]) {
      const m = norm(over);
      expect(m.examDates.map((d) => d.sem)).toEqual(m.examSemesters);
    }
  });
});

describe('the fixture corpus carries exam dates', () => {
  it('every module has examDates naming its examSemesters; some have two exams, some none', () => {
    for (const m of fixture.modules) expect(m.examDates?.map((d) => d.sem), m.code).toEqual(m.examSemesters);
    expect(fixture.modules.filter((m) => m.examDates.length >= 2).length).toBeGreaterThan(0);
    expect(fixture.modules.filter((m) => m.examDates.length === 0).length).toBeGreaterThan(0);
    for (const m of fixture.modules) {
      for (const d of m.examDates) {
        expect(d.date, m.code).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
        expect(Number.isInteger(d.durationMins), m.code).toBe(true);
      }
    }
  });
});

describe('the row and its hash', () => {
  it('exam_dates is the last column ingest binds, as the JSON of examDates', () => {
    const m = norm();
    expect(ROW_COLUMNS.at(-1)).toBe('exam_dates');
    expect(boundTuple(m).length).toBe(ROW_COLUMNS.length);
    expect(boundTuple(m).at(-1)).toBe(JSON.stringify(m.examDates));
  });

  it('a module built by hand without examDates binds []', () => {
    const { examDates, ...m } = norm();
    expect(examDates.length).toBe(2);
    expect(boundTuple(/** @type {any} */ (m)).at(-1)).toBe('[]');
  });

  it('a stored row reads back to the fields it was written from, so verify recomputes the same row_hash', async () => {
    const m = norm();
    const tuple = boundTuple(m);
    const row = /** @type {any} */ (Object.fromEntries(ROW_COLUMNS.map((c, i) => [c, tuple[i]])));
    expect(fieldsFromRow(row).examDates).toEqual(m.examDates);
    expect(await rowHash(fieldsFromRow(row))).toBe(await rowHash(m));
  });

  it('a changed exam date or duration changes the row hash', async () => {
    const base = await rowHash(norm());
    const moved = record().semesterData.map((d) => (d.semester === 1 ? { ...d, examDate: '2026-11-26T01:00:00.000Z' } : d));
    const longer = record().semesterData.map((d) => (d.semester === 1 ? { ...d, examDuration: 120 } : d));
    expect(await rowHash(norm({ semesterData: moved }))).not.toBe(base);
    expect(await rowHash(norm({ semesterData: longer }))).not.toBe(base);
  });

  it('the schema guard names 0010 for a database without exam_dates', () => {
    const ok = { version: 6, ftsExternal: true, rowidTriggers: true, missingTriggers: [], rowHashColumn: true };
    expect(describeSchemaProblem({ ...ok, missingColumns: ['exam_dates'], ok: false })).toMatch(/exam_dates.*0010_exam_dates\.sql/);
    expect(describeSchemaProblem({ ...ok, missingColumns: ['ng_allow', 'ng_rules', 'exam_dates'], ok: false }))
      .toMatch(/0009_exchange\.sql.*0010_exam_dates\.sql/);
  });
});

describe('moduleWorkload: the workload /module/:code answers', () => {
  /** What normalise() stores in `workload` for a moduleInfo value. @param {unknown} w */
  const stored = (w) => norm({ workload: w }).workload;

  it('the 5-number array: lecture, tutorial, lab, project, prep hours a week, and their total', () => {
    expect(moduleWorkload(stored([2, 1, 1, 3, 3]))).toEqual({ lecture: 2, tutorial: 1, lab: 1, project: 3, prep: 3, total: 10 });
    expect(moduleWorkload(stored([0.5, 0.5, 0, 0, 1.5]))).toEqual({ lecture: 0.5, tutorial: 0.5, lab: 0, project: 0, prep: 1.5, total: 2.5 });
  });

  it('the two strings moduleInfo gives (MLE3104, TME2121) are unparseable: { raw }', () => {
    expect(moduleWorkload(stored('3-.5-0--0-6.5'))).toEqual({ raw: '3-.5-0--0-6.5' });
    expect(moduleWorkload(stored('3-0.25-0.5-2.4.25'))).toEqual({ raw: '3-0.25-0.5-2.4.25' });
  });

  it('an array of another length or with a non-number is { raw } too, as its JSON', () => {
    expect(moduleWorkload(stored([1, 2, 3]))).toEqual({ raw: '[1,2,3]' });
    expect(moduleWorkload(stored([1, 'x', 2, 0, 0]))).toEqual({ raw: '[1,"x",2,0,0]' });
    expect(moduleWorkload(stored([1, -1, 2, 0, 0]))).toEqual({ raw: '[1,-1,2,0,0]' });
  });

  it('null when not listed: absent, or all zero (C-11)', () => {
    expect(moduleWorkload(stored(undefined))).toBeNull();
    expect(moduleWorkload(null)).toBeNull();
    expect(moduleWorkload(stored([0, 0, 0, 0, 0]))).toBeNull();
  });

  it('agrees with 3H\'s workload_hours on every fixture module: the total where it has one, null or raw where it hasn\'t', () => {
    for (const m of fixture.modules) {
      const w = moduleWorkload(m.workload);
      if (m.workloadHours !== null) expect(w, m.code).toMatchObject({ total: m.workloadHours });
      else expect(w === null || 'raw' in w, m.code).toBe(true);
    }
  });
});
