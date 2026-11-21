// @ts-check
import { h, setChildren } from './dom.js';
import { NOT_OFFERED_STAMP, boxNotOffered, codesCount, codesOnly, noteLead, noteText, notOfferedLine, partialCodeLine, stampText, studyAdj, typedCodes, unpinnedLine } from './explain.js';
import { examParts, quoteUser, semLabel } from './format.js';
import { icon } from './icons.js';
import { degradedNote, noMatchSentence } from './messages.js';
import { isCode } from './state.js';

/** @typedef {{ status: HTMLElement, results: HTMLElement }} Targets */
/**
 * @typedef {{
 *   cards: Map<string, { button: HTMLButtonElement, region: HTMLElement }>,
 *   hidden: Map<string, { why: HTMLElement, title: HTMLElement, stamp: HTMLElement, actions: HTMLElement }>,
 *   partial: { line: HTMLElement, actions: HTMLElement, prefix: string, sem: string, study: string } | null,
 *   announce: string,
 * }} Rendered
 * @typedef {{
 *   searchHref: (code: string) => string, variantHref: (code: string, from: string) => string,
 *   removableFilters: number, query: string, listed: (code: string) => boolean,
 * }} RenderContext
 */

/** @type {Readonly<Record<string, string>>} */
const STAMP = Object.freeze({ open: 'open', note: 'note', closed: 'closed' });

/**
 * @param {Targets} t
 * @param {import('./dom.js').Child[]} content
 * @param {boolean} [error]
 */
export function setStatus(t, content, error = false) {
  t.status.className = `status${error ? ' error' : ''}`;
  setChildren(t.status, ...content);
}

/** @param {Targets} t @param {boolean} busy */
const setBusy = (t, busy) => t.results.setAttribute('aria-busy', String(busy));

/**
 * @param {Targets} t
 * @param {string} text
 * @param {boolean} [error]
 */
export function showMessage(t, text, error = false) {
  setChildren(t.results);
  setBusy(t, false);
  setStatus(t, [text], error);
}

/** @param {Targets} t */
export function showLoading(t) {
  setBusy(t, true);
  setStatus(t, ['Searching…']);
  setChildren(t.results, ...Array.from({ length: 4 }, () => h('li', { class: 'skeleton', attrs: { 'aria-hidden': 'true' } },
    h('span', { class: 'sk sk-code' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-line' }))));
}

/**
 * @param {string} code
 * @param {{ searchHref: (code: string) => string }} ctx
 */
export function searchLink(code, ctx) {
  return h('a', { class: 'code-link', attrs: { href: ctx.searchHref(code), 'data-search': code } }, code);
}

/**
 * @param {string} code
 * @param {string} from
 * @param {Pick<RenderContext, 'variantHref'>} ctx
 */
function variantLink(code, from, ctx) {
  if (!isCode(code)) return code;
  return h('a', { class: 'variant-link', attrs: { href: ctx.variantHref(code, from), 'data-variant': code, 'data-from': from } }, code);
}

/**
 * @param {string} code
 * @param {boolean} pressed
 */
export function shortlistToggle(code, pressed) {
  return h('button', {
    class: 'btn sl-toggle', attrs: { type: 'button', 'aria-pressed': String(pressed), 'aria-label': `Shortlist, ${code}`, 'data-sl': code },
  }, icon('mark-off'), icon('mark-on'), h('span', null, 'Shortlist'));
}

/**
 * @param {string} status
 * @param {string} text
 */
export function stamp(status, text) {
  const s = STAMP[status] ?? 'closed';
  return h('span', { class: `st st-${s} exchange-status`, attrs: { 'data-status': s } }, icon(s), h('span', null, text));
}

/**
 * @param {{ kind: string, text: string }} r
 * @param {string} text
 * @param {import('./dom.js').Child} [extra]
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

/** @param {{ scope: string, items: { r: { kind: string, text: string }, text: string }[] }[]} groups */
function notesBox(groups) {
  const shown = groups.filter((g) => g.items.length);
  if (!shown.length) return null;
  return h('div', { class: 'notes-box' }, ...shown.flatMap((g) => [
    g.scope ? h('p', { class: 'scope' }, g.scope) : null,
    h('ul', { class: 'notes' }, ...g.items.map(({ r, text }) => noteItem(r, text))),
  ]));
}

/**
 * @param {any} m
 * @param {Record<string, unknown>} filters
 */
function exchangeBlock(m, filters) {
  const bySem = m.exchangeBySem && typeof m.exchangeBySem === 'object' ? m.exchangeBySem : null;
  if (bySem) {
    const per = [1, 2].map((sem) => ({ sem, status: statusOf(bySem[sem]), notes: reasonsOf(bySem[sem]).map((r) => ({ r, text: noteText(r, sem) })) }));
    const texts = per.map((p) => new Set(p.notes.map((n) => n.text)));
    const shared = per[0].notes.filter((n) => texts[1].has(n.text));
    const only = per.map((p, i) => p.notes.filter((n) => !texts[1 - i].has(n.text)));
    return h('div', { class: 'exchange' },
      h('div', { class: 'stamps both' }, ...per.map((p) => stamp(p.status, stampText(p.status, p.sem, p.notes.map((n) => n.r), true)))),
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
    return h('div', { class: 'exchange' },
      h('div', { class: 'stamps' }, stamp(status, stampText(status, sem, notes.map((n) => n.r)))),
      notesBox([{ scope: '', items: notes }]));
  }
  return null;
}

export const MIN_REVIEWS = 3;

/** @param {number} x */
export function overallWord(x) {
  return x >= 4 ? 'Well liked' : x >= 3.4 ? 'Liked' : x >= 2.6 ? 'Mixed' : x >= 1.8 ? 'Disliked' : 'Strongly disliked';
}

/**
 * @param {string} label
 * @param {unknown} x
 * @param {string} low
 * @param {string} high
 */
function reviewMeter(label, x, low, high) {
  if (typeof x !== 'number') return h('div', { class: 'rv-row' }, h('span', { class: 'rv-k' }, label), h('span', { class: 'rv-none' }, 'Reviews don’t say'));
  const filled = Math.round(x);
  return h('div', { class: 'rv-row' },
    h('span', { class: 'rv-k' }, label),
    h('span', { class: 'rv-meter', attrs: { role: 'img', 'aria-label': `${x.toFixed(1)} of 5, from ${low} to ${high}` } },
      ...[0, 1, 2, 3, 4].map((i) => h('i', i < filled ? { class: 'on' } : null))),
    h('span', { class: 'rv-ends', attrs: { 'aria-hidden': 'true' } }, `${low} – ${high}`));
}

/** @param {any} m */
export function reviewsPanel(m) {
  const r = m.reviews;
  if (!r || typeof r !== 'object' || typeof r.n !== 'number' || r.n < MIN_REVIEWS || typeof r.overall !== 'number') return null;
  const code = String(m.code ?? '');
  const link = h('a', { attrs: { href: `https://nusmods.com/courses/${encodeURIComponent(code)}/reviews`, target: '_blank', rel: 'noopener' } },
    'Read them on NUSMods', icon('ext'));
  const latest = typeof r.latest === 'string' ? `, latest ${r.latest}` : '';
  const count = `${r.n} reviews`;
  return h('div', { class: 'rv-panel' },
    h('p', { class: 'rv-head' }, 'What students say'),
    h('p', { class: 'rv-big' },
      h('span', { class: 'rv-num' }, r.overall.toFixed(1)), h('span', { class: 'rv-of' }, h('span', { class: 'vh' }, ' out of '), h('span', { attrs: { 'aria-hidden': 'true' } }, '/'), '5'),
      ' ', h('span', { class: 'rv-word' }, overallWord(r.overall))),
    reviewMeter('Workload', r.workload, 'light', 'heavy'),
    reviewMeter('Difficulty', r.difficulty, 'easy', 'hard'),
    reviewMeter('Teaching', r.teaching, 'poor', 'great'),
    h('p', { class: 'rv-foot' }, `${count}${latest}. `, link));
}

/** @param {...(HTMLElement | null)} blocks */
function guideColumn(...blocks) {
  const shown = blocks.filter((b) => b !== null);
  return shown.length ? h('div', { class: 'guide' }, ...shown) : null;
}

let nextId = 0;

/**
 * @param {any} m
 * @param {Record<string, unknown>} filters
 * @param {Rendered['cards']} cards
 * @param {Pick<RenderContext, 'variantHref' | 'listed'>} ctx
 */
function card(m, filters, cards, ctx) {
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
    h('div', { class: 'unitcol' }, h('p', { class: 'units' }, `${m.credits ?? '?'} units`), shortlistToggle(code, ctx.listed(code))),
    h('p', { class: 'meta' },
      h('span', { class: 'dept' }, dept, fac ? h('span', { class: 'fac' }, ` · ${fac}`) : null),
      h('span', { class: 'sems' }, semesters.length ? `Taught in ${semesters.map(semLabel).join(', ')}` : 'No classes listed on NUSMods'),
      ...(exams.length
        ? exams.map((e) => h('span', { class: 'exam' }, h('span', { class: 'exl' }, e.label), ' ', h('span', { class: 'mono' }, e.when)))
        : [h('span', { class: 'exam' }, 'No final exam listed')])),
    variants.length ? h('p', { class: 'variants' }, 'Also as ', ...variants.flatMap((/** @type {string} */ v, /** @type {number} */ i) => [i ? ', ' : null, variantLink(v, code, ctx)])) : null,
    guideColumn(exchangeBlock(m, filters), reviewsPanel(m)),
    region);
}

/**
 * @param {any} data
 * @param {Record<string, unknown>} filters
 * @param {Rendered['hidden']} hidden
 * @param {HTMLElement | null} unpinned
 * @returns {{ box: HTMLElement, summary: string } | null}
 */
function hiddenBox(data, filters, hidden, unpinned) {
  const nm = data.noMatch;
  /** @type {string[]} */
  const hiddenPins = Array.isArray(data.hiddenPins) ? data.hiddenPins.map(String) : [];
  const notOffered = boxNotOffered(data.notOffered, nm);
  if (!hiddenPins.length && !notOffered.length) return null;
  /**
   * @param {string} code
   * @param {{ why: HTMLElement, title?: HTMLElement, stamp?: HTMLElement, actions?: HTMLElement }} parts
   */
  const item = (code, { why, title = h('span', { class: 'hc-title' }), stamp = h('p', { class: 'hc-stamp' }), actions = h('div', { class: 'hc-actions' }) }) => h('li', { class: 'hc', attrs: { 'data-code': code } },
    h('p', { class: 'hc-head' }, h('span', { class: 'hc-code' }, code), ' ', title),
    h('div', { class: 'hc-body' }, stamp, why, actions));
  const items = [
    ...hiddenPins.map((code) => {
      const parts = {
        why: h('p', { class: 'why' }, `${code} isn't shown with these settings.`),
        title: h('span', { class: 'hc-title' }), stamp: h('p', { class: 'hc-stamp' }), actions: h('div', { class: 'hc-actions' }),
      };
      hidden.set(code, parts);
      return item(code, parts);
    }),
    ...notOffered.map((code) => item(code, { why: h('p', { class: 'why' }, notOfferedLine(code)), stamp: h('p', { class: 'hc-stamp' }, hiddenStamp(NOT_OFFERED_STAMP)) })),
  ];
  const count = items.length;
  const typed = Math.max(count, typedCodes(String(data.query ?? '')).length);
  const exchange = filters.ng === true && typeof filters.study === 'string';
  const when = filters.sem === 1 || filters.sem === 2 ? semLabel(filters.sem) : 'both semesters';
  const intro = hiddenPins.length && exchange
    ? `You chose ${when} as a ${studyAdj(String(filters.study))} exchange student, so courses you can't take then are left out.`
    : null;
  const heading = count === typed
    ? (count === 1 ? "The code you typed isn't shown" : `The ${count} codes you typed aren't shown`)
    : `${count} of the ${typed} code${typed === 1 ? '' : 's'} you typed ${count === 1 ? "isn't" : "aren't"} shown`;
  const box = h('section', { class: 'hiddenbox', attrs: { 'aria-label': 'Codes you typed that aren\'t shown' } },
    h('h2', { class: 'hb-title' }, heading),
    intro ? h('p', { class: 'hb-intro' }, intro) : null,
    h('ul', { class: 'hidden-codes' }, ...items),
    unpinned,
    hiddenPins.length ? h('p', { class: 'gloss' }, "NG list: the NUS Registrar's list of courses offered to exchange (“non-graduating”) students.") : null);
  return { box, summary: `${heading}: ${[...hiddenPins, ...notOffered].join(', ')}.` };
}

/** @param {string} text */
export function hiddenStamp(text) {
  return h('span', { class: 'st st-closed' }, icon('closed'), h('span', null, text));
}

/**
 * @param {...(string | null | undefined | false)} parts
 * @returns {string}
 */
const sentence = (...parts) => parts.filter(Boolean).join(' ');

/**
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
 * @param {Targets} t
 * @param {any} data
 * @param {RenderContext} ctx
 * @returns {Rendered}
 */
export function showResults(t, data, ctx) {
  /** @type {Rendered} */
  const out = { cards: new Map(), hidden: new Map(), partial: null, announce: '' };
  setBusy(t, false);
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
  const hb = hiddenBox(data, filters, out.hidden, unpinnedEl);
  const box = hb?.box ?? null;
  const loose = box ? null : unpinnedEl;

  if (data.noMatch || results.length === 0) {
    setChildren(t.results);
    const partial = data.noMatch ? null : partialCode(data, filters);
    if (partial) {
      const line = h('p', { class: 'partial' }, partialCodeLine({ ...partial, otherHasResults: null }));
      const actions = h('div', { class: 'partial-actions' });
      out.partial = { line, actions, ...partial };
      out.announce = sentence(line.textContent, note);
      setStatus(t, [h('div', { class: 'empty' }, line, actions), noteLine]);
      return out;
    }
    /** @type {string[]} */
    const related = Array.isArray(data.noMatch?.related) ? data.noMatch.related.map(String).filter(Boolean) : [];
    const relatedLine = related.length
      ? h('p', { class: 'related' }, 'Related courses offered this year: ', ...related.flatMap((c, i) => [i ? ', ' : null, searchLink(c, ctx)]))
      : null;
    const exchange = filters.ng === true && typeof filters.study === 'string';
    const eligibility = !data.noMatch && !box && exchange && ctx.removableFilters === 0;
    const next = data.noMatch || eligibility ? null
      : ctx.removableFilters > 0 ? 'Remove a filter above to see more courses, or try other words.'
        : box ? null : 'Try other words for the topic, or fewer of them.';
    const when = filters.sem === 1 || filters.sem === 2 ? `in ${semLabel(filters.sem)}` : 'in either semester';
    const head = eligibility
      ? `No course that matches ${quoteUser(query)} is open to you ${when} as a ${studyAdj(String(filters.study))} exchange student.`
      : !data.noMatch && box ? `No results for ${quoteUser(query)}.` : noMatchSentence({ query, noMatch: data.noMatch });
    setStatus(t, [h('div', { class: 'empty' }, h('p', { class: 'empty-head' }, head), relatedLine, next ? h('p', { class: 'next' }, next) : null), box, loose, noteLine]);
    out.announce = sentence(head, related.length ? `Related courses offered this year: ${related.join(', ')}.` : '', next, hb?.summary, note);
    return out;
  }
  const typedQuery = ctx.query.trim() || query;
  let countLine;
  if (codesOnly(typedQuery)) {
    const { count, rest } = codesCount(typedQuery, results, Array.isArray(data.interpreted?.pin) ? data.interpreted.pin.map(String) : []);
    out.announce = sentence(`${count}${rest}.`, hb?.summary, note);
    countLine = h('p', { class: 'count' }, h('strong', null, count), rest);
  } else {
    const count = `${results.length} course${results.length === 1 ? '' : 's'}`;
    const typed = quoteUser(typedQuery);
    const verb = results.length === 1 ? 'matches' : 'match';
    out.announce = sentence(`${count} ${verb} ${typed}.`, hb?.summary, note);
    countLine = h('p', { class: 'count' }, h('strong', null, count), ` ${verb} `, h('span', { class: 'q' }, typed));
  }
  setStatus(t, [
    box,
    h('div', { class: 'countrow' },
      countLine,
      h('p', { class: 'tz' }, 'Exam times are Singapore time (UTC+8)')),
    loose,
    noteLine,
  ]);
  setChildren(t.results, ...results.map((/** @type {any} */ m) => card(m, filters, out.cards, ctx)));
  return out;
}

/**
 * @param {NonNullable<Rendered['partial']>} p
 * @param {boolean | null} otherHasResults
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
