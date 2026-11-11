// @ts-check
// A course's detail, inline below its card (Phase 5 5C, SC2), from
// /module/:code: the description, prerequisites and preclusions as NUS states
// them (spacing restored, the cohort-only case named, course codes linked to a
// search), the exam per semester in Singapore time, the workload, exchange
// availability per semester with every reason and its source, and the link to
// NUSMods for class times. DOM nodes only (F8). Laid out as direction D's
// sheet (5D): the course facts on the left, "can you take it" on the right
// (below them on a phone), and the Close button at the top. 5G adds the
// mockup's head: the code, title, units and department again, and, for a
// detail an "Also as" link opened, which entry it was opened from.
import { h, setChildren } from './dom.js';
import { noteText, reasonLine, sourceNote, stampText, statusText } from './explain.js';
import { codeSegments, examLines, prereqView, semLabel, workloadText } from './format.js';
import { icon } from './icons.js';
import { noteItem, searchLink, stamp } from './render.js';
import { STUDIES } from './state.js';

/**
 * @typedef {import('./explain.js').Source} Source
 * @typedef {import('./explain.js').ExchangeEntry} ExchangeEntry
 * @typedef {{
 *   filters: Record<string, unknown>, sources: Source[] | null,
 *   searchHref: (code: string) => string, onClose: () => void, from?: string,
 * }} DetailContext `filters` is the /search echo the card came from; `from` the
 *   entry whose "Also as" link opened this detail, if one did
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
 * NUS's text with each course code a search link.
 * @param {string} text
 * @param {DetailContext} ctx
 */
const nusText = (text, ctx) => h('p', { class: 'nus-text' },
  ...codeSegments(text).map((s) => ('code' in s ? searchLink(s.code, { searchHref: ctx.searchHref }) : s.text)));

/**
 * @param {unknown} raw /module's prerequisite
 * @param {boolean} cohortOnly /module's prereqCohortOnly
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
    h('p', { class: `exchange-status cell-status cs-${status}`, attrs: { 'data-status': status } }, icon(status), statusText(status)),
    reasons.length ? h('ul', { class: 'notes cell-notes' }, ...reasons.map((r) => h('li', null, reasonLine(r, e?.sem ?? 'any', sources)))) : null,
  ];
}

/**
 * One semester at the chosen year: its stamp ("Your semester" beside the one
 * chosen), then every note with its lead-in word and its source and date.
 * @param {ExchangeEntry | undefined} e
 * @param {number} sem
 * @param {boolean} mine the semester the student chose
 * @param {Source[] | null} sources
 */
function semBlock(e, sem, mine, sources) {
  const status = e?.status ?? 'closed';
  const reasons = Array.isArray(e?.reasons) ? e.reasons : [];
  return h('div', { class: 'exchange-sem-block semblock' },
    h('div', { class: 'row' }, stamp(status, stampText(status, sem, reasons.length)), mine ? h('span', { class: 'yours' }, 'Your semester') : null),
    reasons.length ? h('div', { class: 'notes-box' }, h('ul', { class: 'notes' },
      ...reasons.map((r) => noteItem(r, noteText(r, sem), h('span', { class: 'src' }, sourceNote(r.id, sources)))))) : null);
}

/** @type {Readonly<Record<string, string>>} */
const STUDY_AS = Object.freeze({ ug1: '1st-year', ug2: '2nd-year', ug3: '3rd-year', ug4: '4th-year (or later)', grad: 'graduate' });

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
  const check = h('div', { class: 'check-nus boxcheck' }, icon('check'), h('strong', null, 'Check with NUS before you register.'));
  if (study) {
    const chosen = ctx.filters.sem === 1 || ctx.filters.sem === 2 ? ctx.filters.sem : 0;
    return h('section', { class: 'detail-part avail' },
      h('div', null, h('h4', { class: 'big' }, 'Can you take it?'), h('p', { class: 'for' }, `As a ${STUDY_AS[study] ?? study} exchange student`)),
      ...[1, 2].map((sem) => semBlock(at(sem, study), sem, sem === chosen, sources)),
      check, sourcesLine);
  }
  const table = h('table', { class: 'exchange-table' },
    h('caption', null, 'Open to exchange students, by year of study at the home university'),
    h('thead', null, h('tr', null, h('th', { attrs: { scope: 'col' } }, 'Year of study'),
      h('th', { attrs: { scope: 'col' } }, semLabel(1)), h('th', { attrs: { scope: 'col' } }, semLabel(2)))),
    h('tbody', null, ...STUDIES.map((o) => h('tr', null, h('th', { attrs: { scope: 'row' } }, o.label),
      ...[1, 2].map((sem) => h('td', null, ...availability(at(sem, o.value), sources)))))));
  return h('section', { class: 'detail-part avail avail-all' }, h('h4', { class: 'big' }, 'Open to exchange students'), table, check, sourcesLine);
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
  const close = h('button', { class: 'btn detail-close', attrs: { type: 'button' } }, 'Close', h('span', { class: 'vh' }, ' details'), icon('x'));
  close.addEventListener('click', ctx.onClose);
  const code = typeof m.code === 'string' ? m.code : '';
  const kicker = ctx.from
    ? h('p', { class: 'kicker opened-from' }, 'Opened from ', h('span', { class: 'mono' }, ctx.from), ': another code for the same course')
    : h('p', { class: 'kicker' }, 'Course details');
  const dept = [m.department, m.faculty].filter((x, i, a) => typeof x === 'string' && x && a.indexOf(x) === i).join(', ');
  const units = typeof m.credits === 'number' ? `${m.credits} unit${m.credits === 1 ? '' : 's'}` : '';
  setChildren(region,
    h('div', { class: 'sheet-head' }, kicker, close),
    // The head repeats the entry's code and title (direction D), so the sheet reads on its own.
    // The code is in the heading (on its own line), so the heading's name is the code and title.
    h('div', { class: 'dhead' },
      h('h3', { class: 'dtitle' }, code ? h('span', { class: 'dcode' }, code) : null, code ? ' ' : null, typeof m.title === 'string' ? m.title : ''),
      units || dept ? h('p', { class: 'dmeta' }, [units, dept].filter(Boolean).join(' · ')) : null),
    // "Can you take it" comes first: beside the facts on a wide screen, above them on a narrow one.
    h('div', { class: 'sheet-grid' },
      h('div', { class: 'sheet-side' },
        exchangeSection(m.exchange, ctx),
        h('section', { class: 'detail-part nusmods' }, h('h4', { class: 'vh' }, 'Class times'),
          nusmods ? h('p', null, h('a', { class: 'nusmods-link', attrs: { href: nusmods, target: '_blank', rel: 'noopener' } }, 'Class times and timetable on NUSMods', icon('ext'))) : null,
          h('p', { class: 'nm-note' }, "Class times aren't shown here."))),
      h('div', { class: 'sheet-main' },
        section('Description', h('p', { class: 'desc' }, description || 'No description listed')),
        prerequisites(m.prerequisite, m.prereqCohortOnly === true, ctx),
        preclusions(m.preclusion, ctx),
        section('Final exam (Singapore time)', h('ul', { class: 'exam-list' }, ...examLines(Array.isArray(m.examDates) ? m.examDates : []).map((l) => h('li', null, l)))),
        section('Workload', h('p', { class: 'wl-total' }, workloadText(m.workload))))));
}
