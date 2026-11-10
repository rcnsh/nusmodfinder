// @ts-check
// The status area and the result cards (Phase 5 5B, 5C). Built with DOM nodes
// only (F8). Each card is an APG disclosure (A-8): a heading holding one button
// (code and title) that controls the detail region below it; the meta line and
// the exchange status are plain text outside the button, every note in full
// (C2-3), and no raw score (F1). Classes name structure, not looks: 5D styles
// them. app.js wires the buttons and fills the detail and the hidden-code lines.
import { h, setChildren } from './dom.js';
import { notOfferedLine, noteText, partialCodeLine, statusText, unpinnedLine } from './explain.js';
import { examSummary, semLabel } from './format.js';
import { degradedNote, noMatchSentence } from './messages.js';
import { STUDIES } from './state.js';

/** @typedef {{ status: HTMLElement, results: HTMLElement }} Targets */
/**
 * What app.js needs from a rendered answer.
 * @typedef {{
 *   cards: Map<string, { button: HTMLButtonElement, region: HTMLElement }>,
 *   hidden: Map<string, HTMLElement>,
 *   partial: { line: HTMLElement, actions: HTMLElement, prefix: string, sem: string, study: string } | null,
 * }} Rendered
 * @typedef {{ searchHref: (code: string) => string }} RenderContext
 */

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
 * A link that runs a search for a course code (app.js handles the click, so
 * the page doesn't reload; the href works in a new tab).
 * @param {string} code
 * @param {RenderContext} ctx
 */
export function searchLink(code, ctx) {
  return h('a', { class: 'code-link', attrs: { href: ctx.searchHref(code), 'data-search': code } }, code);
}

/**
 * One semester's exchange status on a card: the status in words, then every
 * note in full.
 * @param {{ status?: unknown, reasons?: unknown } | null | undefined} x /search's `exchange` or one `exchangeBySem` entry
 * @param {number | string} sem 1, 2, or 'any' (no semester chosen)
 * @param {boolean} label prefix the semester's name
 */
function exchangeLine(x, sem, label) {
  const status = x?.status === 'open' || x?.status === 'note' ? x.status : 'closed';
  const reasons = Array.isArray(x?.reasons) ? x.reasons : [];
  return [
    h('p', { class: 'exchange-status', attrs: { 'data-status': status } },
      label ? h('span', { class: 'exchange-sem' }, `${semLabel(sem)}: `) : null, statusText(status)),
    reasons.length ? h('ul', { class: 'notes' }, ...reasons.map((/** @type {any} */ r) => h('li', null, noteText({
      id: String(r?.id ?? ''), kind: String(r?.kind ?? ''), text: String(r?.text ?? ''),
    }, sem)))) : null,
  ];
}

/**
 * The card's exchange block: the chosen semester's status, or each
 * semester's when planning both (never one merged value); outside exchange
 * mode, the semesters the course is on the exchange list for (D2's marker).
 * @param {any} m a /search result
 * @param {Record<string, unknown>} filters
 */
function exchangeBlock(m, filters) {
  const bySem = m.exchangeBySem && typeof m.exchangeBySem === 'object' ? m.exchangeBySem : null;
  if (bySem) return h('div', { class: 'exchange' }, ...exchangeLine(bySem[1], 1, true), ...exchangeLine(bySem[2], 2, true));
  if (m.exchange) {
    const sem = filters.sem === 1 || filters.sem === 2 ? filters.sem : 'any';
    return h('div', { class: 'exchange' }, ...exchangeLine(m.exchange, sem, sem !== 'any'));
  }
  if (!m.ng) return null;
  return h('p', {
    class: 'ng', attrs: { title: "On the Registrar's list of courses offered to exchange (Non-Graduating) students" },
  }, `On the exchange (NG) list: ${(Array.isArray(m.ngSemesters) ? m.ngSemesters : []).map(semLabel).join(', ')}`);
}

let nextId = 0;

/**
 * One result card.
 * @param {any} m a /search result
 * @param {Record<string, unknown>} filters
 * @param {Rendered['cards']} cards filled with this card's button and region
 */
function card(m, filters, cards) {
  const code = String(m.code ?? '');
  const n = nextId++;
  const button = h('button', {
    class: 'card-toggle', attrs: { type: 'button', id: `card-${n}`, 'aria-expanded': 'false', 'aria-controls': `detail-${n}`, 'data-code': code },
  }, h('span', { class: 'code' }, code), ' ', h('span', { class: 'title' }, String(m.title ?? '')));
  const region = h('div', { class: 'detail', attrs: { id: `detail-${n}`, role: 'region', 'aria-labelledby': `card-${n}` } });
  region.hidden = true;
  if (!cards.has(code)) cards.set(code, { button, region });
  const semesters = Array.isArray(m.semesters) ? m.semesters : [];
  const variants = Array.isArray(m.variants) ? m.variants.map((/** @type {any} */ v) => String(v?.code ?? '')).filter(Boolean) : [];
  const sem = filters.sem === undefined ? '' : String(filters.sem);
  return h('li', { class: 'card' },
    h('h2', { class: 'card-head' }, button),
    h('p', { class: 'meta' },
      h('span', null, `${m.credits ?? '?'} units`),
      h('span', null, String(m.department || m.faculty || '')),
      h('span', null, semesters.length ? semesters.map(semLabel).join(', ') : 'Not offered'),
      h('span', null, examSummary(Array.isArray(m.examDates) ? m.examDates : [], sem))),
    variants.length ? h('p', { class: 'variants' }, `Also as ${variants.join(', ')}`) : null,
    exchangeBlock(m, filters),
    region);
}

/**
 * The typed codes this answer doesn't show, each on its own line: a hidden
 * code waits for app.js to say why (from /module/:code); a code not offered
 * this year is said at once.
 * @param {any} data
 * @param {Rendered['hidden']} hidden
 */
function codeLines(data, hidden) {
  const nm = data.noMatch;
  /** @type {string[]} */
  const hiddenPins = Array.isArray(data.hiddenPins) ? data.hiddenPins.map(String) : [];
  /** @type {string[]} */
  const notOffered = (Array.isArray(data.notOffered) ? data.notOffered.map(String) : [])
    .filter((/** @type {string} */ c) => !(nm?.reason === 'not-offered' && nm.code === c));
  if (!hiddenPins.length && !notOffered.length) return null;
  const items = [
    ...hiddenPins.map((code) => {
      const li = h('li', { attrs: { 'data-code': code } }, `${code} isn't shown with these settings.`);
      hidden.set(code, li);
      return li;
    }),
    ...notOffered.map((code) => h('li', { attrs: { 'data-code': code } }, notOfferedLine(code))),
  ];
  return h('ul', { class: 'hidden-codes' }, ...items);
}

/**
 * A whole-query partial code ("CS32") that exchange mode emptied, with only
 * the exchange set-up as filters (C3-2), or null.
 * @param {any} data
 * @param {Record<string, unknown>} filters
 */
function partialCode(data, filters) {
  const prefix = data.interpreted?.prefix;
  if (typeof prefix !== 'string' || !prefix || filters.ng !== true || typeof filters.study !== 'string') return null;
  if (String(data.query ?? '').replace(/\s+/g, '').toUpperCase() !== prefix.toUpperCase()) return null;
  if (Object.keys(filters).some((k) => !['ng', 'study', 'sem'].includes(k))) return null;
  const sem = filters.sem === 1 || filters.sem === 2 ? String(filters.sem) : '';
  return { prefix, sem, study: filters.study };
}

/**
 * A /search answer: the count and chips, why typed codes aren't shown, or why
 * there are no results; then the cards.
 * @param {Targets} t
 * @param {any} data
 * @param {RenderContext} ctx
 * @returns {Rendered}
 */
export function showResults(t, data, ctx) {
  /** @type {Rendered} */
  const out = { cards: new Map(), hidden: new Map(), partial: null };
  const filters = data.filters && typeof data.filters === 'object' ? data.filters : {};
  const filterChips = chips(filters);
  const note = degradedNote(data.degraded);
  const noteLine = note ? h('div', { class: 'chips' }, note) : null;
  const results = Array.isArray(data.results) ? data.results : [];
  const query = String(data.query ?? '');
  const lines = codeLines(data, out.hidden);
  const shown = new Set(results.flatMap((/** @type {any} */ r) => [String(r?.code ?? ''), ...(Array.isArray(r?.variants) ? r.variants.map((/** @type {any} */ v) => String(v?.code ?? '')) : [])]));
  const unpinned = unpinnedLine(query, {
    pinned: Array.isArray(data.interpreted?.pin) ? data.interpreted.pin.map(String) : [],
    hidden: Array.isArray(data.hiddenPins) ? data.hiddenPins.map(String) : [],
    notOffered: Array.isArray(data.notOffered) ? data.notOffered.map(String) : [],
    shown,
  });
  const unpinnedEl = unpinned ? h('p', { class: 'unpinned' }, unpinned) : null;

  if (data.noMatch || results.length === 0) {
    setChildren(t.results);
    const partial = data.noMatch ? null : partialCode(data, filters);
    if (partial) {
      const line = h('p', { class: 'partial' }, partialCodeLine({ ...partial, otherHasResults: null }));
      const actions = h('div', { class: 'partial-actions' });
      out.partial = { line, actions, ...partial };
      setStatus(t, [line, actions, noteLine]);
      return out;
    }
    /** @type {string[]} */
    const related = Array.isArray(data.noMatch?.related) ? data.noMatch.related.map(String).filter(Boolean) : [];
    const relatedLine = related.length
      ? h('p', { class: 'related' }, 'Related courses offered this year: ', ...related.flatMap((c, i) => [i ? ', ' : null, searchLink(c, ctx)]))
      : null;
    // Never "loosen" the exchange set-up: it is eligibility, not a preference.
    const exchangeKeys = filters.ng === true ? ['ng', 'study', 'sem'] : [];
    const canLoosen = Object.keys(filters).some((k) => !exchangeKeys.includes(k));
    const loosen = data.noMatch || !filterChips.length ? []
      : [h('div', { class: 'chips' }, 'Filters applied: ', ...filterChips), canLoosen ? h('div', { class: 'chips' }, 'Try loosening one.') : null];
    const head = !data.noMatch && lines ? `No results for “${query}”.` : noMatchSentence({ query, noMatch: data.noMatch });
    setStatus(t, [head, relatedLine, lines, unpinnedEl, ...loosen, noteLine]);
    return out;
  }
  setStatus(t, [
    `${results.length} result${results.length === 1 ? '' : 's'} for `, h('strong', null, query),
    filterChips.length ? h('div', { class: 'chips' }, ...filterChips) : null,
    lines, unpinnedEl,
    noteLine,
  ]);
  setChildren(t.results, ...results.map((/** @type {any} */ m) => card(m, filters, out.cards)));
  return out;
}

/**
 * The partial-code line once the other semester has been checked: the
 * either-semester sentence when it is empty too, else the chosen semester's
 * and a button to see the other.
 * @param {NonNullable<Rendered['partial']>} p
 * @param {boolean | null} otherHasResults null when the check failed
 * @param {() => void} seeOther
 */
export function settlePartial(p, otherHasResults, seeOther) {
  setChildren(p.line, partialCodeLine({ prefix: p.prefix, sem: p.sem, study: p.study, otherHasResults }));
  if (otherHasResults !== true || !p.sem) { setChildren(p.actions); return; }
  const other = p.sem === '1' ? '2' : '1';
  const button = h('button', { class: 'see-other', attrs: { type: 'button' } }, `See ${semLabel(other)} courses`);
  button.addEventListener('click', seeOther);
  setChildren(p.actions, button);
}
