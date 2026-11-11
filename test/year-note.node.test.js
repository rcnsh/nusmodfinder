// @ts-check
// src/year-note.js (Jacob's ruling R3, ADR 0008): the "ask NUS" note for a
// prerequisite that requires an undergraduate year of study above the
// student's home year. Every text below is a production prerequisite
// (.data/2026-2027-moduleInfo.json), verbatim; the whole-corpus agreement with
// the SC1 oracle's own reading is in test/sc1/paths.test.js.
import { describe, expect, it } from 'vitest';
import { requiredYears, YEAR_NOTE, yearNote } from '../src/year-note.js';

/** Patterns the note handles: the year item binds every undergraduate. */
const HANDLED = {
  // The undergraduate branch is the year item alone.
  AR4601: ['If undertaking an Undergraduate DegreeTHENmust be Year 4', [4]],
  ME4252: ['If undertaking an Undergraduate Degree THEN must be Year 3 or 4', [3, 4]],
  CE4103R: ['If undertaking an Undergraduate Degree THEN (must be Year 4)', [4]],
  // ANDed with a course, a programme, a cohort or units, at any depth.
  AR4101: ['If undertaking an Undergraduate DegreeTHENmust have completed AR3102 at a grade of at least DANDmust be Year 4', [4]],
  ESE3201: ['if undertaking an Undergraduate Degree then ( must be undertaking 1 of 0105NVGHON Bachelor of Env Studies (FASS) / 0613EVEHON Bachelor of Engineering / 1000NVBHON,1001BESXDP Bachelor of Env Studies (FOS) and must be Year 2,3 or 4 )', [2, 3, 4]],
  CM3311: ['If undertaking an Undergraduate Degree THEN must be in one of the cohorts prior to 2020 inclusive AND must be undertaking 1002CMHON Bachelor of Science - Chemistry (Hons) AND must be Year 2, 3 or 4 AND the student must have achieved at least 32 units prior to enrolment AND must have completed CM3310 at a grade of at least D', [2, 3, 4]],
  CE5101: ['if undertaking an Undergraduate Degree then ( must have completed CE2112 at a grade of at least D and ( must be undertaking 0613CEHON Bachelor of Engineering and must be Year 3 or 4 ) )', [3, 4]],
  // An OR elsewhere, but not around the year item.
  GL2104: ['If undertaking an Undergraduate Degree THEN (must be undertaking 0110GLHON Bachelor of Arts - Global Studies (Hons) OR must be undertaking 0110GL2MJ Global Studies (2nd Major)) AND must be Year 3 or 4 AND must have completed all of GL1101E/GL2101/GL2102/GL2103 at a grade of at least D', [3, 4]],
  SC4101: ['If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2021 inclusiveANDthe student must have achieved at least 80 units prior to enrolmentANDmust be Year 4AND( must have completed 7 of any Courses beginning with SC at a grade of at least DORmust have completed 7 of any Courses beginning with AN at a grade of at least D, SC2209/SC2217/SC2220/SC3203/SC3204/SC3213/SC4205/SC4880A/SC4880B/SC4880C/SC4880D at a grade of at least D)', [4]],
  // "a GPA of 3.2 or greater" is a comparison, not an alternative.
  PS4231HM_like: ['If undertaking an Undergraduate Degree THEN ( the student must have achieved a GPA of 3.2 or greater AND must be Year 4 )', [4]],
  // No branch: the whole rule is for undergraduates.
  HS1403A: ['Must be undertaking an Undergraduate Degree AND must be in one of the cohorts from 2021 inclusive AND must be Year 3', [3]],
  // "if undertaking Undergraduate Degree" without "an".
  IE5107: ['if undertaking Undergraduate Degree then ( must be undertaking 0607ISEHON Bachelor of Engineering and must be Year 4 )', [4]],
};

/** Near misses the note leaves alone: the year is one alternative, or the text is not one undergraduate rule. */
const LEFT_ALONE = {
  // The year item is one alternative beside an OR.
  EE4204: 'If undertaking an Undergraduate Degree THEN ( must have completed 1 of EE2012/EE2012A/ESP2107/ST2334 at a grade of at least D OR (must be undertaking 2001CEGHON Bachelor of Engineering (Computer Engineering) (Hons) AND must be Year 2,3 or 4)) ',
  AN4204: 'If undertaking an Undergraduate Degree THEN ((must have completed 7 of any Courses (Modules) beginning with AN at a grade of at least D) OR (must be Year 4))',
  gpa: 'If undertaking an Undergraduate Degree THEN (the student must have achieved a GPA of 3.2 or greater OR must be Year 4)',
  // Programme-specific years in each alternative (every branch here names Year 2 or later, still left alone).
  CM3310: 'If undertaking an Undergraduate DegreeTHEN((must be in one of the cohorts prior to 2020 inclusiveANDmust be undertaking 1002CMHON Bachelor of Science - Chemistry (Hons)ANDmust be Year 2, 3 or 4ANDthe student must have achieved at least 32 units prior to enrolment)OR(must be in one of the cohorts from 2021 inclusiveANDmust be undertaking 1002CMHON Bachelor of Science - Chemistry (Hons)ANDmust be Year 2 or 3))',
  // AND and OR side by side with no brackets: NUS's precedence is unstated.
  mixed: 'If undertaking an Undergraduate Degree THEN must have completed GE2101 at a grade of at least D OR must have completed GE2102 at a grade of at least D AND must be Year 3',
  // Several "if undertaking" branches.
  CE5307A: '( if undertaking a Graduate Degree Coursework then ( must have completed CE3132 at a grade of at least D ) ) or ( if undertaking an Undergraduate Degree then must be undertaking 1 of 0613CEHON/0613EVEHON Bachelor of Engineering and must be Year 3 or 4 )',
  // A graduate branch only.
  grad: 'If undertaking a Graduate Degree Coursework THEN must be Year 2',
  // Unbalanced brackets.
  unbalanced: 'If undertaking an Undergraduate Degree THEN ( must be Year 4',
  // No year item at all.
  none: 'If undertaking an Undergraduate Degree THEN must have completed CS2040 at a grade of at least D',
};

describe('requiredYears (R3: which prerequisites name a binding undergraduate year)', () => {
  for (const [code, [text, years]] of Object.entries(HANDLED)) {
    it(`${code}: ${JSON.stringify(years)}`, () => {
      expect(requiredYears(/** @type {string} */ (text))).toEqual(years);
    });
  }
  for (const [code, text] of Object.entries(LEFT_ALONE)) {
    it(`${code}: left alone`, () => {
      expect(requiredYears(text)).toBeNull();
    });
  }
  it('null, empty and year-free texts give nothing', () => {
    expect(requiredYears(null)).toBeNull();
    expect(requiredYears(undefined)).toBeNull();
    expect(requiredYears('')).toBeNull();
    expect(requiredYears('must have completed MA1521 at a grade of at least D')).toBeNull();
  });
  it('a capital word that merely contains a keyword is not one ("MAJOR", "ORGANIC")', () => {
    expect(requiredYears('If undertaking an Undergraduate DegreeTHENmust be undertaking 0110GL2MAJOR Global Studies ORGANIC AND must be Year 3')).toEqual([3]);
  });
  it('two binding year items: the stricter one', () => {
    expect(requiredYears('If undertaking an Undergraduate Degree THEN must be Year 2, 3 or 4 AND (must be Year 3 or 4)')).toEqual([3, 4]);
  });
});

describe('yearNote (R3: an undergraduate below that year asks NUS)', () => {
  const AR4601 = HANDLED.AR4601[0];
  it('a 3rd-year gets the note on a Year 4 course; the text says what to do', () => {
    expect(yearNote(/** @type {string} */ (AR4601), 'ug3')).toEqual({
      id: YEAR_NOTE,
      kind: 'year',
      text: 'NUS lists this course for Year 4 students. Ask the department whether your year of study during your exchange counts.',
    });
  });
  it('every undergraduate year below the lowest year named, and none at or above it', () => {
    const me = /** @type {string} */ (HANDLED.ME4252[0]);
    expect(['ug1', 'ug2', 'ug3', 'ug4'].map((s) => yearNote(me, /** @type {any} */ (s)) !== null)).toEqual([true, true, false, false]);
    expect(yearNote(me, 'ug1')?.text).toBe('NUS lists this course for Year 3 or 4 students. Ask the department whether your year of study during your exchange counts.');
    const ese = /** @type {string} */ (HANDLED.ESE3201[0]);
    expect(yearNote(ese, 'ug1')?.text).toMatch(/^NUS lists this course for Year 2, 3 or 4 students\./);
    expect(yearNote(ese, 'ug2')).toBeNull();
  });
  it('never for a graduate student: a graduate is not "Year N"', () => {
    expect(yearNote(/** @type {string} */ (AR4601), 'grad')).toBeNull();
  });
  it('never for a left-alone text', () => {
    for (const text of Object.values(LEFT_ALONE)) expect(yearNote(text, 'ug1')).toBeNull();
  });
});
