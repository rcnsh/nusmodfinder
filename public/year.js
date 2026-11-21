// @ts-check

export const DEFAULT_ACAD_YEAR = '2026-2027';

/**
 * @param {string} acadYear
 * @returns {{ 1: string, 2: string, both: string }}
 */
export function semesterMonths(acadYear) {
  const [first, second] = acadYear.split('-');
  return { 1: `Aug–Dec ${first}`, 2: `Jan–May ${second}`, both: `Aug ${first}–May ${second}` };
}

/** @param {string} ay */
export const yearLabel = (ay) => {
  const m = /^(\d{4})-\d{2}(\d{2})$/.exec(ay);
  return m ? `${m[1]}/${m[2]}` : ay;
};

/** @param {string} label */
export function nextYearLabel(label) {
  const m = /^(\d{4})\/(\d{2})$/.exec(label);
  return m ? `${Number(m[1]) + 1}/${String((Number(m[2]) + 1) % 100).padStart(2, '0')}` : 'a later year';
}

/** @param {string} acadYear */
export function headerYearLine(acadYear) {
  const year = yearLabel(acadYear);
  return `NUS's ${year} courses and exchange lists. Applying for ${nextYearLabel(year)}? NUS publishes Sem 1's list in March or April; until July, this site shows ${year}'s.`;
}
