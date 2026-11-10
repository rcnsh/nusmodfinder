// @ts-check
// src/eligibility.js with the committed rules (data/ng-restrictions-2026-2027.json):
// one case per interpretations-register row that touches a course this year
// (docs/evidence/phase4/interpretations.md), the allow mask, and the rules
// file's integrity against its sources and transcription. The whole-corpus
// agreement with the independent oracle is test/full/sc1-oracle.node.test.js.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bitOf, eligibility, eligibilityMask, GRAD_LEVELS, NOT_NG_IN_SEM, OFF_NG_LIST, SEMESTER_MISMATCH } from '../src/eligibility.js';

/** @param {string} path */
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** @type {import('../src/eligibility.js').Rules & { sourceSha256: Record<string, string>, info: { id: string }[], rules: { id: string }[] }} */
const rules = JSON.parse(read('../data/ng-restrictions-2026-2027.json'));

/**
 * A module as normalise() + offeredModules() give it, with the fields eligibility reads.
 * @param {string} code @param {Partial<import('../src/eligibility.js').EligibilityModule>} [over]
 * @returns {import('../src/eligibility.js').EligibilityModule}
 */
const mod = (code, over = {}) => ({
  code, title: `${code} title`, department: null, faculty: null, level: Number(/\d/.exec(code)?.[0] ?? NaN),
  semesters: [1, 2], ng: true, ngSemesters: [1, 2], ...over,
});
/** @param {import('../src/eligibility.js').EligibilityModule} m @param {1 | 2 | 'any'} sem @param {import('../src/eligibility.js').Study} study */
const e = (m, sem, study) => eligibility(m, { sem, study }, rules);

describe('the NG list (R1-R3)', () => {
  it('R1: a course off the NG list is closed everywhere (Jacob, Q7)', () => {
    expect(e(mod('CS2030', { ng: false, ngSemesters: [] }), 'any', 'ug2')).toEqual({ status: 'closed', reasons: [OFF_NG_LIST] });
  });
  it('NG-listed in Sem 2 only: closed in Sem 1, open in Sem 2 and either (P1: CS3244)', () => {
    const m = mod('CS3244', { department: 'Computer Science', faculty: 'Computing', ngSemesters: [2] });
    expect(e(m, 1, 'ug3')).toEqual({ status: 'closed', reasons: [NOT_NG_IN_SEM] });
    expect(e(m, 2, 'ug3').status).toBe('open');
    expect(e(m, 'any', 'ug3').status).toBe('open');
  });
  it('R2: NG-listed in a semester NUSMods does not offer it in is a note (Jacob, Q5: PC3270)', () => {
    const m = mod('PC3270', { department: 'Physics', faculty: 'Science', semesters: [2], ngSemesters: [1] });
    expect(e(m, 1, 'ug2')).toEqual({ status: 'note', reasons: [SEMESTER_MISMATCH] });
    expect(e(m, 2, 'ug2').reasons).toEqual([NOT_NG_IN_SEM]);
    expect(e(m, 'any', 'ug2').reasons).toEqual([SEMESTER_MISMATCH]);
  });
});

describe('levels (R4, R5, R7, C3-C5)', () => {
  it('R4: level 5000 is closed at every study level unless a department opens it', () => {
    for (const study of /** @type {const} */ (['ug1', 'ug4', 'grad'])) {
      expect(e(mod('CM5223', { department: 'Chemistry', faculty: 'Science' }), 'any', study).reasons).toEqual([GRAD_LEVELS]);
    }
  });
  it('R5: Southeast Asian Studies level 5000 opens to 4th-years and graduates (C-3: CAS5101)', () => {
    const m = mod('CAS5101', { department: 'Southeast Asian Studies', faculty: 'Arts and Social Science', ngSemesters: [1] });
    expect(e(m, 1, 'ug3').status).toBe('closed');
    expect(e(m, 1, 'ug4')).toEqual({ status: 'note', reasons: ['1-sea-no-audit'] });
    expect(e(m, 1, 'grad').status).toBe('note');
  });
  it('R5: PP graduate courses: closed to undergraduates, a partner note for graduates', () => {
    const m = mod('PP5164', { department: "LKYSPP Dean's Office", faculty: 'LKY School of Public Policy' });
    expect(e(m, 'any', 'ug4').status).toBe('closed');
    expect(e(m, 'any', 'grad')).toEqual({ status: 'note', reasons: ['7-pp-partner', '7-pp-graded'] });
  });
  it('C4: dual-coded AR5221 is open with its 4000 twin\'s Architecture-major note', () => {
    const m = mod('AR5221', { department: 'Architecture', faculty: 'College of Design and Engineering', ngSemesters: [2] });
    expect(e(m, 2, 'ug2')).toEqual({ status: 'note', reasons: ['4-arch-major-architecture'] });
  });
  it('C5: PC5202 is closed for graduates too: it is in a self-funded programme', () => {
    expect(e(mod('PC5202', { department: 'Physics', faculty: 'Science' }), 'any', 'grad').reasons).toContain('A-self-funded');
  });
});

describe('conflicts and readings (C1, C2, C6, I1, I5, I9, I11)', () => {
  it('C1: explicit closures of NG-listed courses (Jacob, Q1a)', () => {
    expect(e(mod('LL4011V', { faculty: 'Law', department: "FoL Dean's Office" }), 'any', 'ug3').reasons).toContain('5-law-closed');
    expect(e(mod('GEC1011', { faculty: 'Yong Loo Lin Sch of Medicine', department: 'Microbiology and Immunology' }), 'any', 'ug2').reasons).toEqual(['A-medicine']);
    expect(e(mod('LSM2106', { faculty: 'Yong Loo Lin Sch of Medicine', department: 'Biochemistry' }), 'any', 'ug2').status).toBe('open');
  });
  it('C2: blanket CG/DSA/GEH rules are a note outside their section\'s department (Jacob, Q1b)', () => {
    expect(e(mod('CG3201', { department: 'Computing and Engineering Programme', faculty: 'Multi Disciplinary Programme' }), 'any', 'ug2'))
      .toEqual({ status: 'note', reasons: ['3-soc-cg:elsewhere'] });
    expect(e(mod('DSA4211', { department: 'Statistics and Data Science', faculty: 'Science' }), 'any', 'ug3').reasons).toEqual(['8-math-dsa:elsewhere']);
  });
  it('C6: NUS College courses are open (Jacob, Q6)', () => {
    expect(e(mod('NGN2001A', { department: "NUS College Dean's Office", faculty: 'NUS College' }), 'any', 'ug2').status).toBe('open');
  });
  it('I1: rule B closes only its 7 listed X courses, not every X-suffix course', () => {
    expect(e(mod('CS1010X', { department: 'Computer Science', faculty: 'Computing' }), 'any', 'ug1').reasons).toContain('B-suffix-x');
    expect(e(mod('ACC1701XA', { department: 'Accounting', faculty: 'NUS Business School' }), 'any', 'ug2').status).toBe('note');
  });
  it('I5: Economics closes levels 1000-3000 to graduates, including GE courses it hosts', () => {
    expect(e(mod('GEC1028', { department: 'Economics', faculty: 'Arts and Social Science' }), 'any', 'grad').reasons).toEqual(['1-econ-l123-grad']);
    expect(e(mod('EC2101', { department: 'Economics', faculty: 'Arts and Social Science' }), 'any', 'ug2').status).toBe('open');
  });
  it('I9: a music course not on YST\'s non-music-majors page that semester is partner-only', () => {
    const m = mod('MUA4161', { department: "YSTCM Dean's Office", faculty: 'YST Conservatory of Music', semesters: [2], ngSemesters: [1] });
    expect(e(m, 1, 'ug2').reasons).toEqual([SEMESTER_MISMATCH, '6-music-electives-whitelist']);
    expect(e(mod('MUA3219', { department: "YSTCM Dean's Office", faculty: 'YST Conservatory of Music' }), 1, 'ug2').status).toBe('open');
  });
  it('I9, either semester: a YST listing in a semester the course is not NG-listed in does not lift the partner note', () => {
    // MUA1165 is on YST's Sem 2 page only; NG-listed in Sem 1 only, it is partner-only in Sem 1 and so for "either".
    const m = mod('MUA1165', { department: "YSTCM Dean's Office", faculty: 'YST Conservatory of Music', semesters: [1], ngSemesters: [1] });
    expect(e(m, 1, 'ug2').reasons).toEqual(['6-music-electives-whitelist']);
    expect(e(m, 'any', 'ug2').reasons).toEqual(['6-music-electives-whitelist']);
  });
  it('I11: UROP is matched by title, case-sensitively ("European" is not UROP)', () => {
    const fass = { faculty: 'Arts and Social Science', department: 'History' };
    expect(e(mod('HY3288', { ...fass, title: 'UROPS in History' }), 'any', 'ug3').reasons).toContain('C-urop-fass');
    expect(e(mod('PH3207', { ...fass, department: 'Philosophy', title: 'European Philosophy' }), 'any', 'ug3').status).toBe('open');
  });
  it('the year-of-study rules: Malay Studies level 4000 is for 3rd and 4th-years', () => {
    const m = mod('MS4208', { department: 'Malay Studies', faculty: 'Arts and Social Science' });
    expect(e(m, 'any', 'ug2').reasons).toEqual(['1-malay-l4-yr34']);
    expect(e(m, 'any', 'ug3').status).toBe('note');
  });
});

describe('the allow mask', () => {
  it('sets the bit exactly where the course is shown; zero for a course off the NG list', () => {
    const m = mod('CS3244', { department: 'Computer Science', faculty: 'Computing', ngSemesters: [2] });
    const { allow, rules: byBit } = eligibilityMask(m, rules);
    expect(allow & bitOf(1, 'ug3')).toBe(0);
    expect(allow & bitOf(2, 'ug3')).not.toBe(0);
    expect(byBit[String(Math.log2(bitOf(1, 'ug3')))].reasons).toEqual([NOT_NG_IN_SEM]);
    expect(eligibilityMask(mod('CS2030', { ng: false, ngSemesters: [] }), rules).allow).toBe(0);
  });
  it('uses 15 distinct bits', () => {
    const bits = (/** @type {const} */ ([1, 2, 'any'])).flatMap((s) => (/** @type {const} */ (['ug1', 'ug2', 'ug3', 'ug4', 'grad'])).map((st) => bitOf(s, st)));
    expect(new Set(bits).size).toBe(15);
    expect(bits.reduce((a, b) => a | b, 0)).toBe(0x7fff);
  });
});

describe('the rules file', () => {
  it('records the source hashes docs/evidence/phase4/sources.md lists', () => {
    const md = read('../docs/evidence/phase4/sources.md');
    /** @type {Record<string, string>} */
    const listed = {};
    for (const m of md.matchAll(/^\| `([^`]+)` \|.*\| `([0-9a-f]{64})` \|$/gm)) listed[m[1]] = m[2];
    expect(Object.keys(listed).length).toBeGreaterThanOrEqual(6);
    expect(rules.sourceSha256).toEqual(listed);
  });
  it('accounts for every transcribed rule, as a rule or as info, with unique ids', () => {
    /** @type {{ rules: { id: string }[] }} */
    const transcription = JSON.parse(read('../docs/evidence/phase4/transcription-b.json'));
    const ids = rules.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const covered = new Set([...ids.map((id) => id.split(':')[0]), ...rules.info.map((i) => i.id)]);
    expect(transcription.rules.map((r) => r.id).filter((id) => !covered.has(id))).toEqual([]);
  });
});
