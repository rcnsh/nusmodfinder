// @ts-check
// The print page: the export's document (export.js) drawn into #slPrint, a
// section the screen never shows (`display: none`, so screen readers skip it)
// and print shows alone when the page's print class is on (styles.css,
// `html.print-shortlist`). "Print or save as PDF" is the browser's own print to
// PDF of this section: no library, real text, its structure from the HTML. It
// holds the head, each semester's courses and totals, the closed entries, the
// forced page break, then the foot's form order, the lines for applicants, the
// CourseReg rules and the closing lines. DOM nodes only.
import { h, setChildren } from './dom.js';
import { SITE_NAME, SITE_URL } from './export.js';
import { stamp } from './render.js';

/** @typedef {import('./export.js').Doc} Doc */
/** @typedef {import('./export.js').Entry} Entry */

/** The facts each course prints, in this order, after its head. */
const FACTS = /** @type {const} */ ([
  'department', 'level', 'grading', 'counts', 'status', 'nus', 'exam', 'workload', 'estimate', 'flags', 'prerequisite', 'preclusion', 'nusmods',
]);

/** @param {string} text */
const lines = (text) => text.split('\n').filter(Boolean);
/** @param {string[]} items */
const list = (items) => h('ul', { class: 'pp-list' }, ...items.map((t) => h('li', null, t)));

/**
 * The form cell: "Application form, Sem 1" over its number.
 * @param {string} text
 */
function formCell(text) {
  const m = /^(Application form, Sem \d): (\d+)(.*)$/.exec(text);
  if (!m) return h('p', { class: 'form' }, text);
  return h('p', { class: 'form' }, m[1], h('b', null, m[2]), m[3] ? h('span', { class: 'src' }, m[3].replace(/^[.,]\s*/, '')) : null);
}

/**
 * One course's block.
 * @param {Entry} e @param {Doc} doc
 */
function course(e, doc) {
  const c = e.cells;
  const label = (/** @type {string} */ key) => doc.columns.find((x) => x.key === key)?.label ?? key;
  /** @type {import('./dom.js').Child[]} */
  const facts = [];
  for (const key of FACTS) {
    /** @type {import('./dom.js').Child} */
    let dd = null;
    let dt = label(key);
    if (key === 'department') {
      // Department, faculty and level on one line, to keep a course's block short on paper.
      const v = [[c.department, c.faculty].filter(Boolean).join(', '), c.level].filter(Boolean).join(' · ');
      if (v) { dt = c.level ? 'Department, level' : 'Department, faculty'; dd = v; }
    } else if (key === 'level') {
      continue;
    } else if (key === 'status') {
      if (c.status) {
        dt = e.sem ? `Exchange status, ${c.sem}` : 'Exchange status';
        dd = h('div', null,
          e.sem && e.status ? stamp(e.status, c.status) : c.status,
          c.notes ? list(lines(c.notes)) : null);
      }
    } else if (key === 'nus' || key === 'flags') {
      if (c[key]) dd = list(lines(c[key]));
    } else if (key === 'nusmods') {
      continue;
    } else if (c[key]) dd = c[key];
    if (dd !== null) facts.push(h('dt', null, dt), h('dd', null, dd));
  }
  const where = [`${c.list} ${c.rank}`, c.sem, c.units ? `${c.units} units` : ''].filter(Boolean).join(' · ');
  return h('article', { class: 'pp-course', attrs: { 'data-code': e.code } },
    h('div', { class: 'pp-ch' },
      h('h4', null, h('span', { class: 'code' }, e.code), ' ', h('span', { class: 'title' }, c.title)),
      c.form ? formCell(c.form) : null,
      // The NUSMods link sits with the head, printed as text, so each block keeps one line less.
      h('p', { class: 'src' }, where, c.nusmods ? ' · ' : null, c.nusmods ? h('a', { attrs: { href: c.nusmods } }, c.nusmods) : null)),
    h('dl', { class: 'pp-facts' }, ...facts),
    c.description ? h('p', { class: 'pp-lbl' }, label('description')) : null,
    c.description ? h('p', { class: 'pp-desc' }, c.description) : null);
}

/**
 * The print page, built into `root` (#slPrint) and rebuilt on each update.
 * @param {HTMLElement} root
 */
export function createPrintView(root) {
  return {
    /** @param {Doc} doc */
    update(doc) {
      const head = Object.fromEntries(doc.head.map((x) => [x.key, x.value]));
      const extra = doc.head.filter((x) => !['title', 'study', 'made', 'link', 'later', 'site'].includes(x.key));
      /** @type {import('./dom.js').Child[]} */
      const body = [
        h('header', { class: 'pp-head' },
          h('h1', { attrs: { id: 'ppTitle' } }, doc.title),
          h('p', null, head.study ? `Year of study during the exchange: ${head.study} · Made on ${head.made} with ${SITE_NAME}` : `Made on ${head.made} with ${SITE_NAME}`),
          h('p', { class: 'pp-link' }, head.link),
          ...extra.map((x) => h('p', null, `${x.label}: ${x.value}`)),
          h('p', { class: 'src' }, head.later)),
      ];
      for (const s of doc.sections) {
        body.push(h('section', { class: 'pp-sec', attrs: { 'aria-labelledby': `pp-${s.id}` } },
          h('h2', { attrs: { id: `pp-${s.id}` } }, s.heading),
          ...s.groups.flatMap((g) => [h('h3', null, g.heading), ...g.entries.map((e) => course(e, doc))]),
          s.totals.length ? h('h3', null, `${s.heading} totals`) : null,
          s.totals.length ? list(s.totals) : null));
      }
      const form = doc.form;
      const courseReg = doc.courseReg;
      body.push(
        form ? h('section', { class: 'pp-form', attrs: { 'aria-labelledby': 'pp-form' } },
          h('h2', { attrs: { id: 'pp-form' } }, form.heading),
          h('p', { class: 'src' }, form.intro),
          ...form.tables.flatMap((t) => [
            h('table', { class: 'sl-ftab' },
              h('caption', null, t.caption),
              h('thead', null, h('tr', null, ...['No.', 'Course', 'Units', 'On your list'].map((x) => h('th', { attrs: { scope: 'col' } }, x)))),
              h('tbody', null, ...t.rows.map((r) => h('tr', null,
                h('td', { class: `mono${r.mark ? ' mark' : ''}` }, r.number),
                h('th', { class: 'mono', attrs: { scope: 'row' } }, r.code),
                h('td', { class: 'mono' }, r.units),
                h('td', r.mark ? { class: 'mark' } : null, `${r.list[0].toUpperCase()}${r.list.slice(1)}${r.note ? `${r.mark ? ':' : '.'} ${r.note}` : ''}`))))),
            t.note ? h('p', { class: 'src' }, t.note) : null,
          ]),
          list(form.applicants)) : null,
        h('section', { class: 'pp-foot', attrs: courseReg ? { 'aria-labelledby': 'pp-cr' } : { 'aria-label': 'Notes' } },
          courseReg ? h('h2', { class: 'pp-lbl', attrs: { id: 'pp-cr' } }, courseReg.heading) : null,
          courseReg ? list([...courseReg.rules, courseReg.page]) : null,
          h('ul', { class: 'pp-list pp-closing' }, ...doc.closing.map((x) => h('li', null,
            x.key === 'unofficial' ? h('b', null, x.value) : x.value,
            x.key === 'unofficial' ? ` ${SITE_NAME}, ${SITE_URL.replace(/^https:\/\//, '')}` : null)))));
      setChildren(root, h('div', { class: 'pp' }, ...body));
    },
  };
}
