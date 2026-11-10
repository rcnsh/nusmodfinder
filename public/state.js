// @ts-check
// The page's state and its URL (Phase 5 5B, F3, C-7): one pure state <->
// URLSearchParams mapping, so a shared link, Back and a reload all show the
// same page. No DOM here; test/web/state.node.test.js runs it in Node.
//
// - In exchange mode `ng=1` and `study` are always in the URL, and `sem` is
//   absent for both semesters; localStorage only pre-fills the set-up.
// - `open` names the one open detail (at most one, A2-4).
// - `pick` and `alt` are reserved for Phase 6: kept through every round trip
//   and transition, used for nothing yet.

/**
 * @typedef {{
 *   q: string, sem: string, level: string, credits: string, faculty: string,
 *   ng: boolean, study: string, ignore: string[], open: string,
 *   pick: string[], alt: string[],
 * }} State
 */

/** @typedef {{ value: string, label: string }} Option */

/** Semesters /search accepts (`sem=1..4`). Static, so no filter waits on /facets (F4). */
/** @type {readonly Option[]} */
export const SEMESTERS = Object.freeze([
  { value: '1', label: '1' }, { value: '2', label: '2' },
  { value: '3', label: 'Special term 1' }, { value: '4', label: 'Special term 2' },
]);

/** Course levels in the catalogue (1000 to 6000, and 8000). */
/** @type {readonly Option[]} */
export const LEVELS = Object.freeze(['1', '2', '3', '4', '5', '6', '8'].map((v) => ({ value: v, label: `${v}000` })));

/** The unit counts the credits filter offers. A URL may name any other. */
export const CREDITS = Object.freeze(['2', '4', '5', '6', '8', '12']);

/** Years of study at the home university (/search `study`). */
/** @type {readonly Option[]} */
export const STUDIES = Object.freeze([
  { value: 'ug1', label: '1st year' }, { value: 'ug2', label: '2nd year' }, { value: 'ug3', label: '3rd year' },
  { value: 'ug4', label: '4th year or later' }, { value: 'grad', label: 'Graduate' },
]);

/** A course code as the page accepts it in `open=` (upper-cased first). */
const CODE = /^[A-Z]{1,6}\d{4}[A-Z]{0,4}$/;

/** @returns {State} */
export function emptyState() {
  return { q: '', sem: '', level: '', credits: '', faculty: '', ng: false, study: '', ignore: [], open: '', pick: [], alt: [] };
}

/** @param {string | null} v @param {(v: string) => boolean} ok */
const keep = (v, ok) => (v !== null && ok(v) ? v : '');

/**
 * The state a URL describes. Values /search would reject are dropped, so a
 * mangled link still shows a page.
 * @param {URLSearchParams} params
 * @returns {State}
 */
export function parseState(params) {
  const ngRaw = params.get('ng');
  // As /search: only a value other than empty, 0 or false narrows.
  const ng = ngRaw !== null && ngRaw !== '' && ngRaw !== '0' && ngRaw !== 'false';
  const open = (params.get('open') ?? '').trim().toUpperCase();
  return {
    q: params.get('q') ?? '',
    sem: keep(params.get('sem'), (v) => SEMESTERS.some((o) => o.value === v)),
    level: keep(params.get('level'), (v) => /^[1-8]$/.test(v)),
    credits: keep(params.get('credits'), (v) => /^\d{1,2}$/.test(v)),
    faculty: (params.get('faculty') ?? '').trim(),
    ng,
    study: ng ? keep(params.get('study'), (v) => STUDIES.some((o) => o.value === v)) : '',
    ignore: [...new Set((params.get('ignore') ?? '').split(',').map((s) => s.trim()).filter(Boolean))].sort(),
    open: CODE.test(open) ? open : '',
    pick: params.getAll('pick'),
    alt: params.getAll('alt'),
  };
}

/**
 * The filters and exchange set-up, in the URL's canonical order.
 * @param {State} s
 * @returns {[string, string][]}
 */
function filterPairs(s) {
  /** @type {[string, string][]} */
  const pairs = [];
  if (s.sem) pairs.push(['sem', s.sem]);
  if (s.level) pairs.push(['level', s.level]);
  if (s.credits) pairs.push(['credits', s.credits]);
  if (s.faculty) pairs.push(['faculty', s.faculty]);
  if (s.ng) {
    pairs.push(['ng', '1']);
    if (s.study) pairs.push(['study', s.study]);
  }
  return pairs;
}

/**
 * The URL's query string for a state: q, the filters, ng and study, ignore,
 * open, then the reserved pick and alt. An empty state is no parameters.
 * @param {State} s
 */
export function stateToParams(s) {
  const out = new URLSearchParams();
  if (s.q.trim()) out.set('q', s.q);
  for (const [k, v] of filterPairs(s)) out.append(k, v);
  if (s.ignore.length) out.set('ignore', s.ignore.join(','));
  if (s.open) out.set('open', s.open);
  for (const v of s.pick) out.append('pick', v);
  for (const v of s.alt) out.append('alt', v);
  return out;
}

/**
 * The page URL (path plus query) for a state.
 * @param {State} s
 * @param {string} path
 */
export function urlFor(s, path) {
  const qs = stateToParams(s).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * The /search query for a state, or null when there is nothing to search: no
 * query, or exchange mode before the year of study is chosen.
 * @param {State} s
 * @returns {URLSearchParams | null}
 */
export function searchParams(s) {
  const q = s.q.trim();
  if (!q || (s.ng && !s.study)) return null;
  const out = new URLSearchParams({ q });
  for (const [k, v] of filterPairs(s)) out.append(k, v);
  if (s.ignore.length) out.set('ignore', s.ignore.join(','));
  return out;
}
