// @ts-check
// The shortlist view (Phase 6 6C; docs/plans/phase6.md 6C "The view"), built
// to the approved mockup (docs/design/phase6-shortlist/a/): its heading and
// actions, the export question, the invitation question, "Primary picks" and
// "Backups" in rank order, each row worked out at its own semester
// (shortlist.js), then each semester's totals, NUS's form order, the lines
// for applicants, the CourseReg box and "Forget this list on this device".
//
// Updated in place, never rebuilt: each row is an element kept by its code,
// and its controls (Move up, Move down, Make backup or Make primary, Remove)
// are made once, when the entry first appears, so a row arriving, a total
// changing or a neighbour moving never takes focus from a control. Moving a
// row moves its neighbours, never the row that holds focus (moving that
// element drops focus to <body> in Chromium and WebKit). Only the semester
// buttons wait for the row, and a pressed one keeps its element. DOM nodes
// only (F8). app.js owns the list, the history and the live region; this
// module draws a model and reports what was pressed.
import { h, setChildren } from './dom.js';
import { noteText, stampText, studyAdj } from './explain.js';
import { cleanPrereq, examLine, examLines, semLabel, workloadText } from './format.js';
import { icon } from './icons.js';
import { noteItem, stamp } from './render.js';
import {
  APPLICANT_LINES, COURSEREG_BOX, FORM_LINES, GRO_POPULAR, TOTAL_LINES,
} from './shortlist.js';
import { STUDIES } from './state.js';

/** @typedef {import('./shortlist.js').Result} Result */
/** @typedef {import('./shortlist.js').Worked} Worked */
/** @typedef {import('./shortlist.js').Answer} Answer */
/**
 * What the view draws.
 * @typedef {{
 *   result: Result, answers: Map<string, Answer>, study: string, sem: string,
 *   lines: string[], removed: string, linkField: string, said: string,
 *   ask: { year: boolean, entries: string[] }, faculties: ('biz' | 'law')[], inv: string[],
 *   listDate: string, exportLine: string,
 * }} Model
 *   `lines`: the sentences under the heading (the settings sentence, the year line, values a link dropped);
 *   `removed`: the code a Remove in the view took out, while its Undo stands ('' for none);
 *   `linkField`: Copy link's fallback, the link to copy by hand ('' hides it);
 *   `said`: the line beside the actions ("Link copied");
 *   `ask`: the parts of the export question shown (6C asks it; app.js keeps them while the view is open);
 *   `faculties`: Business and Law, when the list holds a course of theirs;
 *   `exportLine`: the export's progress after a press before every row is in (6D: "Loading 7 of 12
 *   courses", then "Ready: press again to download"), '' otherwise
 * @typedef {{
 *   close: () => void, copy: () => void, exportPress: (kind: 'csv' | 'print') => void,
 *   invite: (which: 'biz' | 'law', on: boolean) => void,
 *   askStudy: (study: string) => void, askSem: (sem: string) => void, askEntry: (code: string, sem: '1' | '2') => void,
 *   move: (code: string, dir: -1 | 1, button: HTMLButtonElement) => void,
 *   make: (code: string, button: HTMLButtonElement) => void,
 *   sem: (code: string, to: '1' | '2', button: HTMLButtonElement) => void,
 *   remove: (code: string) => void, undo: () => void, retry: (code: string) => void, forget: () => void,
 * }} Handlers
 * @typedef {{
 *   li: HTMLLIElement, rank: HTMLElement, sem: HTMLElement, form: HTMLElement, formNote: HTMLElement,
 *   title: HTMLElement, facts: HTMLElement, guide: HTMLElement, flags: HTMLElement,
 *   up: HTMLButtonElement, down: HTMLButtonElement, make: HTMLButtonElement, remove: HTMLButtonElement,
 *   semSlot: HTMLElement, retrySlot: HTMLElement,
 * }} Row
 */

/** Business and Law, as the invitation question and the rows name them. */
const SCHOOL = Object.freeze({ biz: 'NUS Business School', law: 'NUS Law' });
/** What a count line leads with, by standing. */
const NUMBER_WORDS = ['no', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/**
 * "Two questions before your download": what pressing Download CSV or Print says while the question is open.
 * @param {number} n
 */
export const askSentence = (n) => `${n <= 10 ? NUMBER_WORDS[n] : n} question${n === 1 ? '' : 's'} before your download`;

/** A row's button: its visible text, named with the text first ("Move up, CS3244"). @param {string} text @param {string} code @param {string} act */
function rowButton(text, code, act) {
  return h('button', { class: 'btn', attrs: { type: 'button', 'aria-label': `${text}, ${code}`, 'data-act': act, 'data-code': code } }, text);
}
/** @param {HTMLButtonElement} b @param {string} text @param {string} code */
function relabel(b, text, code) {
  if (b.textContent !== text) b.textContent = text;
  const name = `${text}, ${code}`;
  if (b.getAttribute('aria-label') !== name) b.setAttribute('aria-label', name);
}
/** @param {Element} el @param {boolean} on */
const ariaDisabled = (el, on) => (on ? el.setAttribute('aria-disabled', 'true') : el.removeAttribute('aria-disabled'));

/** 'Not on NUS's …' → 'not on NUS's …', for after "Not counted:". @param {string} s */
const lower = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
/** @param {string} s */
const stop = (s) => (/[.!?”)]$/.test(s) ? s : `${s}.`);

/**
 * The exchange entry at a semester and study level, from a course's `exchange`.
 * @param {any} c @param {number} sem @param {string} study
 */
const exchangeAt = (c, sem, study) => (Array.isArray(c?.exchange) ? c.exchange : []).find((/** @type {any} */ x) => String(x.sem) === String(sem) && x.study === study);

/**
 * A row with no semester: the notes its two stamps count, each said once. A
 * note both semesters carry is said as it is; one only a single semester
 * carries is marked "(Sem 2 only)", unless its text already names that
 * semester. A closed semester's reasons are its stamp's, not notes.
 * @param {any} c @param {string} study
 */
function bothSemNotes(c, study) {
  const per = [1, 2].map((s) => {
    const x = exchangeAt(c, s, study);
    const reasons = x && x.status !== 'closed' && Array.isArray(x.reasons) ? x.reasons : [];
    return { s, notes: reasons.map((/** @type {any} */ r) => ({ r, text: noteText(r, s) })) };
  });
  /** @type {Set<string>} */
  const said = new Set();
  /** @type {import('./dom.js').Child[]} */
  const out = [];
  for (const { s, notes } of per) {
    const other = per.find((p) => p.s !== s);
    for (const { r, text } of notes) {
      if (said.has(text)) continue;
      said.add(text);
      const shared = other?.notes.some((/** @type {{ text: string }} */ n) => n.text === text);
      out.push(noteItem(r, shared || text.includes(semLabel(s)) ? text : `${text.replace(/\.$/, '')} (${semLabel(s)} only).`));
    }
  }
  return out;
}

/**
 * The view: built once into `root` (#slView), then updated with update().
 * @param {HTMLElement} root
 * @param {Handlers} on
 */
export function createShortlistView(root, on) {
  const title = h('h2', { class: 'sl-title', attrs: { id: 'slTitle', tabindex: '-1' } }, 'Your shortlist');
  const sub = h('p', { class: 'sl-sub' });
  const sentence = h('div', { class: 'sl-sentence' });
  const close = h('button', { class: 'btn sl-close', attrs: { type: 'button' } }, 'Back to results');
  close.addEventListener('click', on.close);

  const removedText = h('span');
  const undo = h('button', { class: 'linkbtn', attrs: { type: 'button' } }, 'Undo');
  undo.addEventListener('click', on.undo);
  const removed = h('p', { class: 'sl-removed' }, removedText, undo);
  removed.hidden = true;

  // The actions come first, so a long list never puts them 200 Tab stops away.
  const copy = h('button', { class: 'btn', attrs: { type: 'button' } }, 'Copy link');
  copy.addEventListener('click', on.copy);
  // The exports (6D). Pressed before every row is in, a button keeps its name, and the line it
  // points to says how far the rows are, then that a second press will do it.
  const statusId = 'slExportStatus';
  const csv = h('button', { class: 'btn', attrs: { type: 'button', 'aria-describedby': statusId, 'data-export': 'csv' } }, 'Download CSV');
  const print = h('button', { class: 'btn', attrs: { type: 'button', 'aria-describedby': statusId, 'data-export': 'print' } }, 'Print or save as PDF');
  for (const b of [csv, print]) b.addEventListener('click', () => on.exportPress(/** @type {'csv' | 'print'} */ (b.dataset.export)));
  const hint = h('p', { class: 'hint' }, 'On a phone: Share, then Print, then pinch out the preview to save the PDF. Excel shows one column? Use Data › From Text/CSV.');
  const exportStatus = h('p', { class: 'sl-said', attrs: { id: statusId } });
  const said = h('p', { class: 'sl-said' });
  const fieldInput = h('input', { class: 'field', attrs: { id: 'slLinkField', type: 'text', readonly: '', spellcheck: 'false', autocomplete: 'off' } });
  const field = h('div', { class: 'sl-linkfield' },
    h('label', { attrs: { for: 'slLinkField' } }, 'Shortlist link'),
    fieldInput,
    h('p', { class: 'sl-src' }, 'The browser didn\'t let the page copy it: select the link and copy it yourself.'));
  field.hidden = true;
  const actions = h('div', { class: 'sl-actions' }, h('div', { class: 'btns' }, copy, csv, print), hint, exportStatus, said, field);

  // The export question (6C): parts kept while the view is open, so answering one never
  // removes the control that has focus.
  const askTitle = h('h3', { attrs: { id: 'slAskTitle', tabindex: '-1' } }, 'Before you download or print');
  const askParts = h('div', { class: 'sl-ask-parts' });
  const askCsv = h('button', { class: 'btn', attrs: { type: 'button', 'aria-describedby': statusId } }, 'Download CSV');
  const askPrint = h('button', { class: 'btn', attrs: { type: 'button', 'aria-describedby': statusId } }, 'Print or save as PDF');
  askCsv.addEventListener('click', () => on.exportPress('csv'));
  askPrint.addEventListener('click', () => on.exportPress('print'));
  const ask = h('section', { class: 'sl-ask', attrs: { id: 'slAsk', 'aria-labelledby': 'slAskTitle' } },
    askTitle,
    h('p', { class: 'hint' }, 'Your answers apply at once. The download or print starts only from these buttons.'),
    askParts,
    h('div', { class: 'btns' }, askCsv, askPrint));
  ask.hidden = true;
  /** @type {Map<string, HTMLFieldSetElement>} */
  const askSets = new Map();

  // The invitation question, one per faculty the list holds (the mockup's call).
  /** @type {Record<'biz' | 'law', { set: HTMLFieldSetElement, box: HTMLInputElement }>} */
  const inv = /** @type {any} */ ({});
  for (const which of /** @type {('biz' | 'law')[]} */ (['biz', 'law'])) {
    const id = which === 'biz' ? 'slInvBiz' : 'slInvLaw';
    const box = h('input', { attrs: { type: 'checkbox', id } });
    box.addEventListener('change', () => on.invite(which, box.checked));
    const question = which === 'biz'
      ? 'Did NUS Business School invite you to apply for its exchange programme (an invitation during the nomination period)?'
      : 'Did NUS Law invite you to apply for its exchange programme (an invitation during the nomination period)?';
    const set = h('fieldset', { class: 'sl-inv' },
      h('legend', null, question),
      h('label', { class: 'checkline', attrs: { for: id } }, box, ' ', h('span', null, `Yes, ${SCHOOL[which]} invited me`)),
      h('p', { class: 'hint' }, `${which === 'biz' ? 'Business' : 'Law'} courses count only if it did. If you're not sure, ask your exchange office.`));
    set.hidden = true;
    inv[which] = { set, box };
  }

  const pickCount = h('span', { class: 'n' });
  const altCount = h('span', { class: 'n' });
  const pickHead = h('h3', { class: 'lbl', attrs: { id: 'slPicks', tabindex: '-1' } }, 'Primary picks ', pickCount);
  const altHead = h('h3', { class: 'lbl', attrs: { id: 'slAlts', tabindex: '-1' } }, 'Backups ', altCount);
  // role="list": WebKit drops the list role under list-style: none.
  const pickList = h('ol', { class: 'sl-list', attrs: { id: 'slPickList', role: 'list' } });
  const altList = h('ol', { class: 'sl-list', attrs: { id: 'slAltList', role: 'list' } });
  const pickNone = h('p', { class: 'sl-none' }, 'No primary picks yet. Press Shortlist on a course in the results to add it.');
  const altNone = h('p', { class: 'sl-none' }, 'No backups yet. "Make backup" on a pick moves it here.');

  const totalsBody = h('div');
  const totals = h('section', { class: 'sl-sec', attrs: { 'aria-labelledby': 'slTot', id: 'slTotals' } }, h('h3', { class: 'lbl', attrs: { id: 'slTot' } }, 'Totals'), totalsBody);
  const formBody = h('div');
  const form = h('section', { class: 'sl-sec sl-formsec', attrs: { 'aria-labelledby': 'slFormTitle', id: 'slForm' } },
    h('h3', { class: 'lbl', attrs: { id: 'slFormTitle' } }, 'NUS\'s application form order, for applicants'), formBody);
  const lines = (/** @type {string[]} */ ls) => h('ul', { class: 'sl-lines' }, ...ls.map((t) => h('li', null, stop(t))));
  const box = h('section', { class: 'sl-box', attrs: { 'aria-labelledby': 'slCR' } },
    h('h3', { attrs: { id: 'slCR' } }, 'Already admitted? NUS\'s rules for CourseReg'),
    lines([...COURSEREG_BOX.rules]),
    h('p', { class: 'own' }, COURSEREG_BOX.page));
  const forget = h('button', { class: 'linkbtn', attrs: { type: 'button' } }, 'Forget this list on this device');
  forget.addEventListener('click', on.forget);
  const closing = h('div', { class: 'sl-close-lines' },
    h('p', null, 'Class times and corequisites aren\'t checked here: see each course on NUSMods.'),
    h('p', null, 'NUS posts each course\'s full syllabus on Canvas when the semester starts; the text here is NUS\'s course description (the Registrar\'s NG course list).'),
    h('p', null, 'For courses that have prerequisites, NUS asks for the syllabi of the courses you have completed or are taking (NUS\'s brochure).'),
    h('p', { class: 'sl-forget' }, forget));

  setChildren(root,
    h('div', { class: 'sl-head' }, h('div', null, title, sub, sentence), close),
    removed, actions, ask, inv.biz.set, inv.law.set,
    h('section', { class: 'sl-sec', attrs: { 'aria-labelledby': 'slPicks' } }, pickHead, pickList, pickNone),
    h('section', { class: 'sl-sec', attrs: { 'aria-labelledby': 'slAlts' } }, altHead, altList, altNone),
    totals, form, box, closing);

  /** @type {Map<string, Row>} */
  const rows = new Map();

  // Every row control, by delegation: each carries its action and its code.
  root.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button[data-act]') : null;
    if (!(b instanceof HTMLButtonElement) || !root.contains(b)) return;
    const code = b.dataset.code ?? '';
    switch (b.dataset.act) {
      case 'up': on.move(code, -1, b); break;
      case 'down': on.move(code, 1, b); break;
      case 'make': on.make(code, b); break;
      case 'sem': if (b.dataset.to === '1' || b.dataset.to === '2') on.sem(code, b.dataset.to, b); break;
      case 'remove': on.remove(code); break;
      case 'retry': on.retry(code); break;
    }
  });

  /** @param {string} code @returns {Row} */
  function makeRow(code) {
    const up = rowButton('Move up', code, 'up');
    const down = rowButton('Move down', code, 'down');
    const make = rowButton('Make backup', code, 'make');
    const remove = rowButton('Remove', code, 'remove');
    const r = {
      li: h('li', { class: 'sl-entry', attrs: { 'data-code': code } }),
      rank: h('p', { class: 'sl-rank' }), sem: h('p', { class: 'sl-sem' }), form: h('p', { class: 'sl-form' }), formNote: h('p', { class: 'sl-form mark' }),
      title: h('span', { class: 'title' }), facts: h('div', { class: 'sl-facts' }), guide: h('div', { class: 'sl-guide' }), flags: h('div', { class: 'sl-flags' }),
      up, down, make, remove, semSlot: h('span'), retrySlot: h('span'),
    };
    r.li.append(
      h('div', { class: 'sl-side' }, r.rank, r.sem, r.form, r.formNote),
      h('h4', { class: 'sl-ehead' }, h('span', { class: 'code' }, code), ' ', r.title),
      r.facts, r.guide, r.flags,
      h('div', { class: 'sl-acts' }, up, down, make, r.semSlot, remove, r.retrySlot));
    rows.set(code, r);
    return r;
  }

  /**
   * Puts `ol`'s rows in `codes`' order. The row holding focus stays where it
   * is and its neighbours move around it (6C: moving the focused element
   * drops focus); a row coming from the other list is appended.
   * @param {HTMLOListElement} ol @param {string[]} codes
   */
  function place(ol, codes) {
    const want = codes.map((c) => /** @type {Row} */ (rows.get(c)).li);
    for (const li of [...ol.children]) if (!want.includes(/** @type {HTMLLIElement} */ (li))) li.remove();
    if (want.length === ol.children.length && want.every((li, i) => ol.children[i] === li)) return;
    const active = document.activeElement;
    const fixed = want.find((li) => li.parentElement === ol && active && li.contains(active));
    if (!fixed) { for (const li of want) ol.append(li); return; }
    const i = want.indexOf(fixed);
    // Each one before the fixed row, in order, then each one after it: only the neighbours move.
    for (let k = 0; k < i; k += 1) ol.insertBefore(want[k], fixed);
    let ref = fixed;
    for (let k = i + 1; k < want.length; k += 1) {
      ref.after(want[k]);
      ref = want[k];
    }
  }

  /**
   * The semester buttons (6C): drawn once the row is in, for the semesters the
   * course is taught in or, in exchange mode, on NUS's list for. A pressed one
   * keeps its element and changes its text; on an untagged row the pressed one
   * stays and the other goes; a course taught in only that semester leaves it
   * `aria-disabled`, "Sem 2 chosen".
   * @param {Row} r @param {Worked} w @param {number[]} choices @param {boolean} loaded
   */
  function semButtons(r, w, choices, loaded) {
    if (!loaded) return;
    const have = /** @type {HTMLButtonElement[]} */ ([...r.semSlot.children]);
    /** @type {{ to: string, text: string }[]} */
    let want;
    if (!w.sem) want = choices.map((s) => ({ to: String(s), text: semLabel(s) }));
    else {
      const others = choices.filter((s) => String(s) !== w.sem);
      want = others.length ? [{ to: String(others[0]), text: `Move to ${semLabel(others[0])}` }]
        : have.length ? [{ to: '', text: `${semLabel(w.sem)} chosen` }] : [];
    }
    const active = document.activeElement;
    // The focused button is reused first, so focus stays on it.
    const order = [...have.filter((b) => b === active), ...have.filter((b) => b !== active)];
    const used = want.map((x, i) => {
      const b = order[i] ?? rowButton(x.text, w.code, 'sem');
      relabel(b, x.text, w.code);
      if (x.to) b.dataset.to = x.to; else delete b.dataset.to;
      ariaDisabled(b, !x.to);
      return b;
    });
    for (const b of have) if (!used.includes(b)) b.remove();
    // In the wanted order, moving only buttons that don't hold focus.
    used.forEach((b, i) => {
      if (r.semSlot.children[i] === b) return;
      if (b === active) return;
      r.semSlot.insertBefore(b, r.semSlot.children[i] ?? null);
    });
  }

  /**
   * One row's text, in place.
   * @param {Row} r @param {Worked} w @param {Model} m @param {{ first: boolean, last: boolean, count: number }} where
   */
  function fillRow(r, w, m, where) {
    const exchange = m.result.exchange;
    const year = m.result.year;
    const c = /** @type {any} */ (w.course);
    setChildren(r.rank, `${w.which === 'pick' ? 'Pick' : 'Backup'} ${w.rank}`);
    setChildren(r.sem, w.sem ? semLabel(w.sem) : 'No semester yet');
    // NUS's form: its number, or why none (exchange mode only; browse mode says it once, under the lists).
    if (!exchange) { setChildren(r.form); setChildren(r.formNote); }
    else if (w.form.number) {
      setChildren(r.form, `Application form, ${semLabel(w.sem)}: `, h('b', null, String(w.form.number)), w.faculty === 'biz' ? ', if it\'s a core BBA course' : null);
      r.form.classList.remove('mark');
    } else {
      const text = w.form.text === 'Not on the form' && w.sem && w.status === 'closed' ? `Not on the form: not open in ${semLabel(w.sem)}`
        : w.form.text === 'Not on the form' && !w.sem && (w.kind === 'row' || w.kind === 'ng-listed') ? 'Not on the form until you choose a semester'
          : w.form.text;
      setChildren(r.form, text);
      r.form.classList.toggle('mark', text === FORM_LINES.over);
    }
    setChildren(r.formNote, exchange ? w.form.note : '');

    setChildren(r.title, w.kind === 'loading' ? 'Loading…' : w.kind === 'failed' ? 'Details could not be loaded'
      : w.kind === 'unknown' ? 'No course with this code' : w.title);

    /** @type {import('./dom.js').Child[]} */
    const facts = [];
    if (c) {
      const level = Number(c.level);
      facts.push(h('p', null, [`${w.units ?? '?'} units`, c.department || c.faculty || '', Number.isFinite(level) && level > 0 ? `Level ${level}000` : ''].filter(Boolean).join(' · ')));
      const exams = Array.isArray(c.examDates) ? c.examDates : [];
      if (w.kind === 'ng-listed') facts.push(h('p', { class: 'exam' }, 'Exam timetable not published in NUSMods'));
      else if (w.sem) {
        const e = exams.find((/** @type {any} */ x) => String(x.sem) === w.sem);
        facts.push(e
          ? h('p', { class: 'exam' }, h('span', { class: 'exl' }, `${year} exam`), ' ', h('span', { class: 'mono' }, examLine(e).replace(/^[^:]+: /, '')))
          : h('p', { class: 'exam' }, `No final exam listed in ${year}`));
      } else facts.push(h('p', { class: 'exam' }, examLines(exams).join('; ')));
      facts.push(h('p', null, `Workload (NUSMods): ${workloadText(c.workload)}`));
      if (typeof c.gradingBasis === 'string' && c.gradingBasis && c.gradingBasis !== 'Graded') facts.push(h('p', null, `Grading: ${c.gradingBasis}`));
    }
    facts.push(h('p', { class: 'count' }, ...countLine(w, exchange)));
    setChildren(r.facts, ...facts);

    setChildren(r.guide, ...guide(w, m));
    setChildren(r.flags, ...w.flags.map((f) => h('p', { class: 'sl-flag' }, icon('check'), h('span', null,
      h('b', null, f.kind === 'exam' ? 'Exams overlap.' : f.kind === 'preclusion' ? 'Preclusion.' : 'Same title.'), ' ',
      f.kind === 'preclusion' && f.quote ? `${f.text}. NUS: “${cleanPrereq(f.quote)}”` : stop(f.text)))));

    ariaDisabled(r.up, where.first);
    ariaDisabled(r.down, where.last);
    relabel(r.make, w.which === 'pick' ? 'Make backup' : 'Make primary', w.code);
    const answer = m.answers.get(w.code);
    const loaded = !!answer && answer.kind !== 'loading' && answer.kind !== 'failed';
    semButtons(r, w, choicesFor(answer, m.study), loaded);
    if (w.kind === 'failed') {
      if (!r.retrySlot.firstChild) r.retrySlot.append(rowButton('Try again', w.code, 'retry'));
    } else setChildren(r.retrySlot);
  }

  /**
   * The count line: whether the entry counts, and why or why not.
   * @param {Worked} w @param {boolean} exchange
   * @returns {import('./dom.js').Child[]}
   */
  function countLine(w, exchange) {
    const lead = (/** @type {string} */ t) => h('span', { class: 'sl-count' }, t);
    switch (w.standing) {
      case 'counted': return exchange ? [lead('Counted'), ', if NUS accepts you into it'] : [lead('Counted:'), ' exchange status not checked'];
      case 'confirm': return [lead('To confirm with NUS:'), ` ${stop(lower(w.why.replace(/^To confirm with NUS: /, '')))}`];
      case 'invite': return [lead(stop(w.why))];
      case 'duplicate': return [lead('Not counted:'), ` the same course as ${w.sameAs}.`];
      case 'pending': return [w.why.replace(/: the totals say “at least”$/, ''), '. The totals say “at least”.'];
      default: return [lead('Not counted:'), ` ${stop(lower(w.why))}`];
    }
  }

  /**
   * The row's exchange column: its stamp at its own semester (both semesters'
   * when none is chosen), every note in full, the lines NUS's sources give for
   * it, and NUS's notes on it.
   * @param {Worked} w @param {Model} m
   * @returns {import('./dom.js').Child[]}
   */
  function guide(w, m) {
    /** @type {import('./dom.js').Child[]} */
    const out = [];
    const c = /** @type {any} */ (w.course);
    if (w.kind === 'catalogue-only' || w.kind === 'unknown') {
      out.push(h('div', { class: 'stamps' }, h('span', { class: 'st st-closed' }, icon('closed'), h('span', null, w.kind === 'unknown' ? 'No such course' : 'Not offered this year'))));
    } else if (c && w.sem && w.status) {
      out.push(h('div', { class: 'stamps' }, stamp(w.status, stampText(w.status, Number(w.sem), w.reasons))));
    } else if (c && !w.sem && m.study) {
      const per = [1, 2].map((s) => ({ s, x: exchangeAt(c, s, m.study) })).filter((p) => p.x);
      if (per.length) out.push(h('div', { class: `stamps${per.length === 2 ? ' both' : ''}` }, ...per.map((p) => stamp(p.x.status, stampText(p.x.status, p.s, p.x.reasons ?? [], true)))));
    }
    const items = w.sem ? w.reasons.map((r) => noteItem(r, noteText(r, Number(w.sem)))) : c && m.study ? bothSemNotes(c, m.study) : [];
    // A Business or Law quota note "If you were invited: …" is said under the totals, not again here.
    for (const line of w.lines) if (line !== w.why && !line.startsWith('If you were invited:')) items.push(h('li', null, stop(line)));
    if (items.length) out.push(h('div', { class: 'notes-box' }, h('ul', { class: 'notes' }, ...items)));
    if (w.notes.length) out.push(h('ul', { class: 'sl-nus' }, ...w.notes.map((n) => h('li', null, icon('check'), h('span', null, stop(n))))));
    return out;
  }

  /**
   * The semesters a row's buttons offer (shortlist.js semChoices).
   * @param {Answer | undefined} a @param {string} study
   */
  function choicesFor(a, study) {
    if (!a) return [];
    if (a.kind === 'ng-listed') return (a.course.ng_semesters ?? []).filter((s) => s === 1 || s === 2);
    if (a.kind !== 'row') return [];
    const sems = new Set([...(a.course.semesters ?? []), ...(study ? a.course.ng_semesters ?? [] : [])].map(Number));
    return [1, 2].filter((s) => sems.has(s));
  }

  /** Each semester's totals, the lines NUS's sources give once, and what has no semester. @param {Model} m */
  function fillTotals(m) {
    const r = m.result;
    const tagged = new Set(r.entries.map((w) => w.sem).filter(Boolean));
    const sems = r.order.filter((s) => tagged.has(s));
    const cards = sems.map((s) => {
      const t = r.sems[s];
      const inSem = r.entries.filter((w) => w.sem === s);
      const at = t.pending ? 'at least ' : '';
      const quota = inSem.filter((w) => w.standing === 'invite').flatMap((w) => w.lines.filter((l) => l.startsWith('If you were invited:')));
      const notCounted = inSem.filter((w) => w.standing === 'out' || w.standing === 'duplicate');
      return h('section', { class: 'sl-total', attrs: { 'aria-labelledby': `slTot${s}` } },
        h('h4', { attrs: { id: `slTot${s}` } }, `${semLabel(s)} picks`),
        h('p', { class: 'sl-sum' },
          h('span', { class: 'big' }, at, h('b', { class: 'mono' }, String(t.counted)), r.exchange ? ' units counted, if NUS accepts you into each' : ' units picked, exchange status not checked'),
          t.confirm ? h('span', null, 'plus ', h('b', { class: 'mono' }, String(t.confirm)), ' units to confirm with NUS') : null,
          t.invite ? h('span', null, 'plus ', h('b', { class: 'mono' }, String(t.invite)), ' units only if invited') : null,
          h('span', { class: 'sl-src' }, `${t.counted} units is about ${t.hours} hours a week at NUS's rate (2.5 hours a week per unit).`)),
        ...[...new Set(quota)].map((q) => h('p', { class: 'sl-src' }, stop(q))),
        t.economics ? h('p', { class: 'sl-src' }, `Includes ${t.economics} units of Economics courses. GRO: “${GRO_POPULAR}”.`) : null,
        t.overlap ? h('p', { class: 'sl-flag' }, icon('check'), h('span', null, `Picks with overlapping ${r.year} exams: NUS approves at most one of each pair.`)) : null,
        t.over20 ? h('p', { class: 'sl-flag' }, icon('check'), h('span', null, h('b', null, 'Over 20 units.'), ` ${TOTAL_LINES.maximum} ${TOTAL_LINES.maximumScope}.`)) : null,
        notCounted.length ? h('div', { class: 'sl-out' }, h('p', { class: 'lbl' }, 'Not counted'),
          ...notCounted.map((w) => h('p', null, h('span', { class: 'mono' }, w.code), ` (${w.which === 'pick' ? 'pick' : 'backup'} ${w.rank}): ${lower(stop(w.why))}`))) : null);
    });
    const unplaced = r.entries.filter((w) => !w.sem);
    setChildren(totalsBody,
      cards.length ? h('div', { class: 'sl-totals' }, ...cards) : null,
      h('div', { class: 'sl-unplaced' }, ...(unplaced.length ? [h('p', { class: 'lbl' }, 'No semester yet'),
        ...unplaced.map((w) => h('p', null, h('span', { class: 'mono' }, w.code), ` (${w.which === 'pick' ? 'pick' : 'backup'} ${w.rank}): ${lower(stop(w.why === 'No semester chosen' ? 'Choose Sem 1 or Sem 2 on its row' : w.why))}`))] : [])),
      lines([TOTAL_LINES.admitted, TOTAL_LINES.courseReg, `${TOTAL_LINES.maximum} ${TOTAL_LINES.maximumScope}`, TOTAL_LINES.rate, TOTAL_LINES.weeks]));
  }

  /** NUS's form order, per semester (exchange mode), then the lines for applicants. @param {Model} m */
  function fillForm(m) {
    const r = m.result;
    if (!r.exchange) {
      setChildren(formBody, h('p', { class: 'intro' }, stop(FORM_LINES.setYear)), lines([...APPLICANT_LINES]));
      return;
    }
    const tables = r.order.map((s) => {
      const t = r.sems[s].form;
      const order = [...r.entries.filter((w) => w.which === 'pick'), ...r.entries.filter((w) => w.which === 'alt')]
        .filter((w) => w.sem === s && (w.form.number || w.form.text === FORM_LINES.over));
      if (!t || !order.length) return null;
      return h('div', null,
        h('table', { class: 'sl-ftab' },
          h('caption', null, t.line),
          h('thead', null, h('tr', null, ...['No.', 'Course', 'Units', 'On your list'].map((x) => h('th', { attrs: { scope: 'col' } }, x)))),
          h('tbody', null, ...order.map((w) => h('tr', null,
            h('td', { class: `mono${w.form.number ? '' : ' mark'}` }, w.form.number ? String(w.form.number) : '–'),
            h('th', { class: 'mono', attrs: { scope: 'row' } }, w.code),
            h('td', { class: 'mono' }, String(w.units ?? '?')),
            h('td', w.form.number ? null : { class: 'mark' }, `${w.which === 'pick' ? 'Pick' : 'Backup'} ${w.rank}`,
              w.form.number ? (w.form.note ? `. ${stop(w.form.note)}` : '') : `: ${lower(w.form.text)}`))))),
        r.fullYear && s === '2' ? h('p', { class: 'sl-src' }, stop(FORM_LINES.fullYear)) : null);
    }).filter(Boolean);
    setChildren(formBody,
      h('p', { class: 'intro' }, FORM_LINES.applicants(r.year, m.listDate)),
      tables.length ? h('div', { class: 'sl-forms' }, ...tables) : h('p', { class: 'sl-src' }, 'No entry is on the form yet.'),
      lines([...APPLICANT_LINES]));
  }

  /**
   * The export question's parts: the year of study (and the semester) in
   * browse mode, and a semester for each untagged entry. A part stays once
   * asked (app.js keeps `ask`) so answering never removes the focused control.
   * @param {Model} m
   */
  function fillAsk(m) {
    const want = [...(m.ask.year ? ['year', 'sem'] : []), ...m.ask.entries.map((c) => `entry:${c}`)];
    ask.hidden = want.length === 0;
    for (const [key, set] of askSets) if (!want.includes(key)) { set.remove(); askSets.delete(key); }
    // New parts go in at their place; a part already there never moves (moving it would drop
    // focus from the radio just answered).
    want.forEach((key, i) => {
      let set = askSets.get(key);
      // An entry's part is built again when its choices change (its row has answered).
      const sig = key.startsWith('entry:') ? choicesFor(m.answers.get(key.slice('entry:'.length)), m.study).join() : '';
      if (!set || set.dataset.choices !== sig) {
        const fresh = askSet(key, m);
        fresh.dataset.choices = sig;
        const had = set?.contains(document.activeElement) ? /** @type {HTMLInputElement} */ (document.activeElement).value : null;
        set?.replaceWith(fresh);
        askSets.set(key, fresh);
        if (had !== null) /** @type {HTMLInputElement | null} */ (fresh.querySelector(`input[value="${had}"]`) ?? fresh.querySelector('input'))?.focus();
        set = fresh;
      }
      if (askParts.children[i] !== set) askParts.insertBefore(set, askParts.children[i] ?? null);
    });
    // Checked as the state and the list say.
    for (const [key, set] of askSets) {
      const value = key === 'year' ? m.study : key === 'sem' ? m.sem : m.result.entries.find((w) => `entry:${w.code}` === key)?.sem ?? '';
      for (const input of /** @type {NodeListOf<HTMLInputElement>} */ (set.querySelectorAll('input[type="radio"]'))) input.checked = input.value === value && (key !== 'year' || !!value);
    }
  }

  /** @param {string} key @param {Model} m @returns {HTMLFieldSetElement} */
  function askSet(key, m) {
    /** @param {string} name @param {[string, string][]} opts @param {(v: string) => void} pick */
    const radios = (name, opts, pick) => h('div', { class: 'opts' }, ...opts.map(([value, label]) => {
      const input = h('input', { attrs: { type: 'radio', name, value } });
      input.addEventListener('change', () => { if (input.checked) pick(value); });
      return h('label', null, input, label);
    }));
    if (key === 'year') {
      return h('fieldset', null, h('legend', null, 'Your year of study during the exchange at NUS'),
        radios('slAskStudy', STUDIES.map((o) => [o.value, o.label]), on.askStudy),
        h('p', { class: 'hint' }, 'Answering turns on “Only courses open to exchange students”, so each course shows whether you may take it then.'));
    }
    if (key === 'sem') {
      return h('fieldset', null, h('legend', null, 'Your semester at NUS'),
        radios('slAskSem', [['1', 'Sem 1'], ['2', 'Sem 2'], ['', 'Both semesters']], on.askSem));
    }
    const code = key.slice('entry:'.length);
    const choices = choicesFor(m.answers.get(code), m.study);
    return h('fieldset', null, h('legend', null, `${code}: which semester?`),
      radios(`slAskEntry-${code}`, (choices.length ? choices : [1, 2]).map((s) => [String(s), semLabel(s)]), (v) => on.askEntry(code, /** @type {'1' | '2'} */ (v))));
  }

  return {
    title,
    askTitle,
    pickHead,
    altHead,
    linkInput: fieldInput,
    /** @param {string} code @returns {Row | undefined} */
    row: (code) => rows.get(code),
    /** Whether the export question is shown. */
    asking: () => !ask.hidden,
    /** @param {Model} m */
    update(m) {
      const r = m.result;
      // The semesters the list holds (RT6-PD1); the search filter only names one when the list has none.
      const held = [...new Set(r.entries.map((w) => w.sem).filter((x) => x === '1' || x === '2'))].sort();
      const one = held.length === 1 ? held[0] : held.length === 0 && (m.sem === '1' || m.sem === '2') ? m.sem : '';
      const sems = one ? semLabel(one) : 'Sem 1 and Sem 2';
      const who = m.study ? `${studyAdj(m.study)} exchange student` : 'Exchange status not checked: no year of study set';
      setChildren(sub, `${sems} · ${who} · NUS's ${r.year} courses`);
      setChildren(sentence, ...m.lines.map((l) => h('p', null, l)));
      removed.hidden = !m.removed;
      setChildren(removedText, m.removed ? `${m.removed} removed.` : '');
      undo.setAttribute('aria-label', m.removed ? `Undo, put ${m.removed} back` : 'Undo');
      setChildren(said, m.said);
      if (exportStatus.textContent !== m.exportLine) setChildren(exportStatus, m.exportLine);
      field.hidden = !m.linkField;
      if (fieldInput.value !== m.linkField) fieldInput.value = m.linkField;
      fillAsk(m);
      for (const which of /** @type {('biz' | 'law')[]} */ (['biz', 'law'])) {
        inv[which].set.hidden = !m.faculties.includes(which);
        inv[which].box.checked = m.inv.includes(which);
      }

      const picks = r.entries.filter((w) => w.which === 'pick');
      const alts = r.entries.filter((w) => w.which === 'alt');
      for (const w of r.entries) if (!rows.has(w.code)) makeRow(w.code);
      for (const code of [...rows.keys()]) if (!r.entries.some((w) => w.code === code)) { rows.get(code)?.li.remove(); rows.delete(code); }
      for (const ws of [picks, alts]) {
        ws.forEach((w, i) => fillRow(/** @type {Row} */ (rows.get(w.code)), w, m, { first: i === 0, last: i === ws.length - 1, count: ws.length }));
      }
      place(pickList, picks.map((w) => w.code));
      place(altList, alts.map((w) => w.code));
      setChildren(pickCount, String(picks.length));
      setChildren(altCount, String(alts.length));
      pickNone.hidden = picks.length > 0;
      altNone.hidden = alts.length > 0;
      pickList.hidden = !picks.length;
      altList.hidden = !alts.length;
      totals.hidden = !r.entries.length;
      form.hidden = !r.entries.length;
      if (r.entries.length) { fillTotals(m); fillForm(m); }
    },
  };
}
