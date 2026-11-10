// @ts-check
// public/format.js (Phase 5 5B): the pure formatting the cards and the detail
// use: semester names, workload, exams in Singapore time, and NUS's
// prerequisite text with its missing spaces restored.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COHORT_ONLY, isCohortOnly } from '../../public/cohort-only.js';
import { cleanPrereq, codeSegments, examLine, examLines, examSummary, prereqView, semLabel, workloadText } from '../../public/format.js';

const fixture = /** @type {{ modules: NormalisedModule[] }} */ (JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/corpus.json', import.meta.url)), 'utf8')));

describe('semLabel', () => {
  it('names semesters as the page does, and passes anything else through as text', () => {
    expect([1, 2, 3, 4, '2'].map(semLabel)).toEqual(['Sem 1', 'Sem 2', 'Special term 1', 'Special term 2', 'Sem 2']);
    expect(semLabel('<b>9</b>')).toBe('<b>9</b>');
  });
});

describe('workloadText (/module workload)', () => {
  it('gives the total a week and the non-zero parts', () => {
    expect(workloadText({ lecture: 2, tutorial: 1, lab: 0, project: 4, prep: 3, total: 10 }))
      .toBe('10 hours a week: 2 lecture, 1 tutorial, 4 project, 3 preparation');
    expect(workloadText({ lecture: 0.5, tutorial: 0, lab: 0, project: 0, prep: 0.5, total: 1 }))
      .toBe('1 hour a week: 0.5 lecture, 0.5 preparation');
  });

  it("says when it is not listed, and shows NUS's own text when it is not the 5-number form", () => {
    expect(workloadText(null)).toBe('Workload not listed');
    expect(workloadText(undefined)).toBe('Workload not listed');
    expect(workloadText({ raw: '3-.5-0--0-6.5' })).toBe('As NUS lists it: 3-.5-0--0-6.5');
  });
});

describe('exams (/module and /search examDates: ISO UTC; shown in Singapore time)', () => {
  const sem1 = { sem: 1, date: '2026-11-25T17:00:00.000Z', durationMins: 90 };
  const sem2 = { sem: 2, date: '2027-04-27T09:00:00.000Z', durationMins: 120 };

  it('examLine gives the day, date, time and duration in Singapore time, across midnight UTC', () => {
    expect(examLine(sem2)).toBe('Sem 2: Tue 27 Apr 2027, 5:00 pm, 2 h');
    expect(examLine(sem1)).toBe('Sem 1: Thu 26 Nov 2026, 1:00 am, 1 h 30 min');
    expect(examLine({ sem: 1, date: '2026-11-26T04:30:00.000Z', durationMins: 45 })).toBe('Sem 1: Thu 26 Nov 2026, 12:30 pm, 45 min');
    expect(examLine({ sem: 2, date: '2027-05-01T16:00:00.000Z', durationMins: 0 })).toBe('Sem 2: Sun 2 May 2027, 12:00 am');
  });

  it('examSummary is the card line: the chosen semester\'s exam, or every semester\'s', () => {
    expect(examSummary([sem1, sem2], '1')).toBe('Exam 26 Nov');
    expect(examSummary([sem2], '1')).toBe('No final exam');
    expect(examSummary([sem2], '')).toBe('Exam 27 Apr');
    expect(examSummary([sem1, sem2], '')).toBe('Exams 26 Nov (Sem 1), 27 Apr (Sem 2)');
    expect(examSummary([], '')).toBe('No final exam');
    expect(examSummary(undefined, '2')).toBe('No final exam');
  });

  it('examLines is the detail: every semester in order, or "No final exam listed"', () => {
    expect(examLines([sem2, sem1])).toEqual(['Sem 1: Thu 26 Nov 2026, 1:00 am, 1 h 30 min', 'Sem 2: Tue 27 Apr 2027, 5:00 pm, 2 h']);
    expect(examLines([])).toEqual(['No final exam listed']);
    expect(examLines(null)).toEqual(['No final exam listed']);
  });
});

describe('cleanPrereq (NUS rule language, spacing only)', () => {
  it('restores the spaces NUS drops around THEN, AND and OR', () => {
    expect(cleanPrereq('If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2017 inclusive'))
      .toBe('If undertaking an Undergraduate Degree THEN must be in one of the cohorts from 2017 inclusive');
    expect(cleanPrereq('If undertaking an Undergraduate DegreeTHEN( must have completed 1 of ACC2707/ACC2712 at a grade of at least DANDmust be in one of the cohorts from 2017 inclusive )'))
      .toBe('If undertaking an Undergraduate Degree THEN ( must have completed 1 of ACC2707/ACC2712 at a grade of at least D AND must be in one of the cohorts from 2017 inclusive )');
    expect(cleanPrereq('(if x THENmust have completed AIS5102 at a grade of at least B+ANDmust y)OR(if not z)'))
      .toBe('(if x THEN must have completed AIS5102 at a grade of at least B+ AND must y) OR (if not z)');
    expect(cleanPrereq('at least DAND( must x)')).toBe('at least D AND ( must x)');
    expect(cleanPrereq('at least DORmust have completed CFG1002 at a grade of at least CSORmust x'))
      .toBe('at least D OR must have completed CFG1002 at a grade of at least CS OR must x');
  });

  it('leaves words that only contain the keywords alone, and plain English as it was', () => {
    for (const s of ['Students MAJOR in Organic chemistry', 'Pass CS1010 And MA1521, Or equivalent.', 'STANDARD THENCEFORTH', '1005AISCWK Master of Science', 'BACHELOR(Hons)']) {
      expect(cleanPrereq(s)).toBe(s);
    }
    expect(cleanPrereq('  a   b  ')).toBe('a b');
    expect(cleanPrereq(null)).toBe('');
  });

  it('on every fixture prerequisite: only spaces change, and no keyword stays glued to a word', () => {
    const texts = fixture.modules.map((m) => m.prerequisite).filter((t) => typeof t === 'string' && t !== '');
    expect(texts.length).toBeGreaterThan(50);
    for (const t of /** @type {string[]} */ (texts)) {
      const out = cleanPrereq(t);
      expect(out.replace(/\s+/g, ''), t).toBe(t.replace(/\s+/g, ''));
      expect(out, t).not.toMatch(/[a-z)](?:THEN|AND|OR)|(?:THEN|AND|OR)[a-z(]/);
    }
  });
});

describe('prereqView (5C: the cohort-only line, else NUS\'s text with spacing restored)', () => {
  it('a cohort-only prerequisite reads as no course prerequisite, keeping NUS\'s text', () => {
    const acc = 'If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2017 inclusive';
    expect(prereqView(acc)).toEqual({
      kind: 'cohort', line: 'No course prerequisite (the rule names NUS intake years only)',
      text: 'If undertaking an Undergraduate Degree THEN must be in one of the cohorts from 2017 inclusive',
    });
  });

  it('a programme-only rule says programmes, not intake years', () => {
    const bl = 'Must be undertaking 1001DBSASD Doctor of Philosophy (FoS) - Biological Sciences OR must be undertaking 1001BTHCWK MSc (Biotechnology)';
    expect(prereqView(bl)?.line).toBe('No course prerequisite (the rule names NUS programmes only)');
  });

  it('any other rule is NUS\'s text, spaced, and none is null', () => {
    expect(prereqView('If undertaking an Undergraduate DegreeTHENmust have completed CS2040 at a grade of at least D'))
      .toEqual({ kind: 'rule', line: null, text: 'If undertaking an Undergraduate Degree THEN must have completed CS2040 at a grade of at least D' });
    expect(prereqView(null)).toBeNull();
    expect(prereqView('   ')).toBeNull();
  });

  it('public/cohort-only.js mirrors data/cohort-only-prereq.json and agrees with ingest on every fixture course', () => {
    const spec = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/cohort-only-prereq.json', import.meta.url)), 'utf8'));
    expect(COHORT_ONLY).toEqual(spec);
    const flagged = fixture.modules.filter((m) => m.prereqCohortOnly).map((m) => m.code);
    expect(flagged.length).toBeGreaterThan(5);
    for (const m of fixture.modules) {
      expect(isCohortOnly(m.prerequisite, COHORT_ONLY), m.code).toBe(m.prereqCohortOnly === true);
      expect(prereqView(m.prerequisite)?.kind === 'cohort', m.code).toBe(m.prereqCohortOnly === true);
    }
  });
});

describe('codeSegments (course codes in NUS\'s text become search links)', () => {
  it('splits out each course code and keeps the rest as text', () => {
    expect(codeSegments('must have completed 1 of ACC2707/ACC2712 at a grade of at least D')).toEqual([
      { text: 'must have completed 1 of ' }, { code: 'ACC2707' }, { text: '/' }, { code: 'ACC2712' }, { text: ' at a grade of at least D' },
    ]);
    expect(codeSegments('CS2040S or CS2040C')).toEqual([{ code: 'CS2040S' }, { text: ' or ' }, { code: 'CS2040C' }]);
  });

  it('leaves programme codes, grades and plain words alone', () => {
    expect(codeSegments('must be undertaking 1001DBSASD Doctor of Philosophy AND at least B+')).toEqual([{ text: 'must be undertaking 1001DBSASD Doctor of Philosophy AND at least B+' }]);
    expect(codeSegments('')).toEqual([]);
  });
});
