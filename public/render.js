// @ts-check
// The status line and the result cards (Phase 5 5B). The same output as the
// Phase 4 page (docs/evidence/phase0/page-phase4.html), built with DOM nodes
// instead of HTML strings (F8). The cards' content and look are 5C's and 5D's.
import { h, setChildren } from './dom.js';
import { semLabel } from './format.js';
import { degradedNote, noMatchSentence } from './messages.js';
import { STUDIES } from './state.js';

/** @typedef {{ status: HTMLElement, results: HTMLElement }} Targets */

/**
 * A status message; `error` gives it the error style.
 * @param {Targets} t
 * @param {import('./dom.js').Child[]} content
 * @param {boolean} [error]
 */
export function setStatus(t, content, error = false) {
  t.status.className = `status${error ? ' error' : ''}`;
  setChildren(t.status, ...content);
}

/**
 * A message with no results under it.
 * @param {Targets} t
 * @param {string} text
 * @param {boolean} [error]
 */
export function showMessage(t, text, error = false) {
  setChildren(t.results);
  setStatus(t, [text], error);
}

/** @param {Targets} t */
export function showLoading(t) {
  setStatus(t, ['Searching…']);
  setChildren(t.results, ...Array.from({ length: 5 }, () => h('li', { class: 'skeleton' })));
}

/**
 * The filters /search echoed, as chips.
 * @param {Record<string, unknown>} filters
 */
function chips(filters) {
  return Object.entries(filters ?? {}).map(([k, v]) => h('span', { class: 'chip' },
    k === 'ng' ? 'exchange students only'
      : k === 'study' ? (STUDIES.find((o) => o.value === v)?.label ?? String(v))
        : `${k}: ${k === 'sem' ? semLabel(/** @type {string} */ (v)) : String(v)}`));
}

/**
 * One result card.
 * @param {any} m a /search result
 */
function card(m) {
  const semesters = Array.isArray(m.semesters) ? m.semesters : [];
  const reasons = Array.isArray(m.exchange?.reasons) ? m.exchange.reasons : [];
  return h('li', null,
    h('div', { class: 'head' },
      h('span', { class: 'code' }, String(m.code ?? '')),
      h('span', { class: 'title' }, String(m.title ?? ''),
        m.ng ? h('span', {
          class: 'ng', attrs: { title: "On the Registrar's list of courses offered to exchange (Non-Graduating) students" },
        }, `NG ${(Array.isArray(m.ngSemesters) ? m.ngSemesters : []).map(semLabel).join(', ')}`) : null),
      h('span', { class: 'score' }, (Number(m.score) || 0).toFixed(3))),
    h('div', { class: 'meta' },
      h('span', null, String(m.department || m.faculty || '')),
      h('span', null, `${m.credits ?? '?'} units`),
      h('span', null, semesters.length ? semesters.map(semLabel).join(', ') : 'Not offered')),
    reasons.length ? h('ul', { class: 'notes' }, ...reasons.map((/** @type {any} */ r) => h('li', null, String(r?.text ?? '')))) : null);
}

/**
 * A /search answer: the count and chips, or why there are no results.
 * @param {Targets} t
 * @param {any} data
 */
export function showResults(t, data) {
  const filterChips = chips(data.filters);
  const note = degradedNote(data.degraded);
  const noteLine = note ? h('div', { class: 'chips' }, note) : null;
  const results = Array.isArray(data.results) ? data.results : [];
  if (data.noMatch || results.length === 0) {
    setChildren(t.results);
    const loosen = !data.noMatch && filterChips.length
      ? [h('div', { class: 'chips' }, 'Filters applied: ', ...filterChips), h('div', { class: 'chips' }, 'Try loosening one.')]
      : [];
    setStatus(t, [noMatchSentence({ query: String(data.query ?? ''), noMatch: data.noMatch }), ...loosen, noteLine]);
    return;
  }
  setStatus(t, [
    `${results.length} result${results.length === 1 ? '' : 's'} for `, h('strong', null, String(data.query ?? '')),
    filterChips.length ? h('div', { class: 'chips' }, ...filterChips) : null,
    noteLine,
  ]);
  setChildren(t.results, ...results.map(card));
}
