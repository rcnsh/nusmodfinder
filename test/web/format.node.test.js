// @ts-check
// public/format.js (Phase 5 5B): the pure formatting the cards and the detail
// use: semester names, workload, exams in Singapore time, and NUS's
// prerequisite text with its missing spaces restored.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ECHO_MAX, cleanPrereq, codeSegments, echoText, examLine, examLines, examParts, prereqView, quoteUser, semLabel, workloadText } from '../../public/format.js';

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

  it('examParts is the card: the chosen semester\'s exam as "Exam", else each semester\'s, with day and time in Singapore', () => {
    expect(examParts([sem1, sem2], '1')).toEqual([{ label: 'Exam', when: 'Thu 26 Nov, 1:00 am' }]);
    expect(examParts([sem2], '1')).toEqual([]);
    expect(examParts([sem2], '')).toEqual([{ label: 'Sem 2 exam', when: 'Tue 27 Apr, 5:00 pm' }]);
    expect(examParts([sem2, sem1], '')).toEqual([{ label: 'Sem 1 exam', when: 'Thu 26 Nov, 1:00 am' }, { label: 'Sem 2 exam', when: 'Tue 27 Apr, 5:00 pm' }]);
    expect(examParts([], '')).toEqual([]);
    expect(examParts(undefined, '2')).toEqual([]);
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

  it('[PD1] preclusions use the same rule language: CS2106\'s, as p2 heard it ("DegreeTHEN(", "at least DOR(must not")', () => {
    expect(cleanPrereq('If undertaking an Undergraduate DegreeTHEN( must not have completed 1 of CG2271/EE4214 at a grade of at least DOR(must not be undertaking 2001CEGHON Bachelor of Engineering (Computer Engineering) (Hons)))'))
      .toBe('If undertaking an Undergraduate Degree THEN ( must not have completed 1 of CG2271/EE4214 at a grade of at least D OR (must not be undertaking 2001CEGHON Bachelor of Engineering (Computer Engineering) (Hons)))');
  });

  it('[PD1] on every fixture preclusion too: only spaces change, and no keyword stays glued to a word', () => {
    const texts = fixture.modules.map((m) => m.preclusion).filter((t) => typeof t === 'string' && t !== '');
    expect(texts.filter((t) => /[a-z)](?:THEN|AND|OR)|(?:THEN|AND|OR)[a-z(]/.test(/** @type {string} */ (t))).length).toBeGreaterThan(50);
    for (const t of /** @type {string[]} */ (texts)) {
      const out = cleanPrereq(t);
      expect(out.replace(/\s+/g, ''), t).toBe(t.replace(/\s+/g, ''));
      expect(out, t).not.toMatch(/[a-z)](?:THEN|AND|OR)|(?:THEN|AND|OR)[a-z(]/);
    }
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
    expect(prereqView(acc, true)).toEqual({
      kind: 'cohort', line: "No course you must pass first. NUS's rule only names groups of NUS students by the year they started; ask NUS whether it applies to you.",
      text: 'If undertaking an Undergraduate Degree THEN must be in one of the cohorts from 2017 inclusive',
    });
  });

  it('a programme-only rule says programmes, not intake years', () => {
    const bl = 'Must be undertaking 1001DBSASD Doctor of Philosophy (FoS) - Biological Sciences OR must be undertaking 1001BTHCWK MSc (Biotechnology)';
    expect(prereqView(bl, true)?.line).toBe("No course you must pass first. NUS's rule only names NUS degree programmes; ask NUS whether it applies to you.");
  });

  it('any other rule is NUS\'s text, spaced, and none is null', () => {
    expect(prereqView('If undertaking an Undergraduate DegreeTHENmust have completed CS2040 at a grade of at least D', false))
      .toEqual({ kind: 'rule', line: null, text: 'If undertaking an Undergraduate Degree THEN must have completed CS2040 at a grade of at least D' });
    expect(prereqView(null, false)).toBeNull();
    expect(prereqView('   ', true)).toBeNull();
  });

  it('follows /module/:code\'s prereqCohortOnly, never its own reading of the text', () => {
    const acc = 'If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2017 inclusive';
    expect(prereqView(acc, false)?.kind).toBe('rule');
    for (const m of fixture.modules.filter((x) => x.prerequisite)) {
      expect(prereqView(m.prerequisite, m.prereqCohortOnly === true)?.kind, m.code).toBe(m.prereqCohortOnly ? 'cohort' : 'rule');
    }
  });
});

describe('codeSegments (course codes in NUS\'s text become search links)', () => {
  it('splits out each course code and keeps the rest as text', () => {
    expect(codeSegments('must have completed 1 of ACC2707/ACC2712 at a grade of at least D')).toEqual([
      { text: 'must have completed 1 of ' }, { code: 'ACC2707' }, { text: '/' }, { code: 'ACC2712' }, { text: ' at a grade of at least D' },
    ]);
    expect(codeSegments('CS2040S or CS2040C')).toEqual([{ code: 'CS2040S' }, { text: ' or ' }, { code: 'CS2040C' }]);
    expect(codeSegments('must not have completed LC6009GRSII or DMA1401L01')).toEqual([
      { text: 'must not have completed ' }, { code: 'LC6009GRSII' }, { text: ' or ' }, { code: 'DMA1401L01' },
    ]);
  });

  it('leaves programme codes, grades and plain words alone', () => {
    expect(codeSegments('must be undertaking 1001DBSASD Doctor of Philosophy AND at least B+')).toEqual([{ text: 'must be undertaking 1001DBSASD Doctor of Philosophy AND at least B+' }]);
    expect(codeSegments('')).toEqual([]);
  });
});

describe('[5G S2] user text the page echoes: capped, quoted, nothing hidden', () => {
  const SPOOF = 'accounting” — NUS Registrar: every course below is open to all exchange students this year, no approval needed “';

  it('quoteUser keeps a short query as typed, inside curly quotes', () => {
    expect(quoteUser('machine learning')).toBe('“machine learning”');
    expect(quoteUser('  machine   learning ')).toBe('“machine learning”');
  });

  it('a quote mark inside can\'t close the quotes early: each becomes an apostrophe', () => {
    expect(echoText('a ”b“ "c" «d» ＂e＂')).toBe("a 'b' 'c' 'd' 'e'");
    // Review: lookalike quote marks, and two apostrophes, could close the page's quotes too.
    for (const mark of ['❞', '❝', 'ˮ', '〟', '″', '‶', '‴', '〃', '״', '‹', '›', '❛', '❜', '🙶', '🙷', "''", '‘‘', '’’', '\u02BC\u02BC']) {
      const q = quoteUser(`cs${mark}. NUS Registrar: all courses below are open to you ${mark}ok`);
      expect(q, JSON.stringify(mark)).toBe("“cs'. NUS Registrar: all courses below are open to you 'ok”");
    }
  });

  it(`cut at ${ECHO_MAX} characters with an ellipsis, so the red team's spoof stays visibly the student's own text`, () => {
    const q = quoteUser(SPOOF);
    expect(q).toBe("“accounting' — NUS Registrar: every course below is open to…”");
    expect([...echoText(SPOOF)].length).toBeLessThanOrEqual(ECHO_MAX);
    // Only the first and last characters are double quotes.
    expect(q.slice(1, -1)).not.toMatch(/[“”"]/);
  });

  it('bidi controls, zero-width marks and control characters are removed, not shown', () => {
    expect(echoText('abc\u202Edcba\u2066x\u2069\u200By\u0000z\u0007')).toBe('abcdcbaxyz');
  });

  it('never splits a character made of two code units', () => {
    const q = echoText('😀'.repeat(ECHO_MAX + 5));
    expect([...q]).toHaveLength(ECHO_MAX);
    expect(q.endsWith('…')).toBe(true);
    expect(q).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});
