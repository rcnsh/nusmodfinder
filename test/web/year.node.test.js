// @ts-check
// Phase 7 7D, one year source: the first screen's semester months come from
// the acad year (public/year.js), not from literals in public/app.js.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR, semesterMonths } from '../../public/year.js';

describe('semesterMonths', () => {
  it('names Sem 1 in the first year, Sem 2 in the second, and both across them', () => {
    expect(semesterMonths('2030-2031')).toEqual({ 1: 'Aug–Dec 2030', 2: 'Jan–May 2031', both: 'Aug 2030–May 2031' });
  });

  it('follows DEFAULT_ACAD_YEAR', () => {
    const [a, b] = DEFAULT_ACAD_YEAR.split('-');
    expect(semesterMonths(DEFAULT_ACAD_YEAR)).toEqual({ 1: `Aug–Dec ${a}`, 2: `Jan–May ${b}`, both: `Aug ${a}–May ${b}` });
  });
});
