// @ts-check
// The acad year the page names before any course row has loaded (Phase 6 6B):
// the header's default and the shortlist's year until a /module row gives its
// own `acad_year`. Every year the page prints comes from the rows once one
// loads. The re-ingest runbook (docs/REFERENCE.md) updates it with the data;
// test/web/shortlist.node.test.js checks it against data/ng-reasons.json.

/** As acad_year writes it. */
export const DEFAULT_ACAD_YEAR = '2026-2027';

/**
 * The first screen's semester months for an acad year (Phase 7 7D: from the year, never literals):
 * Sem 1 runs August to December of its first year, Sem 2 January to May of its second.
 * @param {string} acadYear as acad_year writes it
 * @returns {{ 1: string, 2: string, both: string }}
 */
export function semesterMonths(acadYear) {
  const [first, second] = acadYear.split('-');
  return { 1: `Aug–Dec ${first}`, 2: `Jan–May ${second}`, both: `Aug ${first}–May ${second}` };
}
