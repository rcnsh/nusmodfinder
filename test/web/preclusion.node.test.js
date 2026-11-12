// @ts-check
// public/preclusion.js: whether one course's NUS preclusion text
// names another, for the shortlist's preclusion flag and its same-course rule.
// Every text here is NUS's own, as NUSMods serves it for 2026/27.
import { describe, expect, it } from 'vitest';
import { names } from '../../public/preclusion.js';

/** @type {Record<string, string>} */
const T = {
  CE2134: 'If undertaking an Undergraduate DegreeTHENmust not have completed TCE2134ORmust not have completed ME2134ORmust not have completed TME2134',
  ME2134: 'If undertaking an Undergraduate DegreeTHENmust not have completed TME2134 at a grade of at least D',
  LSM2107: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of LSM1105/YSC2216 at a grade of at least D)',
  MA1100: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of CS1231/CS1231S/MA1100T/YSC2209 at a grade of at least D)',
  PC2031: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of PC2131/YSC3211 at a grade of at least D)',
  PC2130: 'If undertaking an Undergraduate Degree THEN must not have completed 1 of PC2130B/YSC3210 at a grade of at least D',
  COS1000: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of any Courses (Modules) beginning with CS1010 at a grade of at least D, COS2000/CS1101S/CS2030/CS2113/CS2113T/SP2273/TEE2101/TIC2001/TIE2030 at a grade of at least D)',
  BSP1703: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of any Courses beginning with BSP1703 at a grade of at least D, any Courses beginning with EC1101 at a grade of at least D, BSP1005/BSP1005A/BSP1005B/BSP1005X/EC1301/EC2101/RE1704 at a grade of at least D AND must not be undertaking 0103EC2MJ Economics (2nd Major) AND must not be undertaking 0103ECMIN Economics (Minor))',
  MA1301: 'If undertaking an Undergraduate Degree THEN (( 1 of 06 MATHEMATICS/07 FURTHER MATHEMATICS at a grade of at least E) AND ( must not have completed 1 of any Courses beginning with MA at a grade of at least D))',
  EC2104: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of any Courses beginning with MA11 at a grade of at least D, any Courses beginning with MA15 at a grade of at least D, any Courses beginning with MA2 at a grade of at least D, any Courses beginning with MA3 at a grade of at least D, any Courses beginning with MA4 at a grade of at least D)',
  MA2401: 'If undertaking an Undergraduate Degree THEN ( must not have completed 1 of ST2131/ST2334/ST3236/ST4238 at a grade of at least D, any Courses beginning with MA11 at a grade of at least D/any Courses beginning with MA131 at a grade of at least D/any Courses beginning with MA15 at a grade of at least D/any Courses beginning with MA2 at a grade of at least D/any Courses beginning with MA3 at a grade of at least D/any Courses beginning with MA4 at a grade of at least D)',
  CS2030DE: 'If undertaking an Undergraduate Degree THEN (( must not have completed 1 of CS2030/CS2030S at a grade of at least D) AND (must not be undertaking 0300CSMIN Computer Science (Minor)) AND (must not be undertaking 0300CS2MJ Computer Science (2nd Major)))',
  CS2030: 'If undertaking an Undergraduate DegreeTHEN( must not have completed 1 of CS1020/CS1020E/CS2020 at a grade of at least DANDmust not have completed 1 of CS2030DE/CS2030S at a grade of at least D)',
  GES1034: 'if undertaking an Undergraduate Degree then ( must not have completed GESS1024 at a grade of at least D )',
  MA4207: 'If undertaking an Undergraduate Degree, Graduate Degree Coursework or Graduate Degree Research THEN ( must not have completed 1 of MA5219/MA5220 at a grade of at least D)',
  EE4705: 'If undertaking an Undergraduate Degree or Graduate Degree CourseworkTHENmust not have completed EE5112 at a grade of at least D',
  HY2262: 'If undertaking an Undergraduate Degree THEN (if in one of the cohorts from 2018 inclusive THEN must not have completed YHU2314 at a grade of at least D) AND (if in one of the cohorts prior to 2017 inclusive THEN must not have completed 1 of EU2221, HY2245/YHU2314 at a grade of at least D)',
  PC1101: '(If undertaking an Undergraduate Degree AND if in one of the cohorts prior to 2020 inclusive ) THEN ( must not have completed 1 of any Courses beginning with PC20 at a grade of at least D, any Courses beginning with PC21 at a grade of at least D, any Courses beginning with PC22 at a grade of at least D, PC1144/PC1432/PC1432X at a grade of at least D)',
  GESS1007: 'If undertaking Undergraduate Degree THEN (GES1009, HY2239:D, SSA2203:D)',
  CS5462: '(If undertaking an Undergraduate DegreeTHEN( must not have completed CS4262 at a grade of at least D))OR(if undertaking a Graduate Degree CourseworkTHEN( must not have completed CS4262 at a grade of at least D))OR(if undertaking a Graduate Degree ResearchTHEN( must not have completed CS4262 at a grade of at least D))',
  DAO2702X: 'If undertaking an Undergraduate Degree THEN ((must not be undertaking 0200ACCHON Bachelor of Business Administration (Accountancy), 0200BBAHON Bachelor of Business Administration (Hons)) OR (if in one of the cohorts from 2023 inclusive THEN must not be undertaking 0200RSTHON Bachelor of Science (Real Estate) (Hons)) OR ( must not have completed 1 of any Courses beginning with DAO2702 at a grade of at least D))',
};

describe('a preclusion names a code', () => {
  it('a code with a non-letter before it, and after it a non-alphanumeric, the end, or a glued OR, AND or THEN', () => {
    expect(names(T.CE2134, 'ME2134', 'ug2')).toBe(true);
    expect(names(T.ME2134, 'CE2134', 'ug2')).toBe(false);
    expect(names(T.CS2030, 'CS2030DE', 'ug2')).toBe(true);
    expect(names(T.CS2030, 'CS2030S', 'ug2')).toBe(true);
    expect(names('… must not have completed CS2040C', 'CS2040C', 'ug2')).toBe(true);
    // A longer code is another code: CS2030S doesn't name CS2030 by its first six characters.
    expect(names('must not have completed CS2030S at a grade', 'CS2030', 'ug2')).toBe(false);
  });

  it('the four false substring pairs: a letter before the code (YSC2216 is not SC2216)', () => {
    expect(names(T.LSM2107, 'SC2216', 'ug2')).toBe(false);
    expect(names(T.MA1100, 'SC2209', 'ug2')).toBe(false);
    expect(names(T.PC2031, 'SC3211', 'ug2')).toBe(false);
    expect(names(T.PC2130, 'SC3210', 'ug2')).toBe(false);
  });

  it('a prefix after "beginning with", matched against the start of the other code', () => {
    expect(names(T.COS1000, 'CS1010E', 'ug2')).toBe(true);
    expect(names(T.BSP1703, 'EC1101E', 'ug2')).toBe(true);
    expect(names(T.MA1301, 'MA2001', 'ug2')).toBe(true);
    expect(names(T.EC2104, 'MA2001', 'ug2')).toBe(true);
    expect(names(T.EC2104, 'MA1301', 'ug2')).toBe(false);
  });

  it('programme codes never match: CS2030DE\'s 0300CS2MJ against CS2040C', () => {
    expect(names(T.CS2030DE, 'CS2040C', 'ug2')).toBe(false);
    expect(names(T.BSP1703, 'EC2MJ', 'ug2')).toBe(false);
  });

  it('a rule whose every branch is conditioned on an NUS intake cohort is skipped; a "cohort" inside a programme rule is not', () => {
    expect(names(T.HY2262, 'YHU2314', 'ug2')).toBe(false);
    expect(names(T.HY2262, 'EU2221', 'ug2')).toBe(false);
    expect(names(T.PC1101, 'PC2020', 'ug2')).toBe(false);
    expect(names(T.PC1101, 'PC1144', 'ug2')).toBe(false);
    expect(names(T.DAO2702X, 'DAO2702', 'ug2')).toBe(true);
  });

  it('at grad, a rule opening with a clause naming undergraduates alone is skipped (either case, after an optional "(")', () => {
    expect(names(T.CS2030, 'CS2030S', 'grad')).toBe(false);
    expect(names(T.GES1034, 'GESS1024', 'grad')).toBe(false);
    expect(names(T.GES1034, 'GESS1024', 'ug1')).toBe(true);
    expect(names('(If undertaking an Undergraduate Degree THEN must not have completed CS2040C)', 'CS2040C', 'grad')).toBe(false);
    // Naming graduate coursework students too: kept.
    expect(names(T.MA4207, 'MA5219', 'grad')).toBe(true);
    expect(names(T.EE4705, 'EE5112', 'grad')).toBe(true);
    // "Undergraduate Degree" with no article is the same clause.
    expect(names(T.GESS1007, 'HY2239', 'grad')).toBe(false);
    expect(names(T.GESS1007, 'HY2239', 'ug2')).toBe(true);
    // Skipped by branch, not by the text's opening: a graduate-coursework branch still names it.
    expect(names(T.CS5462, 'CS4262', 'grad')).toBe(true);
    expect(names('(If undertaking an Undergraduate DegreeTHEN( must not have completed CS4262))OR(if undertaking a Graduate Degree ResearchTHEN( must not have completed CS1010))', 'CS1010', 'grad')).toBe(true);
    expect(names('(If undertaking an Undergraduate DegreeTHEN( must not have completed CS4262))OR(if undertaking a Graduate Degree ResearchTHEN( must not have completed CS1010))', 'CS4262', 'grad')).toBe(false);
    // Browse mode (no study level) reads every rule.
    expect(names(T.CS2030, 'CS2030S', '')).toBe(true);
  });

  it('no text names nothing', () => {
    expect(names(null, 'CS2030', 'ug2')).toBe(false);
    expect(names('', 'CS2030', 'ug2')).toBe(false);
  });
});
