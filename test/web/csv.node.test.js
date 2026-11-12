// @ts-check
// The CSV export: public/export.js works the shortlist into the export's document,
// the same one the print page draws, and public/csv.js writes it as RFC 4180.
// Each file is read back by a strict reader written apart from the page
// (rfc4180.node.mjs), over /module answers built from the fixture
// (shortlist-answers.node.mjs) and synthetic answers where it has no such
// course.
import { describe, expect, it } from 'vitest';
import { EXCEL_HINT, guard, toCsv } from '../../public/csv.js';
import {
  CANVAS_LINE, DESCRIPTION_LABEL, SECTION, SITE_NAME, SITE_URL, buildExport, fileName,
} from '../../public/export.js';
import { parseList } from '../../public/list.js';
import { RULE_E, answerOf, workOut } from '../../public/shortlist.js';
import { parseState } from '../../public/state.js';
import { everyFieldQuoted, parseCsv } from './rfc4180.node.mjs';
import { REASONS_FILE, exchange, fixtureOutcome, ngListedOutcome, synthOutcome } from './shortlist-answers.node.mjs';

/** @type {import('../../public/shortlist.js').OffListRule[]} */
const RULES = REASONS_FILE.offListRules;
/** /facets' ngSources, as the Worker answers them. */
const SOURCES = REASONS_FILE.sources;
/** 12 Nov 2026, noon in Singapore. */
const TODAY = new Date(Date.UTC(2026, 10, 12, 4));

/** The fixture's ng-unscheduled.json EE4407, as /module's 404 detail answers it. */
const EE4407 = ngListedOutcome('EE4407', {
  title: 'Analog Electronics', description: 'This course builds on the basic concepts in electronics.', faculty: 'College of Design and Engineering',
  department: 'Electrical and Computer Engineering', ngSemesters: [1], workload: { lecture: 2, tutorial: 1, lab: 0.5, project: 1.5, prep: 5, total: 10 },
  prerequisite: null, gradingBasis: 'Graded', exchange: exchange({ 1: ['note', ['ng-list:nusmods-semester-differs']], 2: ['closed', ['ng-list:not-in-semester']] }),
});

/**
 * A link's export: its list worked out (shortlist.js) from the fixture's
 * answers, `extra` overriding a code's outcome, then the export's document.
 * @param {string} qs
 * @param {Record<string, any>} [extra]
 * @param {{ rules?: any, sources?: any }} [opts]
 */
function exportOf(qs, extra = {}, { rules = RULES, sources = SOURCES } = {}) {
  const params = new URLSearchParams(qs);
  const s = parseState(params);
  const { list } = parseList(params);
  const answers = new Map([...list.pick, ...list.alt].map((e) => [e.code, answerOf(e.code in extra ? extra[e.code] : fixtureOutcome(e.code))]));
  const result = workOut({ list, sem: s.sem, study: s.study, answers, rules });
  return buildExport({ result, list, study: s.study, sources, link: `${SITE_URL}/?${qs}`, today: TODAY, answers });
}

/**
 * The CSV of a link, read back strictly: the header, the entries' rows as
 * objects keyed by the header, and the label/value rows after the separator.
 * @param {string} qs
 * @param {Record<string, any>} [extra]
 * @param {{ rules?: any, sources?: any }} [opts]
 */
function csvOf(qs, extra = {}, opts = {}) {
  const text = toCsv(exportOf(qs, extra, opts));
  expect(text.startsWith('﻿')).toBe(true);
  const records = parseCsv(text.slice(1));
  const [header, ...rest] = records;
  const sep = rest.findIndex((r) => r.every((f) => f === ''));
  expect(sep).toBeGreaterThan(-1);
  const rows = rest.slice(0, sep).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
  const tail = rest.slice(sep + 1).map((r) => ({ label: r[0], value: r[1], rest: r.slice(2) }));
  return { text, records, header, rows, tail };
}
/** @param {Record<string, string>[]} rows @param {string} code */
const rowOf = (rows, code) => {
  const r = rows.find((x) => x.Code === code);
  if (!r) throw new Error(`${code} not in the CSV`);
  return r;
};

describe('the CSV: RFC 4180', () => {
  it('every field quoted, CRLF line ends, a byte-order mark, the header first, every row the header\'s field count', () => {
    const { text, records, header } = csvOf('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&alt=CS3244.1');
    expect(everyFieldQuoted(text.slice(1))).toBe(true);
    expect(text.slice(1).replace(/"(?:[^"]|"")*"/g, '')).not.toMatch(/(?<!\r)\n/);
    expect(header[0]).toBe('Section');
    expect(header).toContain('Code');
    expect(header).toContain(DESCRIPTION_LABEL);
    for (const r of records) expect(r).toHaveLength(header.length);
    // The separator row is padded too: a run of empty fields, not an empty line.
    expect(text).toContain(`\r\n${Array(header.length).fill('""').join(',')}\r\n`);
  });

  it('quotes are doubled, and commas and newlines in a description stay inside its field', () => {
    const description = 'Line one, with a comma and a "quoted" word.\nLine two\r\nand three.';
    const { rows } = csvOf('ng=1&study=ug2&pick=ZZ2001.1', { ZZ2001: synthOutcome('ZZ2001', { description }) });
    expect(rowOf(rows, 'ZZ2001')[DESCRIPTION_LABEL]).toBe(description);
  });

  it('the formula guard: a field starting with = + - @, a tab or a CR gets a leading apostrophe (SA4101C\'s text)', () => {
    // SA4101C's description as NUSMods serves it starts with "- " (§1: 4 catalogue courses do).
    const sa = '- Fundamentals of Programming using C# - Object Oriented Programming using C# - User Interface Development with Visual Studio Net and C# - SQL Programming & DBMS';
    const { rows } = csvOf('ng=1&study=ug2&pick=SA4101C.1', { SA4101C: synthOutcome('SA4101C', { description: sa }) });
    expect(rowOf(rows, 'SA4101C')[DESCRIPTION_LABEL]).toBe(`'${sa}`);
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) expect(guard(`${lead}1+1`)).toBe(`'${lead}1+1`);
    for (const safe of ['1+1', 'CS2113', "'=quoted", ' =spaced', '–dash']) expect(guard(safe)).toBe(safe);
  });

  it('curly quotes, dashes and ligatures (ﬃ) round-trip as UTF-8', () => {
    const description = 'The “post” in post‐colonial ― an eﬃcient course’s reading… ﬁne.';
    const { rows } = csvOf('ng=1&study=ug2&pick=ZZ2002.1', { ZZ2002: synthOutcome('ZZ2002', { description }) });
    expect(rowOf(rows, 'ZZ2002')[DESCRIPTION_LABEL]).toBe(description);
    expect(Buffer.from(toCsv(exportOf('ng=1&study=ug2&pick=ZZ2002.1', { ZZ2002: synthOutcome('ZZ2002', { description }) })), 'utf8').toString('utf8')).toContain('eﬃcient');
  });
});

describe('the CSV: each course\'s block', () => {
  it('a counted course: its form number, list and rank, semester, units, department, faculty, level, status, exam, workload, estimate, description, NUS\'s texts and its NUSMods link', () => {
    const { rows, header } = csvOf('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1');
    const r = rowOf(rows, 'CS2113');
    expect(r).toMatchObject({
      Section: 'Sem 1', Semester: 'Sem 1', List: 'Primary pick', Rank: '1', "NUS's application form": 'Application form, Sem 1: 1',
      Title: 'Software Engineering & Object-Oriented Programming', Units: '4', Department: 'Computer Science', Faculty: 'Computing',
      Level: 'Level 1000–3000, undergraduate', Grading: '', Counts: 'Counted, if NUS accepts you into it',
      'Exchange status': 'Sem 1 · Open to exchange students', NUSMods: 'https://nusmods.com/courses/CS2113',
    });
    expect(header).toContain('2026/27 exam');
    expect(r['2026/27 exam']).toBe('Mon 30 Nov 2026, 5:00 pm, 1 h 30 min (Singapore time)');
    expect(r['Workload (NUSMods)']).toBe('Lecture 2, tutorial 1, lab 0, project 3, preparation 4 hours a week (10 in all)');
    expect(r['Estimated study time']).toBe('About 10 hours a week (NUS\'s rate: 2.5 hours a week per unit). NUS states hours a week only; your university\'s own conversion decides credit.');
    expect(r[DESCRIPTION_LABEL]).toMatch(/^This course introduces the necessary skills/);
    expect(r.Prerequisite).toMatch(/^If undertaking an Undergraduate Degree THEN/);
    expect(r["NUS's notes"]).toMatch(/extremely oversubscribed/);
    // GE2101's quota note in full, with its source and date.
    expect(rowOf(rows, 'GE2101')['Exchange notes']).toMatch(/^Places\. .*\(NG restrictions, updated 31 Aug 2026\)\.$/);
  });

  it('workload: as listed, each part labelled; no lecture, tutorial or lab hours; not listed; NUS\'s raw text', () => {
    const { rows } = csvOf('ng=1&study=ug2&pick=AH3204.1&pick=ZZ2003.1&pick=ZZ2004.1&pick=ZZ2005.1', {
      AH3204: synthOutcome('AH3204', { workload: { lecture: 0, tutorial: 0, lab: 0, project: 6, prep: 4, total: 10 } }),
      ZZ2003: synthOutcome('ZZ2003', { workload: null }),
      ZZ2004: synthOutcome('ZZ2004', { workload: { raw: '3-.5-0--0-6.5' } }),
      ZZ2005: synthOutcome('ZZ2005', { workload: { lecture: 3, tutorial: 0, lab: 0, project: 0, prep: 6, total: 9 } }),
    });
    expect(rowOf(rows, 'AH3204')['Workload (NUSMods)']).toBe('Lecture 0, tutorial 0, lab 0, project 6, preparation 4 hours a week (10 in all). NUSMods lists no lecture, tutorial or lab hours');
    expect(rowOf(rows, 'ZZ2003')['Workload (NUSMods)']).toBe('Not listed');
    expect(rowOf(rows, 'ZZ2004')['Workload (NUSMods)']).toBe('As NUS lists it: 3-.5-0--0-6.5');
    // CS3230-like: NUSMods' own total differs from NUS's rate, and is named.
    expect(rowOf(rows, 'ZZ2005')['Estimated study time']).toBe('About 10 hours a week (NUS\'s rate: 2.5 hours a week per unit); NUSMods lists 9 hours a week for this course. NUS states hours a week only; your university\'s own conversion decides credit.');
  });

  it('0 units, no exam, and an NG-listed course with no classes (its exam timetable not published)', () => {
    const { rows } = csvOf('ng=1&study=ug2&pick=ZZ2006.1&pick=EE4407.1', { ZZ2006: synthOutcome('ZZ2006', { credits: 0 }), EE4407 });
    const zero = rowOf(rows, 'ZZ2006');
    expect(zero.Units).toBe('0');
    expect(zero['Estimated study time']).toMatch(/^NUS lists it as 0 units, so NUS's rate gives no hours\./);
    expect(zero['2026/27 exam']).toBe('No final exam listed');
    const ee = rowOf(rows, 'EE4407');
    expect(ee).toMatchObject({ Section: 'Sem 1', Level: 'Level 4000, Honours', '2026/27 exam': 'Exam timetable not published in NUSMods' });
    expect(ee.Counts).toBe('To confirm with NUS: NUS lists it for Sem 1 in 2026/27, but NUSMods shows no classes: ask NUS.');
    expect(ee['Workload (NUSMods)']).toBe('Lecture 2, tutorial 1, lab 0.5, project 1.5, preparation 5 hours a week (10 in all)');
  });

  it('grading when not "Graded"; a level 5000 course as graduate', () => {
    const { rows } = csvOf('ng=1&study=grad&pick=ZZ5001.1', { ZZ5001: synthOutcome('ZZ5001', { gradingBasis: 'Completed Satisfactory/Unsatisfactory' }) });
    expect(rowOf(rows, 'ZZ5001')).toMatchObject({ Grading: 'Completed Satisfactory/Unsatisfactory', Level: 'Level 5000 and above, graduate' });
  });

  it('flags and the same course: CS2030 and CS2113 share an exam slot; a duplicate says which course it repeats', () => {
    const { rows } = csvOf('ng=1&study=ug2&pick=CS2030.1&alt=CS2113.1');
    expect(rowOf(rows, 'CS2030').Flags).toMatch(/^CS2030 and CS2113: their 2026\/27 exams overlap\./);
    expect(rowOf(rows, 'CS2113').Flags).toMatch(/^CS2030 and CS2113: their 2026\/27 exams overlap\./);
    // Browse mode (no study level): CS2030S is the same course as CS2030.
    const browse = csvOf('pick=CS2030.1&pick=CS2030S.1').rows;
    expect(rowOf(browse, 'CS2030S')).toMatchObject({ Section: 'Sem 1', Counts: 'Not counted: the same course as CS2030.', 'Exchange status': 'Not checked: no year of study set' });
    expect(rowOf(browse, 'CS2030').Counts).toBe('Counted: exchange status not checked');
  });
});

describe('the CSV: grouped by semester, then closed, then not placed', () => {
  it('Sem 1 then Sem 2, primary picks then backups in rank order, then the closed and the not-placed sections', () => {
    const qs = 'ng=1&study=ug2&sem=2&pick=CS2030.2&pick=CS3244.1&pick=CS2113.1&pick=BL5240.1&pick=CS9999.1&alt=GE2101.1&alt=CS2030S&alt=ZZ1001.1';
    const { rows } = csvOf(qs, {
      CS9999: { kind: 'error', error: { status: 404, code: 'not_found', detail: { kind: 'unknown', acadYear: '2026-2027' } } },
      ZZ1001: { kind: 'error', error: { status: 404, code: 'not_found', detail: { kind: 'catalogue-only', title: 'Old Programming', description: 'Taught before.', acadYear: '2026-2027' } } },
    });
    expect(rows.map((r) => [r.Section, r.Code])).toEqual([
      ['Sem 1', 'CS2113'], ['Sem 1', 'GE2101'],
      ['Sem 2', 'CS2030'],
      [SECTION.closed, 'CS3244'],
      [SECTION.unplaced, 'BL5240'], [SECTION.unplaced, 'CS9999'], [SECTION.unplaced, 'CS2030S'], [SECTION.unplaced, 'ZZ1001'],
    ]);
    // Off the Sem 1 list: rule E's line.
    expect(rowOf(rows, 'CS3244').Counts).toBe(`Not counted: not on NUS's 2026/27 exchange course list for Sem 1. Courses not on the list “are ${RULE_E}” (the Registrar's course restrictions, rule E).`);
    expect(rowOf(rows, 'CS3244')["NUS's application form"]).toBe('Not on the form: not open in Sem 1');
    expect(rowOf(rows, 'BL5240').Counts).toBe('Not counted: taught only in special terms: this page plans Sem 1 and Sem 2.');
    expect(rowOf(rows, 'CS9999')).toMatchObject({ Title: 'No course with this code', Counts: 'Not counted: no course with this code in 2026/27.', 'Exchange status': 'No course with this code in 2026/27' });
    expect(rowOf(rows, 'ZZ1001')).toMatchObject({ Title: 'Old Programming', [DESCRIPTION_LABEL]: 'Taught before.', Counts: 'Not counted: not offered in 2026/27.' });
    // An untagged backup.
    expect(rowOf(rows, 'CS2030S')).toMatchObject({ Semester: 'No semester chosen', List: 'Backup', Rank: '2', Counts: 'Not counted: no semester chosen.' });
  });

  it('with /facets failed, an off-list closed entry says to ask NUS whether it can be added later, and the dates are unavailable', () => {
    const { rows, tail } = csvOf('ng=1&study=ug2&pick=CS3244.1', {}, { rules: null, sources: null });
    expect(rowOf(rows, 'CS3244').Counts).toBe('Not counted: not on NUS\'s 2026/27 exchange course list for Sem 1: ask NUS whether it can be added later.');
    expect(tail.find((t) => t.label === 'Lists')?.value).toBe('NG course list updated as at: date unavailable; NG course restrictions updated as at: date unavailable');
  });
});

describe('the CSV: head, totals and foot as label/value rows', () => {
  it('the head: what it plans and on which year\'s data, the year of study, the date, the shortlist link, the later-year line and the site', () => {
    const qs = 'ng=1&study=ug3&sem=1&pick=CS2113.1&pick=CS2030.2';
    const { tail } = csvOf(qs);
    const value = (/** @type {string} */ label) => tail.find((t) => t.label === label)?.value;
    expect(value('Shortlist')).toBe('Courses planned for Sem 1 and Sem 2, based on NUS\'s 2026/27 courses, exams and exchange list');
    expect(value('Year of study during the exchange')).toBe('3');
    expect(value('Made on')).toBe('12 Nov 2026');
    expect(value('Shortlist link')).toBe(`${SITE_URL}/?${qs}`);
    expect(value('For a later year')).toBe('For a later year, check that year\'s: NUS publishes the exchange course list in March or April and updates it later (this one is dated 1 Sep 2026), and publishes the course descriptions and exam timetable in July or August (NUS Global; the Registrar says the timetable comes mid-July).');
    expect(value('Made with')).toBe(`${SITE_NAME}, ${SITE_URL}`);
    for (const t of tail) expect(t.rest.every((f) => f === '')).toBe(true);
  });

  it('per semester: units counted, then to confirm, the hours at NUS\'s rate, GRO\'s 13 weeks, and NUS\'s minimum and maximum (word for word)', () => {
    const { tail } = csvOf('ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.2');
    const sem1 = tail.filter((t) => t.label === 'Sem 1 totals').map((t) => t.value);
    expect(sem1[0]).toBe('Sem 1: 4 units picked, if NUS accepts you into each');
    expect(sem1).toContain('About 10 hours a week at NUS\'s rate (2.5 hours a week per unit)');
    expect(sem1).toContain('GRO: “Each semester normally includes 13 weeks of instruction and 2 weeks of examinations”');
    expect(sem1).toContain('NUS’s brochure says at most 23 units a semester, but NUS Global’s exchange page says 20 (NUS Business School’s exchange students: 20). Ask NUS before planning more than 20.');
    const sem2 = tail.filter((t) => t.label === 'Sem 2 totals').map((t) => t.value);
    expect(sem2[0]).toBe('Sem 2: 0 units picked, if NUS accepts you into each');
    expect(sem2).toContain('plus 4 units to confirm with NUS');
    expect(tail.findIndex((t) => t.label === 'Sem 1 totals')).toBeLessThan(tail.findIndex((t) => t.label === 'Sem 2 totals'));
  });

  it('the foot: the form order, the lines for applicants, the CourseReg box, the Canvas line, transfer of units, the lists\' dates, what isn\'t checked, unofficial, and the Excel hint', () => {
    const { tail } = csvOf('ng=1&study=ug2&sem=1&pick=CS2113.1&alt=GE2101.1');
    const values = tail.map((t) => t.value);
    expect(tail.filter((t) => t.label === "NUS's application form, Sem 1").map((t) => t.value)).toEqual([
      'Sem 1 on NUS\'s form: 8 of 40 units', '1: CS2113, pick 1, 4 units', '2: GE2101, backup 1, 4 units',
    ]);
    expect(values).toContain('NUS recommends listing as many relevant courses as you can, up to 40 units (GRO)');
    expect(values).toContain('This page can\'t see your offer. Your offer and CourseReg show which courses are yours.');
    expect(values).toContain(CANVAS_LINE);
    expect(values).toContain('“Transfer of units is entirely at the discretion of your home university” (GRO)');
    expect(values).toContain('NG course list updated as at 01 Sep 2026; NG course restrictions updated as at 31 Aug 2026');
    expect(values).toContain('Class times and corequisites aren\'t checked here');
    expect(values).toContain('Unofficial. Check with NUS before you register.');
    expect(tail.at(-1)).toMatchObject({ label: 'Excel', value: EXCEL_HINT });
    expect(EXCEL_HINT).toBe('Excel shows one column? Use Data › From Text/CSV.');
  });
});

describe('the file name', () => {
  it('from the semesters present and the rows\' year; no semester part when no entry has one', () => {
    expect(fileName(exportOf('ng=1&study=ug2&pick=CS2113.1'), 'csv')).toBe('exchange-shortlist-sem1-2026-27-courses.csv');
    expect(fileName(exportOf('ng=1&study=ug2&pick=CS2113.1&alt=CS2030.2'), 'csv')).toBe('exchange-shortlist-sem1-sem2-2026-27-courses.csv');
    expect(fileName(exportOf('ng=1&study=ug2&pick=CS2113&alt=CS2030'), 'csv')).toBe('exchange-shortlist-2026-27-courses.csv');
    expect(exportOf('ng=1&study=ug2&pick=CS2030.2').stem).toBe('exchange-shortlist-sem2-2026-27-courses');
  });

  it('names only the semesters the document plans: an entry not placed (special terms only, an unknown 404) or closed adds none', () => {
    const unknown = { CS9999: { kind: 'error', error: { status: 404, code: 'not_found', detail: { kind: 'unknown', acadYear: '2026-2027' } } } };
    for (const [qs, extra] of /** @type {[string, Record<string, any>][]} */ ([
      ['ng=1&study=ug2&sem=1&pick=CS2113.1&pick=BL5240.2', {}],
      ['ng=1&study=ug2&sem=1&pick=CS2113.1&pick=CS9999.2', unknown],
      ['ng=1&study=ug2&sem=1&pick=CS2113.1&pick=GE2101.1&pick=CS3244.2', { CS3244: synthOutcome('CS3244', { exchange: exchange({ 1: ['open', []], 2: ['closed', ['ng-list:not-in-semester']] }) }) }],
    ])) {
      const doc = exportOf(qs, extra);
      expect(doc.stem, qs).toBe('exchange-shortlist-sem1-2026-27-courses');
      expect(doc.title, qs).toBe('Courses planned for Sem 1, based on NUS\'s 2026/27 courses, exams and exchange list');
      expect(doc.sections.map((x) => x.id), qs).not.toContain('2');
    }
  });
});
