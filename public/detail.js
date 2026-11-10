// @ts-check
// A course's detail, inline below its card (Phase 5 5C, SC2), from
// /module/:code: the description, prerequisites and preclusions as NUS states
// them (spacing restored, the cohort-only case named, course codes linked to a
// search), the exam per semester in Singapore time, the workload, exchange
// availability per semester with every reason and its source, and the link to
// NUSMods for class times. DOM nodes only (F8); classes name structure, 5D
// styles them.
import { h, setChildren } from './dom.js';
import { reasonLine, statusText } from './explain.js';
import { codeSegments, examLines, prereqView, semLabel, workloadText } from './format.js';
import { searchLink } from './render.js';
import { STUDIES } from './state.js';

/**
 * @typedef {import('./explain.js').Source} Source
 * @typedef {import('./explain.js').ExchangeEntry} ExchangeEntry
 * @typedef {{
 *   filters: Record<string, unknown>, sources: Source[] | null,
 *   searchHref: (code: string) => string, onClose: () => void,
 * }} DetailContext `filters` is the /search echo the card came from
 */

/** @param {HTMLElement} region */
export function detailLoading(region) {
  setChildren(region, h('p', { class: 'detail-loading' }, 'Loading the course details…'));
}

/**
 * @param {HTMLElement} region
 * @param {string} sentence
 * @param {() => void} retry
 */
export function detailError(region, sentence, retry) {
  const again = h('button', { class: 'detail-retry', attrs: { type: 'button' } }, 'Try again');
  again.addEventListener('click', retry);
  setChildren(region, h('p', { class: 'detail-error' }, `The course details could not be loaded. ${sentence}`), again);
}

/**
 * @param {string} title
 * @param {...import('./dom.js').Child} body
 */
const section = (title, ...body) => h('section', { class: 'detail-part' }, h('h3', null, title), ...body);

/**
 * NUS's text with each course code a search link.
 * @param {string} text
 * @param {DetailContext} ctx
 */
const nusText = (text, ctx) => h('p', { class: 'nus-text' },
  ...codeSegments(text).map((s) => ('code' in s ? searchLink(s.code, { searchHref: ctx.searchHref }) : s.text)));

/**
 * @param {unknown} raw /module's prerequisite
 * @param {DetailContext} ctx
 */
function prerequisites(raw, ctx) {
  const view = prereqView(typeof raw === 'string' ? raw : null);
  if (!view) return section('Prerequisites', h('p', null, 'No prerequisites listed'));
  if (view.kind === 'cohort') {
    return section('Prerequisites', h('p', { class: 'prereq-line' }, view.line),
      h('details', { class: 'as-stated' }, h('summary', null, 'As NUS states it'), nusText(view.text, ctx)));
  }
  return section('Prerequisites', h('p', { class: 'as-stated-label' }, 'As NUS states it:'), nusText(view.text, ctx));
}

/**
 * @param {unknown} raw /module's preclusion
 * @param {DetailContext} ctx
 */
function preclusions(raw, ctx) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!text) return section('Preclusions', h('p', null, 'No preclusions listed'));
  return section('Preclusions', h('p', { class: 'as-stated-label' }, 'As NUS states it:'), nusText(text, ctx));
}

/**
 * One semester's availability: the status in words and every reason with its
 * source and date.
 * @param {ExchangeEntry | undefined} e
 * @param {Source[] | null} sources
 */
function availability(e, sources) {
  const status = e?.status ?? 'closed';
  const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
  return [
    h('p', { class: 'exchange-status', attrs: { 'data-status': status } }, statusText(status)),
    reasons.length ? h('ul', { class: 'notes' }, ...reasons.map((r) => h('li', null, reasonLine(r, e?.sem ?? 'any', sources)))) : null,
  ];
}

/**
 * Exchange availability: in exchange mode Sem 1 and Sem 2 at the chosen year;
 * outside it, a table for every year.
 * @param {unknown} raw /module's `exchange`
 * @param {DetailContext} ctx
 */
function exchangeSection(raw, ctx) {
  const entries = /** @type {ExchangeEntry[]} */ (Array.isArray(raw) ? raw : []);
  /** @param {number} sem @param {string} study */
  const at = (sem, study) => entries.find((e) => e.sem === sem && e.study === study);
  const study = ctx.filters.ng === true && typeof ctx.filters.study === 'string' ? ctx.filters.study : '';
  const sources = ctx.sources;
  const sourceList = (sources ?? []).filter((s) => typeof s?.name === 'string');
  const sourcesLine = h('p', { class: 'sources-line' }, 'Sources: ',
    ...(sourceList.length
      ? sourceList.flatMap((s, i) => [
        i ? '; ' : null,
        /^https:\/\//i.test(String(s.url)) ? h('a', { attrs: { href: String(s.url), target: '_blank', rel: 'noopener' } }, String(s.name)) : String(s.name),
        typeof s.updatedAsAt === 'string' ? ` (updated ${s.updatedAsAt})` : null,
      ])
      : ['NG list; NG restrictions']),
    '.');
  const check = h('p', { class: 'check-nus' }, 'Check with NUS before you register.');
  if (study) {
    const label = STUDIES.find((o) => o.value === study)?.label ?? study;
    return section(`Open to exchange students (${label})`,
      ...[1, 2].map((sem) => h('div', { class: 'exchange-sem-block' }, h('h4', null, semLabel(sem)), ...availability(at(sem, study), sources))),
      check, sourcesLine);
  }
  const table = h('table', { class: 'exchange-table' },
    h('caption', null, 'Open to exchange students, by year of study at the home university'),
    h('thead', null, h('tr', null, h('th', { attrs: { scope: 'col' } }, 'Year of study'),
      h('th', { attrs: { scope: 'col' } }, semLabel(1)), h('th', { attrs: { scope: 'col' } }, semLabel(2)))),
    h('tbody', null, ...STUDIES.map((o) => h('tr', null, h('th', { attrs: { scope: 'row' } }, o.label),
      ...[1, 2].map((sem) => h('td', null, ...availability(at(sem, o.value), sources)))))));
  return section('Open to exchange students', table, check, sourcesLine);
}

/**
 * Fills a card's detail region from a /module/:code body.
 * @param {HTMLElement} region
 * @param {any} m
 * @param {DetailContext} ctx
 */
export function renderDetail(region, m, ctx) {
  const description = typeof m.description === 'string' && m.description.trim() ? m.description.trim() : '';
  const nusmods = typeof m.nusmodsUrl === 'string' && m.nusmodsUrl.startsWith('https://nusmods.com/') ? m.nusmodsUrl : null;
  const close = h('button', { class: 'detail-close', attrs: { type: 'button' } }, 'Close details');
  close.addEventListener('click', ctx.onClose);
  setChildren(region,
    section('Description', h('p', null, description || 'No description listed')),
    prerequisites(m.prerequisite, ctx),
    preclusions(m.preclusion, ctx),
    section('Final exam (Singapore time)', h('ul', { class: 'exam-list' }, ...examLines(Array.isArray(m.examDates) ? m.examDates : []).map((l) => h('li', null, l)))),
    section('Workload', h('p', null, workloadText(m.workload))),
    exchangeSection(m.exchange, ctx),
    section('Class times',
      nusmods ? h('p', null, h('a', { class: 'nusmods-link', attrs: { href: nusmods, target: '_blank', rel: 'noopener' } }, 'Class times and timetable on NUSMods')) : null,
      h('p', null, "Class times aren't shown here.")),
    close);
}
