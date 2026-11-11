// @ts-check
// The acad year the page names before any course row has loaded (Phase 6 6B):
// the header's default and the shortlist's year until a /module row gives its
// own `acad_year`. Every year the page prints comes from the rows once one
// loads. The re-ingest runbook (docs/REFERENCE.md) updates it with the data;
// test/web/shortlist.node.test.js checks it against data/ng-reasons.json.

/** As acad_year writes it. */
export const DEFAULT_ACAD_YEAR = '2026-2027';
