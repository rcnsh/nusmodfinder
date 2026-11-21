// @ts-check
import { h, setChildren } from './dom.js';
import { noteText, reasonLine, sourceNote, stampText, statusText } from './explain.js';
import { cleanPrereq, codeSegments, examLines, prereqView, semLabel, workloadText } from './format.js';
import { icon } from './icons.js';
import { noteItem, searchLink, stamp } from './render.js';
import { STUDIES } from './state.js';

/**
 * @typedef {import('./explain.js').Source} Source
 * @typedef {import('./explain.js').ExchangeEntry} ExchangeEntry
 * @typedef {{
 *   filters: Record<string, unknown>, sources: Source[] | null,
 *   searchHref: (code: string) => string, onClose: () => void, from?: string,
 *   toggle?: (code: string) => HTMLElement,
 * }} DetailContext
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
  const again = h('button', { class: 'btn detail-retry', attrs: { type: 'button' } }, 'Try again');
  again.addEventListener('click', retry);
  setChildren(region, h('p', { class: 'detail-error' }, `The course details could not be loaded. ${sentence}`), again);
}

/**
 * @param {string} title
 * @param {...import('./dom.js').Child} body
 */
const section = (title, ...body) => h('section', { class: 'detail-part fact' }, h('h4', { class: 'lbl' }, title), ...body);

/**
 * @param {string} text
 * @param {DetailContext} ctx
 */
const nusText = (text, ctx) => h('p', { class: 'nus-text' },
  ...codeSegments(text).map((s) => ('code' in s ? searchLink(s.code, { searchHref: ctx.searchHref }) : s.text)));

/**
 * @param {unknown} raw
 * @param {boolean} cohortOnly
 * @param {DetailContext} ctx
 */
function prerequisites(raw, cohortOnly, ctx) {
  const view = prereqView(typeof raw === 'string' ? raw : null, cohortOnly);
  if (!view) return section('Prerequisites', h('p', null, 'No prerequisites listed'));
  if (view.kind === 'cohort') {
    return section('Prerequisites', h('p', { class: 'prereq-line' }, view.line),
      h('details', { class: 'as-stated' }, h('summary', null, 'As NUS states it'), nusText(view.text, ctx)));
  }
  return section('Prerequisites', h('p', { class: 'as-stated-label' }, 'As NUS states it:'), nusText(view.text, ctx));
}

/**
 * @param {unknown} raw
 * @param {DetailContext} ctx
 */
function preclusions(raw, ctx) {
  const text = cleanPrereq(typeof raw === 'string' ? raw : '');
  if (!text) return section('Preclusions', h('p', null, 'No preclusions listed'));
  return section('Preclusions', h('p', { class: 'as-stated-label' }, 'As NUS states it:'), nusText(text, ctx));
}

/**
 * @param {ExchangeEntry | undefined} e
 * @param {Source[] | null} sources
 */
function availability(e, sources) {
  const status = e?.status ?? 'closed';
  const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
  return [
    h('p', { class: `exchange-status cell-status cs-${status}`, attrs: { 'data-status': status } }, icon(status), statusText(status, reasons)),
    reasons.length ? h('ul', { class: 'notes cell-notes' }, ...reasons.map((r) => h('li', null, reasonLine(r, e?.sem ?? 'any', sources)))) : null,
  ];
}

/**
 * @param {ExchangeEntry | undefined} e
 * @param {number} sem
 * @param {boolean} mine
 * @param {Source[] | null} sources
 */
function semBlock(e, sem, mine, sources) {
  const status = e?.status ?? 'closed';
  const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
  return h('div', { class: 'exchange-sem-block semblock' },
    h('div', { class: 'row' }, stamp(status, stampText(status, sem, reasons)), mine ? h('span', { class: 'yours' }, 'Your semester') : null),
    reasons.length ? h('div', { class: 'notes-box' }, h('ul', { class: 'notes' },
      ...reasons.map((r) => noteItem(r, noteText(r, sem), h('span', { class: 'src' }, sourceNote(r.id, sources)))))) : null);
}

/** @type {Readonly<Record<string, string>>} */
const STUDY_AS = Object.freeze({ ug1: '1st-year', ug2: '2nd-year', ug3: '3rd-year', ug4: '4th-year (or later)', grad: 'graduate' });

/**
 * @param {unknown} raw
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
  const check = h('div', { class: 'check-nus boxcheck' }, icon('check'), h('strong', null, 'Check with NUS before you register.'));
  if (study) {
    const chosen = ctx.filters.sem === 1 || ctx.filters.sem === 2 ? ctx.filters.sem : 0;
    return h('section', { class: 'detail-part avail' },
      h('div', null, h('h4', { class: 'big' }, 'Can you take it?'), h('p', { class: 'for' }, `As a ${STUDY_AS[study] ?? study} exchange student`)),
      ...[1, 2].map((sem) => semBlock(at(sem, study), sem, sem === chosen, sources)),
      check, sourcesLine);
  }
  const table = h('table', { class: 'exchange-table' },
    h('caption', null, 'Open to exchange students, by year of study during the exchange'),
    h('thead', null, h('tr', null, h('th', { attrs: { scope: 'col' } }, 'Year of study'),
      h('th', { attrs: { scope: 'col' } }, semLabel(1)), h('th', { attrs: { scope: 'col' } }, semLabel(2)))),
    h('tbody', null, ...STUDIES.map((o) => h('tr', null, h('th', { attrs: { scope: 'row' } }, o.label),
      ...[1, 2].map((sem) => h('td', null, ...availability(at(sem, o.value), sources)))))));
  return h('details', { class: 'detail-part avail avail-all' }, h('summary', null, 'For exchange students: who may take it'), table, check, sourcesLine);
}

/**
 * @param {HTMLElement} region
 * @param {any} m
 * @param {DetailContext} ctx
 */
export function renderDetail(region, m, ctx) {
  const description = typeof m.description === 'string' && m.description.trim() ? m.description.trim() : '';
  const nusmods = typeof m.nusmodsUrl === 'string' && m.nusmodsUrl.startsWith('https://nusmods.com/') ? m.nusmodsUrl : null;
  const close = h('button', { class: 'btn detail-close', attrs: { type: 'button' } }, 'Close', h('span', { class: 'vh' }, ' details'), icon('x'));
  close.addEventListener('click', ctx.onClose);
  const code = typeof m.code === 'string' ? m.code : '';
  const kicker = ctx.from
    ? h('p', { class: 'kicker opened-from' }, 'Opened from ', h('span', { class: 'mono' }, ctx.from), ': another code for the same course')
    : h('p', { class: 'kicker' }, 'Course details');
  const dept = [m.department, m.faculty].filter((x, i, a) => typeof x === 'string' && x && a.indexOf(x) === i).join(', ');
  const units = typeof m.credits === 'number' ? `${m.credits} unit${m.credits === 1 ? '' : 's'}` : '';
  const exchangeMode = ctx.filters.ng === true && typeof ctx.filters.study === 'string' && ctx.filters.study !== '';
  setChildren(region,
    h('div', { class: 'sheet-head' }, kicker, h('div', { class: 'sheet-acts' }, code && ctx.toggle ? ctx.toggle(code) : null, close)),
    h('div', { class: 'dhead' },
      h('h3', { class: 'dtitle' }, code ? h('span', { class: 'dcode' }, code) : null, code ? ' ' : null, typeof m.title === 'string' ? m.title : ''),
      units || dept ? h('p', { class: 'dmeta' }, [units, dept].filter(Boolean).join(' · ')) : null),
    h('div', { class: 'sheet-grid' },
      h('div', { class: 'sheet-side' },
        exchangeMode ? exchangeSection(m.exchange, ctx) : null,
        h('section', { class: 'detail-part nusmods' }, h('h4', { class: 'vh' }, 'Class times'),
          nusmods ? h('p', null, h('a', { class: 'nusmods-link', attrs: { href: nusmods, target: '_blank', rel: 'noopener' } }, 'Class times and timetable on NUSMods', icon('ext'))) : null,
          h('p', { class: 'nm-note' }, "Class times aren't shown here."))),
      h('div', { class: 'sheet-main' },
        section('Description', h('p', { class: 'desc' }, description || 'No description listed')),
        prerequisites(m.prerequisite, m.prereqCohortOnly === true, ctx),
        preclusions(m.preclusion, ctx),
        section('Final exam (Singapore time)', h('ul', { class: 'exam-list' }, ...examLines(Array.isArray(m.examDates) ? m.examDates : []).map((l) => h('li', null, l)))),
        section('Workload', h('p', { class: 'wl-total' }, workloadText(m.workload))),
        exchangeMode ? null : exchangeSection(m.exchange, ctx))));
}
