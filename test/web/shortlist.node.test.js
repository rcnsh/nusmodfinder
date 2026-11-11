// @ts-check
// public/shortlist.js (Phase 6 6B; docs/plans/phase6.md 6B "Tests first"):
// counting, the same course, NUS's form order, totals, flags and NUS's notes,
// over /module answers built from the fixture and its groups
// (shortlist-answers.node.mjs), with synthetic answers where the fixture has
// no such course. The seeded property test checks the totals against a
// reference written separately, here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { yearNote } from '../../src/year-note.js';
import { parseList } from '../../public/list.js';
import {
  APPLICANT_LINES, BIZ_LAW, COURSEREG_BOX, FORM_LINES, GRO_POPULAR, NOTES, RULE_E, TOTAL_LINES,
  answerOf, exportQuestion, openSems, semChoices, staleRows, summary, totalLines, workOut, yearLabel, yearLine,
} from '../../public/shortlist.js';
import { parseState } from '../../public/state.js';
import { DEFAULT_ACAD_YEAR } from '../../public/year.js';
import { FIXTURE, GROUP_OF, REASONS_FILE, exchange, fixtureOutcome, ngListedOutcome, synthOutcome } from './shortlist-answers.node.mjs';

/** /facets' offListRules (6A), with each rule's scope as NUS states it. */
const RULES = [
  { id: 'E-offerings-list', text: `If the courses cannot be found at the Course offerings list, they are ${RULE_E}.`, scope: null },
  { id: '4-cee-no-appeal', text: 'No appeal will be accepted for any Level 1000 to Level 4000 courses that are not listed in the NG Course offerings list.', scope: { department: 'Civil and Environmental Engineering', levels: [1000, 2000, 3000, 4000] } },
  { id: '4-isem-no-appeal', text: 'No appeals will be accepted for any level 1000 to level 4000 courses that are not listed in the NG courses listing.', scope: { department: 'Industrial Systems Engineering and Management', levels: [1000, 2000, 3000, 4000] } },
  { id: '2-biz-no-late-add', text: 'If you have not been offered Business courses at the point of initial acceptance, you will not be able to add the Course.', scope: { faculty: 'NUS Business School' } },
];

/**
 * Works out a link's shortlist, every code answered from the fixture unless
 * `extra` gives its outcome (a synthetic row, a 404, or null: still loading).
 * @param {string} qs
 * @param {Record<string, any>} [extra]
 * @param {{ rules?: any }} [opts]
 */
function run(qs, extra = {}, { rules = RULES } = {}) {
  const params = new URLSearchParams(qs);
  const s = parseState(params);
  const { list } = parseList(params);
  const answers = new Map([...list.pick, ...list.alt].map((e) => [e.code, answerOf(e.code in extra ? extra[e.code] : fixtureOutcome(e.code))]));
  return workOut({ list, sem: s.sem, study: s.study, answers, rules });
}
/** @param {import('../../public/shortlist.js').Result} r @param {string} code */
const at = (r, code) => {
  const w = r.entries.find((x) => x.code === code);
  if (!w) throw new Error(`${code} not in the result`);
  return w;
};
/** @param {import('../../public/shortlist.js').Result} r @param {string} code */
const number = (r, code) => at(r, code).form.number;

describe('counting (6B)', () => {
  it('open picks count; condition notes count "if NUS accepts you into each"; other notes are to confirm', () => {
    // GE2101 in Sem 1 at ug2: a quota note (a condition); in Sem 2 NUSMods shows no classes (a `semester` note).
    const r = run('ng=1&study=ug2&pick=CS2113.1&pick=GE2101.1&pick=GE2101.2');
    expect(at(r, 'CS2113')).toMatchObject({ standing: 'counted', why: 'Counted' });
    expect(at(r, 'GE2101')).toMatchObject({ standing: 'counted', why: 'Counted, if NUS accepts you: read its notes' });
    expect(r.sems[1]).toMatchObject({ counted: 8, confirm: 0 });
    const s2 = run('ng=1&study=ug2&pick=GE2101.2');
    expect(at(s2, 'GE2101')).toMatchObject({ standing: 'confirm', why: 'To confirm with NUS: read its notes' });
    expect(s2.sems[2]).toMatchObject({ counted: 0, confirm: 4 });
  });

  it('a closed pick isn\'t counted and says why; off the list, with rule E\'s line', () => {
    const r = run('ng=1&study=ug2&pick=CS3244.1&pick=CS5562.2&pick=PF2504.1', {}, {});
    expect(at(r, 'CS3244')).toMatchObject({ standing: 'out', why: `Not on NUS's 2026/27 exchange course list for Sem 1. Courses not on the list “are ${RULE_E}” (the Registrar's course restrictions, rule E)` });
    expect(at(r, 'CS5562').why).toMatch(/^Not on NUS's 2026\/27 exchange course list for Sem 2\./);
    // PF2504 in Sem 1: on NUS's list, but NUSMods shows no classes then (to confirm).
    expect(r.sems[1]).toMatchObject({ counted: 0, confirm: 4 });
    expect(r.sems[2]).toMatchObject({ counted: 0, confirm: 0 });
    // A closed course for another reason: PF2504 at grad.
    expect(at(run('ng=1&study=grad&pick=PF2504.1'), 'PF2504')).toMatchObject({ standing: 'out', why: 'Not open to exchange students in Sem 1' });
  });

  it('with /facets failed (no rules), an off-list entry says to ask NUS whether it can be added later', () => {
    expect(at(run('ng=1&study=ug2&pick=CS3244.1', {}, { rules: null }), 'CS3244').why)
      .toBe('Not on NUS\'s 2026/27 exchange course list for Sem 1: ask NUS whether it can be added later');
  });

  it('a no-appeal rule\'s own text, by department never by code prefix; GRO\'s sentence for an EC code', () => {
    const offS2 = exchange({ 1: ['open', []], 2: ['closed', ['ng-list:not-listed']] });
    const r = run('ng=1&study=ug2&pick=CE2183.2&pick=ESE2001.2&pick=EC3304.2&pick=GEC1028.2', {
      CE2183: synthOutcome('CE2183', { department: 'Civil and Environmental Engineering', exchange: offS2 }),
      ESE2001: synthOutcome('ESE2001', { department: 'Civil and Environmental Engineering', exchange: offS2 }),
      EC3304: synthOutcome('EC3304', { department: 'Economics', exchange: offS2 }),
      GEC1028: synthOutcome('GEC1028', { department: 'Economics', exchange: offS2 }),
    });
    for (const code of ['CE2183', 'ESE2001']) expect(at(r, code).why).toContain(RULES[1].text);
    expect(at(r, 'EC3304').why).toContain(`GRO: “${GRO_POPULAR}”`);
    expect(at(r, 'GEC1028').why).toContain(RULE_E);
  });

  it('a catalogue-only or unknown 404, not loaded, null units, no semester, special terms only: not counted, each saying why', () => {
    const r = run('ng=1&study=ug2&pick=CS1010J.1&pick=CS9999.1&pick=CS2030.1&pick=CS2113.1&pick=GE2101&pick=BL5240.1&pick=NUL1000.1', {
      CS1010J: { kind: 'error', error: { code: 'not_found', status: 404, detail: { kind: 'catalogue-only', title: 'Programming Methodology', acadYear: '2026-2027' } } },
      CS9999: { kind: 'error', error: { code: 'not_found', status: 404 } },
      CS2030: null,
      CS2113: { kind: 'error', error: { code: 'timeout' } },
      NUL1000: synthOutcome('NUL1000', { credits: null }),
    });
    expect(at(r, 'CS1010J')).toMatchObject({ standing: 'out', why: 'Not offered in 2026/27', title: 'Programming Methodology' });
    expect(at(r, 'CS9999')).toMatchObject({ standing: 'out', why: 'No course with this code in 2026/27' });
    expect(at(r, 'CS2030').standing).toBe('pending');
    expect(at(r, 'CS2113').standing).toBe('pending');
    expect(at(r, 'GE2101')).toMatchObject({ standing: 'out', why: 'No semester chosen' });
    expect(at(r, 'BL5240')).toMatchObject({ standing: 'out', why: 'Taught only in special terms: this page plans Sem 1 and Sem 2' });
    expect(at(r, 'NUL1000')).toMatchObject({ standing: 'out', why: 'NUS lists no units for it' });
    expect(r.sems[1]).toMatchObject({ counted: 0, pending: 2 });
    expect(totalLines('1', r.sems[1], r)[0]).toBe('Sem 1: at least 0 units picked, if NUS accepts you into each');
  });

  it('sums in tenths: 2.5 + 1.5 is 4; 0 units count as 0', () => {
    const r = run('ng=1&study=ug2&pick=AB1001.1&pick=AB1002.1&pick=AB1003.1', {
      AB1001: synthOutcome('AB1001', { credits: 2.5 }), AB1002: synthOutcome('AB1002', { credits: 1.5 }), AB1003: synthOutcome('AB1003', { credits: 0 }),
    });
    expect(r.sems[1].counted).toBe(4);
    expect(r.sems[1].hours).toBe(10);
  });

  it('browse mode: a pick counts by its units if taught in its semester; "exchange status not checked"; no form number, the "set your year" line', () => {
    const r = run('pick=CS5562.2&pick=CS3244.1&pick=CS2030.2&view=shortlist');
    expect(r.exchange).toBe(false);
    expect(at(r, 'CS5562')).toMatchObject({ standing: 'counted', why: 'Counted: exchange status not checked', form: { number: null, text: FORM_LINES.setYear } });
    expect(at(run('pick=CS5562.1'), 'CS5562')).toMatchObject({ standing: 'out', why: 'Not taught in Sem 1' });
    expect(r.sems[2].counted).toBe(8);
    expect(totalLines('2', r.sems[2], r)[0]).toBe('Sem 2: 8 units picked, exchange status not checked');
  });

  it('exports: every entry is worked out at its own semester, whatever the state\'s sem', () => {
    const r = run('sem=1&ng=1&study=ug2&pick=CS2113.1&pick=CS2030.2');
    expect(at(r, 'CS2113').standing).toBe('counted');
    expect(at(r, 'CS2030')).toMatchObject({ sem: '2', standing: 'counted', status: 'open' });
    expect(r.sems[2].counted).toBe(4);
    expect(r.order).toEqual(['1', '2']);
    expect(run('sem=2&ng=1&study=ug2&pick=CS2113.1').order).toEqual(['2', '1']);
  });
});

describe('NG-listed codes with no classes (404 kind ng-listed, 6A)', () => {
  const EE4407 = ngListedOutcome('EE4407', {
    title: 'Selected Topics', department: 'Electrical and Computer Engineering', faculty: 'College of Design and Engineering', ngSemesters: [1],
    exchange: exchange({ 1: ['open', []], 2: ['closed', ['ng-list:not-in-semester']] }),
  });
  it('worked out like a row from its exchange: open, it is to confirm, never counted, and takes a form number', () => {
    const r = run('ng=1&study=ug2&pick=EE4407.1', { EE4407: EE4407 });
    expect(at(r, 'EE4407')).toMatchObject({
      kind: 'ng-listed', standing: 'confirm', units: 4, why: 'NUS lists it for Sem 1 in 2026/27, but NUSMods shows no classes: ask NUS', form: { number: 1 },
    });
    expect(r.sems[1]).toMatchObject({ counted: 0, confirm: 4 });
  });
  it('a tag outside the semesters NUS lists it for is closed', () => {
    expect(at(run('ng=1&study=ug2&pick=EE4407.2', { EE4407: EE4407 }), 'EE4407')).toMatchObject({ standing: 'out', why: 'Not on NUS\'s exchange list for Sem 2 in 2026/27' });
  });
  it('NUS\'s restrictions close it as any course: PF2102 and PF2505 at grad in Sem 1', () => {
    const closedGrad = exchange({ 1: ['note', ['4-be-quota']], 2: ['note', ['4-be-quota']] }, { grad: { 1: ['closed', ['4-be-l1234-grad']] } });
    const extra = {
      PF2102: ngListedOutcome('PF2102', { ngSemesters: [1, 2], exchange: closedGrad }),
      PF2505: ngListedOutcome('PF2505', { ngSemesters: [1, 2], exchange: closedGrad }),
    };
    const r = run('ng=1&study=grad&pick=PF2102.1&pick=PF2505.1', extra);
    for (const code of ['PF2102', 'PF2505']) expect(at(r, code)).toMatchObject({ standing: 'out', why: 'Not open to exchange students in Sem 1' });
    expect(at(run('ng=1&study=ug2&pick=PF2102.1', extra), 'PF2102').standing).toBe('confirm');
  });
  it('a Business 404 detail is treated as Business; its semester buttons are those NUS lists it for', () => {
    const biz = ngListedOutcome('FIN3701B', { faculty: 'NUS Business School', ngSemesters: [1, 2], exchange: exchange({ 1: ['note', ['2-biz-major']], 2: ['note', ['2-biz-major']] }) });
    expect(at(run('ng=1&study=ug2&pick=FIN3701B.1', { FIN3701B: biz }), 'FIN3701B')).toMatchObject({ faculty: 'biz', standing: 'invite' });
    expect(semChoices(answerOf(biz), 'ug2')).toEqual([1, 2]);
    expect(semChoices(answerOf(EE4407), '')).toEqual([1]);
  });
});

describe('the same course (6B)', () => {
  it('two codes in one group are the same course when both are on the NG list, or either\'s preclusion names the other', () => {
    // CS2030S is off the NG list, but its preclusion names CS2030 (and CS2030's names it).
    expect(at(run('ng=1&study=ug2&pick=CS2030S.1&pick=CS2030.1'), 'CS2030').standing).toBe('counted');
    const r = run('ng=1&study=ug2&pick=CS2030S.1&pick=CS2030.1');
    expect(r.sems[1].counted).toBe(4);
    const browse = run('pick=CS2030.1&pick=CS2030S.1');
    expect(browse.sems[1].counted).toBe(4);
    expect(at(browse, 'CS2030S')).toMatchObject({ standing: 'duplicate', why: 'The same course as CS2030', flags: [] });
    expect(at(browse, 'CS2030').flags).toEqual([]);
  });

  it('closed entries never take part: GES1034 closed in Sem 2 leaves GESS1024 numbered 1; CS2030S off the list leaves CS2030 numbered 1', () => {
    expect(number(run('ng=1&study=ug2&pick=GES1034.2&alt=GESS1024.1'), 'GESS1024')).toBe(1);
    expect(number(run('ng=1&study=ug2&pick=CS2030S.1&alt=CS2030.1'), 'CS2030')).toBe(1);
  });

  it('GES1034 then GESS1024 and the reverse: the first counted, the other "the same course"', () => {
    for (const [a, b] of [['GES1034', 'GESS1024'], ['GESS1024', 'GES1034']]) {
      const r = run(`ng=1&study=ug2&pick=${a}.1&pick=${b}.1`);
      expect(at(r, a).standing).toBe('counted');
      expect(at(r, b)).toMatchObject({ standing: 'duplicate', sameAs: a });
      expect(r.sems[1].counted).toBe(4);
    }
  });

  it('NGN2001G (counted) is kept over NGN2001D (an NG-listed 404, to confirm) whichever comes first', () => {
    const NGN2001D = ngListedOutcome('NGN2001D', { ngSemesters: [1], otherCodes: ['NGN2001F', 'NGN2001G'], exchange: exchange({ 1: ['open', []], 2: ['closed', ['ng-list:not-in-semester']] }) });
    for (const qs of ['ng=1&study=ug2&pick=NGN2001G.1&pick=NGN2001D.1', 'ng=1&study=ug2&pick=NGN2001D.1&pick=NGN2001G.1']) {
      const r = run(qs, { NGN2001D });
      expect(at(r, 'NGN2001G').standing).toBe('counted');
      expect(at(r, 'NGN2001D')).toMatchObject({ standing: 'duplicate', why: 'The same course as NGN2001G' });
      expect(r.sems[1]).toMatchObject({ counted: 4, confirm: 0 });
    }
  });

  it('settled once for the year: CS2030DE first is kept, with sem=1 and sem=2', () => {
    for (const sem of ['1', '2']) {
      const r = run(`sem=${sem}&ng=1&study=ug2&pick=CS2030DE.2&pick=GE2101.1&pick=CS2030.1`);
      expect(at(r, 'CS2030DE').standing).toBe('counted');
      expect(at(r, 'CS2030')).toMatchObject({ standing: 'duplicate', sameAs: 'CS2030DE' });
    }
  });

  it('uninvited Business: ACC1701XB first is kept (to confirm, only if invited); XA the same course', () => {
    const r = run('ng=1&study=ug2&pick=ACC1701XB.1&pick=ACC1701XA.1');
    expect(at(r, 'ACC1701XB')).toMatchObject({ standing: 'invite' });
    expect(at(r, 'ACC1701XA')).toMatchObject({ standing: 'duplicate', sameAs: 'ACC1701XB' });
    // Business and Law units sit on a line of their own, out of the to-confirm sum (6B "Business and Law").
    expect(r.sems[1]).toMatchObject({ counted: 0, confirm: 0, invite: 4 });
  });

  it('a backup the same course as a kept pick, or an earlier kept backup, is a neutral duplicate: no number, no sum, no flag', () => {
    const r = run('ng=1&study=ug2&inv=biz&pick=ACC1701XA.1&alt=ACC1701XB.1&alt=ACC1701XC.1&alt=ACC1701XC');
    expect(at(r, 'ACC1701XB')).toMatchObject({ standing: 'duplicate', sameAs: 'ACC1701XA', form: { number: null }, flags: [] });
    expect(at(r, 'ACC1701XC')).toMatchObject({ standing: 'duplicate', sameAs: 'ACC1701XA', form: { number: null }, flags: [] });
    expect(at(r, 'ACC1701XA').flags).toEqual([]);
    expect(r.sems[1].form?.units).toBe(4);
  });

  it('compared only with entries kept: CS2103, CS2103DE, CS2103R (not transitive)', () => {
    const extra = {
      CS2103: synthOutcome('CS2103', { ng: false, otherCodes: ['CS2103DE', 'CS2103R'], preclusion: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of CS2103DE/CS2103T/CS2113/CS2113T at a grade of at least D)' }),
      CS2103DE: synthOutcome('CS2103DE', { ng: false, otherCodes: ['CS2103', 'CS2103R'], preclusion: 'If undertaking an Undergraduate DegreeTHEN(( must not have completed 1 of CS2103/CS2103R/CS2103T/CS2113/CS2113T at a grade of at least D)AND(must not be undertaking 0300CSMIN Computer Science (Minor)))' }),
      CS2103R: synthOutcome('CS2103R', { ng: false, otherCodes: ['CS2103', 'CS2103DE'], preclusion: null }),
    };
    const r = run('pick=CS2103.1&pick=CS2103DE.2&pick=CS2103R.1', extra);
    // CS2103 kept; CS2103DE names it: the same; CS2103R and CS2103 name neither: both kept.
    expect(r.entries.map((w) => [w.code, w.standing])).toEqual([['CS2103', 'counted'], ['CS2103DE', 'duplicate'], ['CS2103R', 'counted']]);
    expect(at(r, 'CS2103R').flags.map((f) => f.kind)).toEqual(['group']);
  });

  it('other group members both count, with the check line and the overlap flag (EC4660 and HY4660)', () => {
    const exam = [{ sem: 1, date: '2026-11-25T05:00:00.000Z', durationMins: 120 }];
    const off = exchange({ 1: ['closed', ['ng-list:not-listed']], 2: ['closed', ['ng-list:not-listed']] });
    const r = run('pick=EC4660.1&pick=HY4660.1', {
      EC4660: synthOutcome('EC4660', { ng: false, exchange: off, examDates: exam, otherCodes: ['HY4660'] }),
      HY4660: synthOutcome('HY4660', { ng: false, exchange: off, examDates: exam, otherCodes: ['EC4660'] }),
    });
    expect(r.sems[1].counted).toBe(8);
    expect(at(r, 'EC4660').flags.map((f) => f.kind).sort()).toEqual(['exam', 'group']);
    expect(at(r, 'HY4660').flags.find((f) => f.kind === 'group')?.text).toBe('NUSMods lists these with the same title: check they are different courses');
  });
});

describe('NUS\'s application form order (6B, G5)', () => {
  /** n synthetic courses, `units` each, open in both semesters. @param {string} prefix @param {number} n @param {number} units */
  const many = (prefix, n, units = 4) => Object.fromEntries(Array.from({ length: n }, (_, i) => {
    const code = `${prefix}${1000 + i}`;
    return [code, synthOutcome(code, { credits: units })];
  }));
  /** @param {Record<string, any>} extra @param {string} sem */
  const picks = (extra, sem) => Object.keys(extra).map((c) => `pick=${c}.${sem}`).join('&');

  it('Move up changes the order: pick=A.1&pick=B.1 then "Move up, B" numbers B 1', () => {
    const extra = { AA1001: synthOutcome('AA1001'), BB1002: synthOutcome('BB1002') };
    expect(number(run('ng=1&study=ug2&pick=AA1001.1&pick=BB1002.1', extra), 'BB1002')).toBe(2);
    expect(number(run('ng=1&study=ug2&pick=BB1002.1&pick=AA1001.1', extra), 'BB1002')).toBe(1);
  });

  it('a closed pick, a duplicate and an audition pick take no number', () => {
    const audition = synthOutcome('MUA3224', { exchange: exchange({ 1: ['note', ['6-music-audition']], 2: ['note', ['6-music-audition']] }) });
    const r = run('ng=1&study=ug2&pick=CS3244.1&pick=GES1034.1&pick=GESS1024.1&pick=MUA3224.1', { MUA3224: audition });
    expect(r.entries.map((w) => [w.code, w.form.number])).toEqual([['CS3244', null], ['GES1034', 1], ['GESS1024', null], ['MUA3224', null]]);
    expect(at(r, 'MUA3224')).toMatchObject({ standing: 'confirm', audition: true, why: 'Apply separately: see the note', form: { text: 'Apply separately: see the note' } });
    expect(r.sems[1].confirm).toBe(4);
  });

  it('ten 4-unit entries all fit; an eleventh is marked "won\'t fit"', () => {
    const extra = many('AB', 11);
    const r = run(`ng=1&study=ug2&${picks(extra, '1')}`, extra);
    expect(r.entries.map((w) => w.form.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]);
    expect(r.entries[10].form.text).toBe(FORM_LINES.over);
    expect(r.sems[1].form?.line).toBe('Sem 1 on NUS\'s form: 40 of 40 units');
  });

  it('nine 4-unit then a 5-unit (41): the 5-unit is marked', () => {
    const extra = { ...many('AB', 9), CD2000: synthOutcome('CD2000', { credits: 5 }) };
    expect(number(run(`ng=1&study=ug2&${picks(extra, '1')}`, extra), 'CD2000')).toBeNull();
  });

  it('nine 4-unit, an 8-unit, then a 4-unit: the 8 is marked, the last 4 numbered 10', () => {
    const extra = { ...many('AB', 9), CD2000: synthOutcome('CD2000', { credits: 8 }), EF3000: synthOutcome('EF3000') };
    const r = run(`ng=1&study=ug2&${picks(extra, '1')}`, extra);
    expect(at(r, 'CD2000').form).toMatchObject({ number: null, text: FORM_LINES.over });
    expect(number(r, 'EF3000')).toBe(10);
  });

  it('nine 4-unit picks then two Business entries: unticked 1–9 and "only if invited", 36 of 40; ticked, 1–10 and the second won\'t fit', () => {
    const biz = (/** @type {string} */ code) => synthOutcome(code, { faculty: 'NUS Business School', exchange: exchange({ 1: ['note', ['2-biz-major']], 2: ['note', ['2-biz-major']] }) });
    const extra = { ...many('AB', 9), BZ1001: biz('BZ1001'), BZ1002: biz('BZ1002') };
    const un = run(`ng=1&study=ug2&${picks(extra, '1')}`, extra);
    expect(un.entries.map((w) => w.form.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null, null]);
    expect(at(un, 'BZ1001').form.text).toBe('On the form only if invited');
    expect(un.sems[1].form?.line).toBe('Sem 1 on NUS\'s form: 36 of 40 units');
    expect(totalLines('1', un.sems[1], un)).toContain('plus 8 units only if invited');
    const ticked = run(`ng=1&study=ug2&inv=biz&${picks(extra, '1')}`, extra);
    expect(ticked.entries.map((w) => w.form.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, null]);
    expect(at(ticked, 'BZ1001').form.text).toBe('Application form, Sem 1: 10, if it\'s a core BBA course');
    expect(at(ticked, 'BZ1002').form.text).toBe(FORM_LINES.over);
  });

  it('each semester has its own order: picks then backups; the full-year line', () => {
    const r = run('ng=1&study=ug2&pick=CS2030.2&pick=CS2113.1&alt=GE2101.1');
    expect(at(r, 'CS2113').form.text).toBe('Application form, Sem 1: 1');
    expect(number(r, 'GE2101')).toBe(2);
    expect(at(r, 'CS2030').form.text).toBe('Application form, Sem 2: 1');
    expect(r.fullYear).toBe(true);
    expect(run('ng=1&study=ug2&pick=CS2113.1').fullYear).toBe(false);
  });

  it('nine 4-unit Sem 1 picks and three Sem 2 picks: no "won\'t fit"; eleven 2-unit entries: the 11th marked "up to 10"', () => {
    const s1 = many('AB', 9);
    const s2 = many('CD', 3);
    const r = run(`ng=1&study=ug2&${picks(s1, '1')}&${picks(s2, '2')}`, { ...s1, ...s2 });
    expect(r.entries.every((w) => w.form.number !== null)).toBe(true);
    const small = many('EF', 11, 2);
    const t = run(`ng=1&study=ug2&${picks(small, '1')}`, small);
    expect(t.entries.map((w) => w.form.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(t.entries.map((w) => w.form.note)).toEqual([...Array(10).fill(''), FORM_LINES.ten]);
  });
});

describe('flags (6B)', () => {
  it('exam overlap: CS2030 pick and CS2113 backup at the same start, both numbered, both flagged, and the totals\' line', () => {
    const r = run('ng=1&study=ug2&pick=CS2030.1&alt=CS2113.1');
    expect([number(r, 'CS2030'), number(r, 'CS2113')]).toEqual([1, 2]);
    expect(at(r, 'CS2030').flags).toEqual([{
      kind: 'exam', with: 'CS2113',
      text: 'CS2030 and CS2113: their 2026/27 exams overlap. If they still do in the year you go, NUS won\'t approve both and its form won\'t take both (GRO). NUS publishes each year\'s timetable in mid-July.',
    }]);
    expect(at(r, 'CS2113').flags.map((f) => f.with)).toEqual(['CS2030']);
    expect(totalLines('1', r.sems[1], r)).toContain('Picks with overlapping 2026/27 exams: NUS approves at most one of each pair');
    expect(run('ng=1&study=ug2&pick=CS2030.1&pick=CS2113.1').sems[1].overlap).toBe(true);
  });

  it('exam spans: a 180-minute exam at 05:00Z against 06:30Z overlaps; adjacent exams don\'t; a null duration only at an identical start', () => {
    const at5 = (/** @type {string} */ code, /** @type {string} */ date, /** @type {number | null} */ mins) => synthOutcome(code, { examDates: [{ sem: 1, date, durationMins: mins }] });
    const flagged = (/** @type {Record<string, any>} */ extra) => run(`ng=1&study=ug2&${Object.keys(extra).map((c) => `pick=${c}.1`).join('&')}`, extra).entries.some((w) => w.flags.length > 0);
    expect(flagged({ AA1001: at5('AA1001', '2026-11-25T05:00:00Z', 180), BB1002: at5('BB1002', '2026-11-25T06:30:00Z', 60) })).toBe(true);
    expect(flagged({ AA1001: at5('AA1001', '2026-11-25T05:00:00Z', 120), BB1002: at5('BB1002', '2026-11-25T07:00:00Z', 60) })).toBe(false);
    expect(flagged({ AA1001: at5('AA1001', '2026-11-25T05:00:00Z', null), BB1002: at5('BB1002', '2026-11-25T05:30:00Z', 60) })).toBe(false);
    expect(flagged({ AA1001: at5('AA1001', '2026-11-25T05:00:00Z', null), BB1002: at5('BB1002', '2026-11-25T05:00:00Z', 60) })).toBe(true);
  });

  it('a closed entry is never flagged', () => {
    // CS2030S (off the NG list) sits its exam with CS2030.
    expect(run('ng=1&study=ug2&pick=CS2030.1&alt=CS2030S.1').entries.every((w) => w.flags.length === 0)).toBe(true);
  });

  it('preclusion between picks: CE2134 names ME2134 (one way, quoting NUS); a pick precluding a backup is not flagged', () => {
    const ce = 'If undertaking an Undergraduate DegreeTHENmust not have completed TCE2134ORmust not have completed ME2134ORmust not have completed TME2134';
    const extra = { CE2134: synthOutcome('CE2134', { preclusion: ce }), ME2134: synthOutcome('ME2134', { preclusion: 'If undertaking an Undergraduate DegreeTHENmust not have completed TME2134 at a grade of at least D' }) };
    const r = run('ng=1&study=ug2&pick=CE2134.1&pick=ME2134.2', extra);
    expect(at(r, 'CE2134').flags).toEqual([{ kind: 'preclusion', with: 'ME2134', text: 'CE2134\'s preclusions name ME2134', quote: ce }]);
    expect(at(r, 'ME2134').flags.map((f) => f.text)).toEqual(['CE2134\'s preclusions name ME2134']);
    expect(run('ng=1&study=ug2&pick=CE2134.1&alt=ME2134.2', extra).entries.every((w) => w.flags.length === 0)).toBe(true);
  });

  it('MA2401 alone: its "beginning with MA2" never flags itself', () => {
    const ma = synthOutcome('MA2401', { preclusion: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of any Courses beginning with MA2 at a grade of at least D)' });
    expect(at(run('ng=1&study=ug2&pick=MA2401.1', { MA2401: ma }), 'MA2401').flags).toEqual([]);
  });

  it('CS2030 and CS2030DE: the same course, so no preclusion flag; CS2030DE\'s 0300CS2MJ against CS2040C: none', () => {
    const r = run('ng=1&study=ug2&pick=CS2030.1&pick=CS2030DE.2');
    expect(r.entries.flatMap((w) => w.flags)).toEqual([]);
    const s = run('ng=1&study=ug2&pick=CS2030DE.1&pick=CS2040C.2', { CS2040C: synthOutcome('CS2040C') });
    expect(s.entries.flatMap((w) => w.flags)).toEqual([]);
  });
});

describe('NUS\'s notes on particular courses (6B, a lead rule)', () => {
  /** @param {string} code @param {Record<string, any>} over @param {string} [study] */
  const notes = (code, over, study = 'ug2') => at(run(`ng=1&study=${study}&pick=${code}.1`, { [code]: synthOutcome(code, over) }), code).notes;
  it('AR, CE, CS, EC and PL codes each get theirs; the EC code also GRO\'s CourseReg line', () => {
    for (const code of ['AR2101', 'CE2183', 'CS2040C']) expect(notes(code, {})).toEqual([NOTES.oversubscribed]);
    expect(notes('EC3304', {})).toEqual([NOTES.oversubscribed, NOTES.popular]);
    expect(notes('PL3236', {})).toEqual([NOTES.psychology]);
  });
  it('none for GEC1028 (Economics, not EC), PLS8002A, or a CEG code', () => {
    expect(notes('GEC1028', { department: 'Economics' })).toEqual([]);
    expect(notes('CEG2001', {})).toEqual([]);
    expect(at(run('pick=PLS8002A.1'), 'PLS8002A').notes).not.toContain(NOTES.psychology);
  });
  it('language courses: the form for level 1, the placement test for level 2 and above', () => {
    expect(at(run('ng=1&study=ug2&pick=LAK1201.1'), 'LAK1201').notes).toContain(NOTES.language1);
    expect(notes('LAJ2201', { department: 'Centre for Language Studies', level: 2 })).toEqual([NOTES.language2]);
  });
  it('level 4 and above: GRO\'s line, but not for a Law course or a graduate student', () => {
    expect(notes('GE4101', {})).toEqual([NOTES.level4]);
    expect(notes('GE4101', {}, 'grad')).toEqual([]);
    expect(at(run('ng=1&study=ug2&pick=LL4407.2'), 'LL4407').notes).toEqual([]);
  });
  it('master-level line when the course isn\'t open at the student\'s year: CAS5101 at ug3, not at ug4', () => {
    expect(at(run('ng=1&study=ug4&pick=CAS5101.1'), 'CAS5101').notes).not.toContain(NOTES.master);
    expect(at(run('ng=1&study=ug3&pick=CAS5101.1'), 'CAS5101').notes).toContain(NOTES.master);
  });
  it('a ticked Business entry gets the 50% and CourseReg lines, an unticked one the "only for invited" lines; Law the same', () => {
    expect(at(run('ng=1&study=ug2&inv=biz&pick=ACC1701XA.1'), 'ACC1701XA').lines).toEqual([BIZ_LAW.gro, ...BIZ_LAW.invited.biz]);
    const un = at(run('ng=1&study=ug2&pick=ACC1701XA.1'), 'ACC1701XA');
    expect(un.lines.slice(0, 4)).toEqual([BIZ_LAW.gro, ...BIZ_LAW.uninvited.biz]);
    // The quota note reads as for invited students only.
    expect(un.lines.at(-1)).toMatch(/^If you were invited: /);
    expect(at(run('ng=1&study=ug2&inv=law&pick=LL4407.2'), 'LL4407')).toMatchObject({ standing: 'counted', lines: [BIZ_LAW.gro, ...BIZ_LAW.invited.law] });
    expect(at(run('ng=1&study=ug2&pick=LL4407.2'), 'LL4407')).toMatchObject({ standing: 'invite', why: 'Only for students invited by NUS Law' });
  });
});

describe('totals, lines and helpers (6B)', () => {
  it('the totals\' lines: hours at NUS\'s rate, the 13 weeks, the minimum and G2\'s maximum, flagged past 20', () => {
    const r = run('ng=1&study=ug2&pick=CS2113.1&pick=EC1101E.1');
    const lines = totalLines('1', r.sems[1], r);
    expect(lines[0]).toBe('Sem 1: 8 units picked, if NUS accepts you into each');
    expect(lines).toContain('About 20 hours a week at NUS\'s rate (2.5 hours a week per unit)');
    expect(lines).toContain(TOTAL_LINES.weeks);
    expect(lines).toContain(`Includes 4 units of Economics courses. GRO: “${GRO_POPULAR}”`);
    expect(lines.slice(-4)).toEqual([TOTAL_LINES.admitted, TOTAL_LINES.courseReg, TOTAL_LINES.maximum, TOTAL_LINES.maximumScope]);
    // G2 as Jacob worded it after the 6-0 fact check (ADR 0010, PR #88), typographic apostrophes and all.
    expect(TOTAL_LINES.maximum).toBe('NUS’s brochure says at most 23 units a semester, but NUS Global’s exchange page says 20 (NUS Business School’s exchange students: 20). Ask NUS before planning more than 20.');
    expect(TOTAL_LINES.maximumScope).toBe('This limits the courses NUS enrols you in, not the courses you list');
    expect(r.sems[1].over20).toBe(false);
    const big = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`AB${1000 + i}`, synthOutcome(`AB${1000 + i}`)]));
    expect(run(`ng=1&study=ug2&${Object.keys(big).map((c) => `pick=${c}.1`).join('&')}`, big).sems[1].over20).toBe(true);
  });

  it('the view\'s sentence after a settings change names the state\'s semester first', () => {
    expect(summary(run('sem=2&ng=1&study=ug2&pick=CS2030.2&pick=CS2113.2&pick=GE2101.1&pick=CS2113X.1', { CS2113X: synthOutcome('CS2113X') })))
      .toBe('Sem 2 first: 8 units picked; Sem 1: 8');
  });

  it('the export question: browse mode asks the year; an untagged entry its semester; special-term and 404 entries are exempt', () => {
    const q = (/** @type {string} */ qs, /** @type {Record<string, any>} */ extra = {}) => {
      const params = new URLSearchParams(qs);
      const { list } = parseList(params);
      const answers = new Map([...list.pick, ...list.alt].map((e) => [e.code, answerOf(e.code in extra ? extra[e.code] : fixtureOutcome(e.code))]));
      return exportQuestion({ list, study: parseState(params).study, answers });
    };
    expect(q('ng=1&study=ug2&pick=CS2113.1&alt=CS2030')).toEqual({ ask: true, year: false, entries: ['CS2030'] });
    expect(q('pick=CS5562.2')).toEqual({ ask: true, year: true, entries: [] });
    expect(q('ng=1&study=ug2&pick=CS9999&pick=BL5240', { CS9999: { kind: 'error', error: { status: 404 } } })).toEqual({ ask: false, year: false, entries: [] });
  });

  it('a new entry\'s semesters: open in (exchange mode) or taught in (browse mode); its buttons: taught in or on NUS\'s list for', () => {
    expect(openSems(answerOf(fixtureOutcome('CS3244')), 'ug2')).toEqual([2]);
    expect(openSems(answerOf(fixtureOutcome('CS3244')), '')).toEqual([1, 2]);
    expect(semChoices(answerOf(fixtureOutcome('ACC1701XB')), 'ug2')).toEqual([1, 2]);
    expect(semChoices(answerOf(fixtureOutcome('ACC1701XB')), '')).toEqual([2]);
    expect(semChoices(answerOf({ kind: 'error', error: { status: 404 } }), 'ug2')).toEqual([]);
  });

  it('the year comes from the rows, else a 404, else public/year.js (the data\'s own year)', () => {
    expect(DEFAULT_ACAD_YEAR).toBe(REASONS_FILE.acadYear);
    expect(readFileSync(fileURLToPath(new URL('../../public/index.html', import.meta.url)), 'utf8')).toContain(`Academic year ${yearLabel(DEFAULT_ACAD_YEAR)}`);
    expect(run('pick=CS2030.1', { CS2030: synthOutcome('CS2030', { acad_year: '2027-2028' }) }).year).toBe('2027/28');
    expect(run('pick=CS9999.1', { CS9999: { kind: 'error', error: { status: 404, detail: { kind: 'unknown', acadYear: '2027-2028' } } } }).year).toBe('2027/28');
    expect(run('pick=CS2030.1', { CS2030: null }).year).toBe(yearLabel(DEFAULT_ACAD_YEAR));
    expect(yearLine('2026-2027', '2027-2028')).toBe('Made with 2026/27 courses; showing 2027/28\'s');
    expect(yearLine('2026-2027', '2026-2027')).toBe('');
    expect(yearLine('', '2027-2028')).toBe('');
    const answers = new Map([['A', answerOf(synthOutcome('A1001', { acad_year: '2026-2027' }))], ['B', answerOf(synthOutcome('B1001', { acad_year: '2027-2028' }))]]);
    expect(staleRows(answers)).toEqual(['A']);
  });

  it('the fixed lines are NUS\'s, cited: applicants, the form, the CourseReg box', () => {
    expect(APPLICANT_LINES).toHaveLength(4);
    expect(FORM_LINES.applicants('2026/27')).toBe('This order uses NUS\'s 2026/27 exchange list and exams. Applying for 2027/28? NUS publishes Sem 1\'s list in March or April, Sem 2\'s later (the 2026/27 list is dated 1 Sep 2026), and the timetable in mid-July: check each course there.');
    expect(COURSEREG_BOX.rules.join(' ')).toContain(RULE_E);
    expect(COURSEREG_BOX.page).toBe('This page can\'t see your offer. Your offer and CourseReg show which courses are yours.');
  });
});

// ------------------------------------------------------------ the property test

/** A small seeded generator (mulberry32), so a failure reproduces. @param {number} seed */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STUDY_LIST = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
const CONDITIONS = ['quota', 'major', 'approval', 'graded', 'letter', 'fee'];

/**
 * The reference: the 6B counting rules written again from the plan, over the
 * fixture's own columns (its allow mask and stored rule ids), not through
 * shortlist.js or the /module answers it reads.
 * @param {{ which: string, code: string, sem: string }[]} entries in rank order, picks first
 * @param {string} study
 * @param {string[]} inv
 */
function reference(entries, study, inv) {
  /** @param {string} text @param {string} code */
  const namesRef = (text, code) => {
    if (!text) return false;
    if (study === 'grad' && /^\s*\(?\s*if undertaking an undergraduate degree/i.test(text) && !/graduate degree coursework/i.test(text.split(/then/i)[0])) return false;
    if (new RegExp(`(^|[^A-Za-z])${code}(?=[^A-Za-z0-9]|$|OR|AND|THEN)`).test(text)) return true;
    return [...text.matchAll(/beginning with\s+([A-Z]+\d*)/g)].some((m) => code.startsWith(m[1]));
  };
  const classified = entries.map((e) => {
    const m = FIXTURE.get(e.code);
    /** @param {string} st */
    const as = (st) => ({ ...e, m, st });
    if (!m || !e.sem || m.credits === null) return as('out');
    if (m.semesters.length && m.semesters.every((/** @type {number} */ s) => s >= 3)) return as('out');
    const s = Number(e.sem);
    if (!study) return as(m.semesters.includes(s) ? 'counted' : 'out');
    const index = (s - 1) * 5 + STUDY_LIST.indexOf(study);
    if ((m.ngAllow & (1 << index)) === 0) return as('out');
    const kinds = (m.ng ? (m.ngRules?.[String(index)] ?? []) : []).map((/** @type {string} */ id) => REASONS_FILE.reasons[id]?.kind ?? 'unknown');
    if (yearNote(m.prerequisite, /** @type {any} */ (study))) kinds.push('year');
    const fac = m.faculty === 'NUS Business School' ? 'biz' : m.faculty === 'Law' ? 'law' : '';
    if (fac && !inv.includes(fac)) return as('invite');
    return as(kinds.every((/** @type {string} */ k) => CONDITIONS.includes(k)) ? 'counted' : 'confirm');
  });
  /** @param {any} a @param {any} b */
  const same = (a, b) => {
    const g = GROUP_OF.get(a.code) ?? [];
    if (!g.includes(b.code)) return false;
    if (a.m.ng && b.m.ng) return true;
    return namesRef(a.m.preclusion, b.code) || namesRef(b.m.preclusion, a.code);
  };
  const takes = (/** @type {any} */ x) => ['counted', 'confirm', 'invite'].includes(x.st);
  /** @type {any[]} */
  const kept = [];
  const picks = classified.filter((x) => x.which === 'pick' && takes(x));
  for (const x of [...picks.filter((p) => p.st === 'counted'), ...picks.filter((p) => p.st !== 'counted')]) {
    if (kept.some((k) => same(k, x))) x.st = 'dup';
    else kept.push(x);
  }
  /** @type {Record<string, { counted: number, confirm: number }>} */
  const out = { 1: { counted: 0, confirm: 0 }, 2: { counted: 0, confirm: 0 } };
  for (const x of classified) {
    if (x.which !== 'pick' || !x.sem) continue;
    if (x.st === 'counted') out[x.sem].counted += x.m.credits * 10;
    if (x.st === 'confirm') out[x.sem].confirm += x.m.credits * 10;
  }
  for (const s of ['1', '2']) { out[s].counted /= 10; out[s].confirm /= 10; }
  return out;
}

describe('totals over 500 random shortlists (6B, SC3: the reference)', () => {
  it('counted and to-confirm units per semester equal the reference, at both semesters, every study level and in browse mode', () => {
    const random = rng(20261111);
    const all = [...FIXTURE.keys()];
    // Weighted towards groups, so the same-course rule is exercised.
    const grouped = all.filter((c) => GROUP_OF.has(c));
    const pickCode = () => (random() < 0.4 ? grouped : all)[Math.floor(random() * (random() < 0.4 ? grouped : all).length)];
    let compared = 0;
    /** How often each standing came up, so the test shows it exercised every rule. @type {Record<string, number>} */
    const seen = {};
    for (let i = 0; i < 500; i += 1) {
      const n = 1 + Math.floor(random() * 14);
      const parts = [];
      for (let j = 0; j < n; j += 1) {
        const tag = () => ['', '.1', '.2', '.1', '.2'][Math.floor(random() * 5)];
        const which = () => (random() < 0.75 ? 'pick' : 'alt');
        const code = pickCode();
        parts.push(`${which()}=${code}${tag()}`);
        // Often another code of the same group too.
        const others = GROUP_OF.get(code) ?? [];
        if (others.length && random() < 0.5) parts.push(`${which()}=${others[Math.floor(random() * others.length)]}${tag()}`);
      }
      if (random() < 0.3) parts.push('inv=biz');
      if (random() < 0.3) parts.push('inv=law');
      const qs = parts.join('&');
      const { list } = parseList(new URLSearchParams(qs));
      const entries = [...list.pick.map((e) => ({ ...e, which: 'pick' })), ...list.alt.map((e) => ({ ...e, which: 'alt' }))];
      for (const sem of ['1', '2']) {
        for (const study of ['', ...STUDY_LIST]) {
          const r = run(`${study ? `ng=1&study=${study}&` : ''}sem=${sem}&${qs}`);
          const ref = reference(entries, study, list.inv);
          for (const w of r.entries) seen[w.standing] = (seen[w.standing] ?? 0) + 1;
          for (const s of /** @type {('1' | '2')[]} */ (['1', '2'])) {
            expect({ qs, study, s, counted: r.sems[s].counted, confirm: r.sems[s].confirm }).toEqual({ qs, study, s, ...ref[s] });
          }
          compared += 1;
        }
      }
    }
    expect(compared).toBe(500 * 2 * 6);
    for (const st of ['counted', 'confirm', 'invite', 'out', 'duplicate']) expect(seen[st], st).toBeGreaterThan(100);
  });
});
