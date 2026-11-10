// @ts-check
// The status area and the result entries (Phase 5 5B, 5C; laid out as direction
// D's annotated catalogue in 5D). Built with DOM nodes only (F8). Each entry is
// an APG disclosure (A-8): a heading holding one button (code and title) that
// controls the detail region below it; the units, facts and the exchange status
// are plain text outside the button. The status is a stamp per semester (an
// icon, a word and a colour, so never colour alone), and every note shows in
// full (C2-3) with a lead-in word. No raw score (F1). app.js wires the buttons
// and fills the detail and the hidden-code lines.
import { h, setChildren } from './dom.js';
import { noteLead, noteText, notOfferedLine, partialCodeLine, stampText, typedCodes, unpinnedLine } from './explain.js';
import { examParts, semLabel } from './format.js';
import { icon } from './icons.js';
import { degradedNote, noMatchSentence } from './messages.js';

/** @typedef {{ status: HTMLElement, results: HTMLElement }} Targets */
/**
 * What app.js needs from a rendered answer.
 * @typedef {{
 *   cards: Map<string, { button: HTMLButtonElement, region: HTMLElement }>,
 *   hidden: Map<string, { why: HTMLElement, title: HTMLElement }>,
 *   partial: { line: HTMLElement, actions: HTMLElement, prefix: string, sem: string, study: string } | null,
 * }} Rendered
 * @typedef {{ searchHref: (code: string) => string, removableFilters: number, query: string }} RenderContext
 *   `removableFilters`: how many filter chips the student could remove (not the exchange set-up);
 *   `query`: the query as the student typed it (/search echoes it normalised), for the count line
 */

/** The stamp class and icon for a status. @type {Readonly<Record<string, string>>} */
const STAMP = Object.freeze({ open: 'open', note: 'note', closed: 'closed' });

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
  setChildren(t.results, ...Array.from({ length: 4 }, () => h('li', { class: 'skeleton', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'sk sk-code' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-line' }))));
}

/**
 * A link that runs a search for a course code (app.js handles the click, so
 * the page doesn't reload; the href works in a new tab).
 * @param {string} code
 * @param {{ searchHref: (code: string) => string }} ctx
 */
export function searchLink(code, ctx) {
  return h('a', { class: 'code-link', attrs: { href: ctx.searchHref(code), 'data-search': code } }, code);
}

/**
 * A status stamp: shape, word and colour (direction D).
 * @param {string} status 'open' | 'note' | 'closed'
 * @param {string} text
 */
export function stamp(status, text) {
  const s = STAMP[status] ?? 'closed';
  return h('span', { class: `st st-${s} exchange-status`, attrs: { 'data-status': s } }, icon(s), h('span', null, text));
}

/**
 * A note: its lead-in word, then its text in full.
 * @param {{ kind: string, text: string }} r
 * @param {string} text
 * @param {import('./dom.js').Child} [extra] after the text (the detail's source line)
 */
export function noteItem(r, text, extra = null) {
  const lead = r.kind === 'closed' ? '' : noteLead(r.kind);
  return h('li', null, lead ? h('span', { class: 'k' }, lead) : null, lead ? ' ' : null, text, extra);
}

/** @param {any} r @returns {{ id: string, kind: string, text: string }} */
const asReason = (r) => ({ id: String(r?.id ?? ''), kind: String(r?.kind ?? ''), text: String(r?.text ?? '') });

/** @param {{ status?: unknown } | null | undefined} x @returns {import('./explain.js').Status} */
const statusOf = (x) => (x?.status === 'open' ? 'open' : x?.status === 'note' ? 'note' : 'closed');

/** @param {{ reasons?: unknown } | null | undefined} x */
const reasonsOf = (x) => (Array.isArray(x?.reasons) ? x.reasons.map(asReason) : []);

/**
 * The notes aside: groups of notes, each with an optional scope line.
 * @param {{ scope: string, items: { r: { kind: string, text: string }, text: string }[] }[]} groups
 */
function notesBox(groups) {
  const shown = groups.filter((g) => g.items.length);
  if (!shown.length) return null;
  return h('div', { class: 'notes-box' }, ...shown.flatMap((g) => [
    g.scope ? h('p', { class: 'scope' }, g.scope) : null,
    h('ul', { class: 'notes' }, ...g.items.map(({ r, text }) => noteItem(r, text))),
  ]));
}

/**
 * The entry's exchange column: the chosen semester's stamp and its notes; or,
 * planning both, a stamp per semester (never one merged value) with the notes
 * each semester shares said once; outside exchange mode, the semesters the
 * course is on the exchange list for (D2's marker).
 * @param {any} m a /search result
 * @param {Record<string, unknown>} filters
 */
function exchangeBlock(m, filters) {
  const bySem = m.exchangeBySem && typeof m.exchangeBySem === 'object' ? m.exchangeBySem : null;
  if (bySem) {
    const per = [1, 2].map((sem) => ({ sem, status: statusOf(bySem[sem]), notes: reasonsOf(bySem[sem]).map((r) => ({ r, text: noteText(r, sem) })) }));
    const texts = per.map((p) => new Set(p.notes.map((n) => n.text)));
    const shared = per[0].notes.filter((n) => texts[1].has(n.text));
    const only = per.map((p, i) => p.notes.filter((n) => !texts[1 - i].has(n.text)));
    return h('div', { class: 'exchange guide' },
      h('div', { class: 'stamps both' }, ...per.map((p) => stamp(p.status, stampText(p.status, p.sem, p.notes.length, true)))),
      notesBox([
        { scope: `Notes for ${semLabel(1)}`, items: only[0] },
        { scope: `Notes for ${semLabel(2)}`, items: only[1] },
        { scope: `Notes for ${semLabel(1)} and ${semLabel(2)}`, items: shared },
      ]));
  }
  if (m.exchange) {
    const sem = filters.sem === 1 || filters.sem === 2 ? filters.sem : 'any';
    const status = statusOf(m.exchange);
    const notes = reasonsOf(m.exchange).map((r) => ({ r, text: noteText(r, sem) }));
    return h('div', { class: 'exchange guide' },
      h('div', { class: 'stamps' }, stamp(status, stampText(status, sem, notes.length))),
      notesBox([{ scope: '', items: notes }]));
  }
  if (!m.ng) return null;
  return h('div', { class: 'guide' }, h('p', {
    class: 'ng', attrs: { title: "On the Registrar's list of courses offered to exchange (Non-Graduating) students" },
  }, `On the exchange (NG) list: ${(Array.isArray(m.ngSemesters) ? m.ngSemesters : []).map(semLabel).join(', ')}`));
}

let nextId = 0;

/**
 * One result entry: code and units, title and facts, exchange status and notes.
 * @param {any} m a /search result
 * @param {Record<string, unknown>} filters
 * @param {Rendered['cards']} cards filled with this entry's button and region
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
  const exams = examParts(Array.isArray(m.examDates) ? m.examDates : [], sem);
  const dept = String(m.department || m.faculty || '');
  const fac = m.department && m.faculty && m.faculty !== m.department ? String(m.faculty) : '';
  return h('li', { class: 'card entry' },
    h('h2', { class: 'card-head' }, button),
    h('p', { class: 'units' }, `${m.credits ?? '?'} units`),
    h('p', { class: 'meta' },
      h('span', { class: 'dept' }, dept, fac ? h('span', { class: 'fac' }, ` · ${fac}`) : null),
      h('span', { class: 'sems' }, semesters.length ? `Taught in ${semesters.map(semLabel).join(', ')}` : 'Not offered'),
      ...(exams.length
        ? exams.map((e) => h('span', { class: 'exam' }, h('span', { class: 'exl' }, e.label), ' ', h('span', { class: 'mono' }, e.when)))
        : [h('span', { class: 'exam' }, 'No final exam')])),
    variants.length ? h('p', { class: 'variants' }, `Also as ${variants.join(', ')}`) : null,
    exchangeBlock(m, filters),
    region);
}

/** @type {Readonly<Record<string, string>>} */
const STUDY_ADJ = Object.freeze({ ug1: '1st-year', ug2: '2nd-year', ug3: '3rd-year', ug4: '4th-year (or later)', grad: 'graduate' });

/**
 * The typed codes this answer doesn't show, in a box above the entries: a
 * hidden code waits for app.js to say why (from /module/:code); a code not
 * offered this year is said at once.
 * @param {any} data
 * @param {Record<string, unknown>} filters
 * @param {Rendered['hidden']} hidden
 * @param {HTMLElement | null} unpinned the pin note, kept inside the box when there is one
 */
function hiddenBox(data, filters, hidden, unpinned) {
  const nm = data.noMatch;
  /** @type {string[]} */
  const hiddenPins = Array.isArray(data.hiddenPins) ? data.hiddenPins.map(String) : [];
  /** @type {string[]} */
  const notOffered = (Array.isArray(data.notOffered) ? data.notOffered.map(String) : [])
    .filter((/** @type {string} */ c) => !(nm?.reason === 'not-offered' && nm.code === c));
  if (!hiddenPins.length && !notOffered.length) return null;
  /** Each code: its code and title (app.js fills the title from /module/:code), then why. @param {string} code @param {HTMLElement} why */
  const item = (code, why, title = h('span', { class: 'hc-title' })) => h('li', { class: 'hc', attrs: { 'data-code': code } },
    icon('closed', 'hc-mark'), h('div', { class: 'hc-body' }, h('p', { class: 'hc-head' }, h('span', { class: 'hc-code' }, code), title), why));
  const items = [
    ...hiddenPins.map((code) => {
      const why = h('p', { class: 'why' }, `${code} isn't shown with these settings.`);
      const title = h('span', { class: 'hc-title' });
      hidden.set(code, { why, title });
      return item(code, why, title);
    }),
    ...notOffered.map((code) => item(code, h('p', { class: 'why' }, notOfferedLine(code)))),
  ];
  const count = items.length;
  const typed = Math.max(count, typedCodes(String(data.query ?? '')).length);
  const exchange = filters.ng === true && typeof filters.study === 'string';
  const when = filters.sem === 1 || filters.sem === 2 ? semLabel(filters.sem) : 'both semesters';
  const intro = hiddenPins.length && exchange
    ? `You chose ${when} as a ${STUDY_ADJ[String(filters.study)] ?? ''} exchange student, so courses you can't take then are left out.`
    : null;
  return h('section', { class: 'hiddenbox', attrs: { 'aria-label': 'Codes you typed that aren\'t shown' } },
    h('h2', { class: 'hb-title' }, `${count} of the ${typed} code${typed === 1 ? '' : 's'} you typed ${count === 1 ? "isn't" : "aren't"} shown`),
    intro ? h('p', { class: 'hb-intro' }, intro) : null,
    h('ul', { class: 'hidden-codes' }, ...items),
    unpinned,
    hiddenPins.length ? h('p', { class: 'gloss' }, "NG list: the NUS Registrar's list of courses offered to exchange (“non-graduating”) students.") : null);
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
 * A /search answer: why typed codes aren't shown, the count (or why there are
 * no results and what to do next); then the entries.
 * @param {Targets} t
 * @param {any} data
 * @param {RenderContext} ctx
 * @returns {Rendered}
 */
export function showResults(t, data, ctx) {
  /** @type {Rendered} */
  const out = { cards: new Map(), hidden: new Map(), partial: null };
  const filters = data.filters && typeof data.filters === 'object' ? data.filters : {};
  const note = degradedNote(data.degraded);
  const noteLine = note ? h('p', { class: 'degraded' }, note) : null;
  const results = Array.isArray(data.results) ? data.results : [];
  const query = String(data.query ?? '');
  const shown = new Set(results.flatMap((/** @type {any} */ r) => [String(r?.code ?? ''), ...(Array.isArray(r?.variants) ? r.variants.map((/** @type {any} */ v) => String(v?.code ?? '')) : [])]));
  const unpinned = unpinnedLine(query, {
    pinned: Array.isArray(data.interpreted?.pin) ? data.interpreted.pin.map(String) : [],
    hidden: Array.isArray(data.hiddenPins) ? data.hiddenPins.map(String) : [],
    notOffered: Array.isArray(data.notOffered) ? data.notOffered.map(String) : [],
    shown,
  });
  const unpinnedEl = unpinned ? h('p', { class: 'unpinned' }, unpinned) : null;
  const box = hiddenBox(data, filters, out.hidden, unpinnedEl);
  const loose = box ? null : unpinnedEl;

  if (data.noMatch || results.length === 0) {
    setChildren(t.results);
    const partial = data.noMatch ? null : partialCode(data, filters);
    if (partial) {
      const line = h('p', { class: 'partial' }, partialCodeLine({ ...partial, otherHasResults: null }));
      const actions = h('div', { class: 'partial-actions' });
      out.partial = { line, actions, ...partial };
      setStatus(t, [h('div', { class: 'empty' }, line, actions), noteLine]);
      return out;
    }
    /** @type {string[]} */
    const related = Array.isArray(data.noMatch?.related) ? data.noMatch.related.map(String).filter(Boolean) : [];
    const relatedLine = related.length
      ? h('p', { class: 'related' }, 'Related courses offered this year: ', ...related.flatMap((c, i) => [i ? ', ' : null, searchLink(c, ctx)]))
      : null;
    // The next step. Never "loosen" the exchange set-up: it is eligibility, not a preference.
    const next = data.noMatch ? null
      : ctx.removableFilters > 0 ? 'Remove a filter above to see more courses, or try other words.'
        : box ? null : 'Try other words for the topic, or fewer of them.';
    const head = !data.noMatch && box ? `No results for “${query}”.` : noMatchSentence({ query, noMatch: data.noMatch });
    setStatus(t, [h('div', { class: 'empty' }, h('p', { class: 'empty-head' }, head), relatedLine, next ? h('p', { class: 'next' }, next) : null), box, loose, noteLine]);
    return out;
  }
  setStatus(t, [
    box,
    h('div', { class: 'countrow' },
      h('p', { class: 'count' }, h('strong', null, `${results.length} course${results.length === 1 ? '' : 's'}`), ' match ', h('span', { class: 'q' }, `“${ctx.query.trim() || query}”`)),
      h('p', { class: 'tz' }, 'Exam times are Singapore time (UTC+8)')),
    loose,
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
  const button = h('button', { class: 'btn see-other', attrs: { type: 'button' } }, `See ${semLabel(other)} courses`);
  button.addEventListener('click', seeOther);
  setChildren(p.actions, button);
}
