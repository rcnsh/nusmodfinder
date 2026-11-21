// @ts-check

import { hasHidden } from './format.js';
import { emptyList, isCode, listPairs } from './list.js';

export { isCode };

/**
 * @typedef {{
 *   q: string, sem: string, level: string, credits: string, faculty: string,
 *   ng: boolean, study: string, ignore: string[], open: string, from: string,
 *   view: '' | 'shortlist',
 * }} State
 */

/** @typedef {{ value: string, label: string }} Option */

/** @type {readonly Option[]} */
export const SEMESTERS = Object.freeze([
  { value: '1', label: 'Sem 1' }, { value: '2', label: 'Sem 2' },
  { value: '3', label: 'Special term 1' }, { value: '4', label: 'Special term 2' },
]);

/** @param {string} v */
export const levelLabel = (v) => `Level ${v}000`;

/** @type {readonly Option[]} */
export const LEVELS = Object.freeze(['1', '2', '3', '4', '5', '6', '8'].map((v) => ({ value: v, label: levelLabel(v) })));

/** @param {string} v */
export const unitsLabel = (v) => `${v} unit${v === '1' ? '' : 's'}`;

export const CREDITS = Object.freeze(['2', '4', '5', '6', '8', '12']);

/** @type {readonly Option[]} */
export const STUDIES = Object.freeze([
  { value: 'ug1', label: '1st year' }, { value: 'ug2', label: '2nd year' }, { value: 'ug3', label: '3rd year' },
  { value: 'ug4', label: '4th year or later' }, { value: 'grad', label: 'Graduate' },
]);

export const IGNORABLE = Object.freeze(['ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);

export const MAX_QUERY_CHARS = 200;

/** @returns {State} */
export function emptyState() {
  return { q: '', sem: '', level: '', credits: '', faculty: '', ng: false, study: '', ignore: [], open: '', from: '', view: '' };
}

/** @param {string} v */
const facultyOk = (v) => v.length <= 60 && !hasHidden(v);

/** @param {string | null} v @param {(v: string) => boolean} ok */
const keep = (v, ok) => (v !== null && ok(v) ? v : '');

export const MAX_FILTER_VALUES = 12;

/**
 * @param {string | null} v
 * @param {(part: string) => boolean} ok
 */
const keepList = (v, ok) => [...new Set((v ?? '').split(',').map((p) => p.trim()).filter(ok).map(Number))]
  .sort((a, b) => a - b).slice(0, MAX_FILTER_VALUES).join(',');

/** @param {string} v */
export const listValues = (v) => (v ? v.split(',') : []);

/**
 * @param {URLSearchParams} params
 * @returns {State}
 */
export function parseState(params) {
  const ngRaw = params.get('ng');
  const ng = ngRaw !== null && ngRaw !== '' && ngRaw !== '0' && ngRaw !== 'false';
  const open = (params.get('open') ?? '').trim().toUpperCase();
  const from = (params.get('from') ?? '').trim().toUpperCase();
  const view = params.get('view') === 'shortlist' ? 'shortlist' : '';
  const openOk = !view && isCode(open);
  return {
    q: (params.get('q') ?? '').trim().slice(0, MAX_QUERY_CHARS),
    sem: keep(params.get('sem'), (v) => SEMESTERS.some((o) => o.value === v)),
    level: keepList(params.get('level'), (v) => /^[1-8]$/.test(v)),
    credits: keepList(params.get('credits'), (v) => /^\d{1,2}$/.test(v)),
    faculty: keep((params.get('faculty') ?? '').trim(), facultyOk),
    ng,
    study: ng ? keep(params.get('study'), (v) => STUDIES.some((o) => o.value === v)) : '',
    ignore: [...new Set((params.get('ignore') ?? '').split(',').map((s) => s.trim()).filter((s) => IGNORABLE.includes(s)))].sort(),
    open: openOk ? open : '',
    from: openOk && isCode(from) && from !== open ? from : '',
    view,
  };
}

/**
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
 * @param {State} s
 * @param {import('./list.js').List} [list]
 */
export function stateToParams(s, list = emptyList()) {
  const out = new URLSearchParams();
  if (s.q.trim()) out.set('q', s.q);
  for (const [k, v] of filterPairs(s)) out.append(k, v);
  if (s.ignore.length) out.set('ignore', s.ignore.join(','));
  if (s.open) out.set('open', s.open);
  if (s.open && s.from) out.set('from', s.from);
  for (const [k, v] of listPairs(list)) out.append(k, v);
  if (s.view) out.set('view', s.view);
  return out;
}

/**
 * @param {State} s
 * @param {import('./list.js').List} list
 * @param {string} path
 */
export function urlFor(s, list, path) {
  const qs = stateToParams(s, list).toString();
  return qs ? `${path}?${qs}` : path;
}

/**
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

/**
 * @param {State} s
 * @param {import('./list.js').List} list
 * @param {string} path
 */
export function shortlistUrl(s, list, path) {
  return urlFor({ ...emptyState(), sem: s.sem, ng: s.ng, study: s.study, view: 'shortlist' }, list, path);
}
