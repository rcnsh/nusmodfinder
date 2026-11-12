// @ts-check
// The acad year the page names before any course row has loaded: the header's
// default and the shortlist's year until a /module row gives its own
// `acad_year`. Every year the page prints comes from the rows once one loads.
// The re-ingest runbook (docs/data.md) updates it with the data;
// test/web/shortlist.node.test.js checks it against data/ng-reasons.json.

/** As acad_year writes it. */
export const DEFAULT_ACAD_YEAR = '2026-2027';

/**
 * The first screen's semester months for an acad year (from the year, never literals):
 * Sem 1 runs August to December of its first year, Sem 2 January to May of its second.
 * @param {string} acadYear as acad_year writes it
 * @returns {{ 1: string, 2: string, both: string }}
 */
export function semesterMonths(acadYear) {
  const [first, second] = acadYear.split('-');
  return { 1: `Aug–Dec ${first}`, 2: `Jan–May ${second}`, both: `Aug ${first}–May ${second}` };
}

/** 'YYYY-YYYY' → 'YYYY/YY' (an acad year's label). @param {string} ay */
export const yearLabel = (ay) => {
  const m = /^(\d{4})-\d{2}(\d{2})$/.exec(ay);
  return m ? `${m[1]}/${m[2]}` : ay;
};

/** A year label → the next year's ('YYYY/YY' a year on). @param {string} label */
export function nextYearLabel(label) {
  const m = /^(\d{4})\/(\d{2})$/.exec(label);
  return m ? `${Number(m[1]) + 1}/${String((Number(m[2]) + 1) % 100).padStart(2, '0')}` : 'a later year';
}

/**
 * The header's year line at every width: which year's lists the site shows, and, in
 * the shortlist's words (public/shortlist.js FORM_LINES.applicants), what an applicant for the next
 * year should expect. The site moves to the next year in July (docs/year-refresh/README.md).
 * @param {string} acadYear as acad_year writes it
 */
export function headerYearLine(acadYear) {
  const year = yearLabel(acadYear);
  return `NUS's ${year} courses and exchange lists. Applying for ${nextYearLabel(year)}? NUS publishes Sem 1's list in March or April; until July, this site shows ${year}'s.`;
}
