// @ts-check
// The page's controller: reads the URL into state, keeps the form and the URL
// in step through nav.js's transitions, searches through api.js, and renders
// with render.js. Each card is a disclosure (one open detail, `open=`) whose
// detail comes from /module/:code; typed codes that are hidden say why, and a
// partial code checks the other semester. The exchange set-up is the first
// screen, then a rail with the set-up, filters and key beside the search;
// filter chips are removable; on a phone the search is one bar with the rail in
// a modal "Filters" dialog. A skip link goes to the shown <main>; one polite
// live region says each answer in a sentence (the count or why there is none,
// the typed codes not shown, errors and 429); the Search button is never
// disabled, so it keeps focus, and a second search aborts the first; Escape
// closes the open detail and focus returns to its button, as it does after
// Back to an open detail. An "Also as" code is a link to its own search with
// its detail open ("Opened from …", `from=`); a hidden typed code carries a
// stamp, and a "Switch to Sem 2" button when the other semester is open to the
// student.
// The shortlist (`pick`, `alt`, `ay`, `inv`) is page-wide, held apart from
// `current` (list.js); every history write goes through one writer
// (history.js); Back and Forward keep the list and write it into the entry
// they reach; edits replace the entry at once and keep a copy on this device
// (saved.js). Its controls: a toggle on each card and in the detail head, the
// shortlist button (in the rail, and on a phone under the search form), and the view (shortlist-view.js, `view=shortlist`) with its
// own history entries; rows load from /module four at a time; every edit says
// what it did in the live region; while the view is shown the search behind
// it neither speaks nor moves focus.
import { createModuleClient, createSearchClient, fetchFacets, fetchSearch } from './api.js';
import { detailError, detailLoading, renderDetail } from './detail.js';
import { h, setChildren } from './dom.js';
import { hiddenCodeLine, hiddenCodeStamp } from './explain.js';
import { quoteUser, semLabel } from './format.js';
import { icon } from './icons.js';
import { intentChipRow } from './intent-chips.js';
import { createWriter } from './history.js';
import { intentChips } from './intents.js';
import { isCloseEscape, isSubmitEnter } from './keys.js';
import { add, emptyList, entryCount, hasEntry, makeOther, move, parseList, remove, restore, setInvite, setSem, tagFor, withYear } from './list.js';
import { errorSentence } from './messages.js';
import { searchAgain, searchKey, transition } from './nav.js';
import { hiddenStamp, settlePartial, shortlistToggle, showLoading, showMessage, showResults } from './render.js';
import { forgetList, restoreOffer, saveList } from './saved.js';
import { answerOf, askable, exportQuestion, summary, workOut, yearLine } from './shortlist.js';
import { toCsv } from './csv.js';
import { SITE_URL, buildExport, fileName } from './export.js';
import { createPrintView } from './print.js';
import { askSentence, createShortlistView } from './shortlist-view.js';
import { CREDITS, LEVELS, SEMESTERS, STUDIES, levelLabel, parseState, searchParams, shortlistUrl, unitsLabel, urlFor } from './state.js';
import { DEFAULT_ACAD_YEAR, headerYearLine, semesterMonths } from './year.js';

/** @typedef {import('./state.js').State} State */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
const $ = (id) => /** @type {T} */ (document.getElementById(id));

const els = {
  form: /** @type {HTMLFormElement} */ ($('f')),
  q: /** @type {HTMLInputElement} */ ($('q')),
  sem: /** @type {HTMLSelectElement} */ ($('sem')),
  level: /** @type {HTMLSelectElement} */ ($('level')),
  credits: /** @type {HTMLSelectElement} */ ($('credits')),
  faculty: /** @type {HTMLSelectElement} */ ($('faculty')),
  ng: /** @type {HTMLInputElement} */ ($('ng')),
  study: /** @type {HTMLSelectElement} */ ($('study')),
  studyWrap: $('studyWrap'),
  semWrap: $('semWrap'),
  semSeg: $('semSeg'),
  semSegOptions: $('semSegOptions'),
  ngHint: $('ngHint'),
  key: $('key'),
  status: $('status'),
  results: $('results'),
  app: $('app'),
  setup: $('setup'),
  layout: $('layout'),
  setupForm: /** @type {HTMLFormElement} */ ($('setupForm')),
  setupSems: $('setupSems'),
  setupStudies: $('setupStudies'),
  setupQ: /** @type {HTMLInputElement} */ ($('setupQ')),
  setupError: $('setupError'),
  setupSources: $('setupSources'),
  browseAll: /** @type {HTMLButtonElement} */ ($('browseAll')),
  chips: $('chips'),
  filtersBtn: /** @type {HTMLButtonElement} */ ($('filtersBtn')),
  filtersBtnText: $('filtersBtnText'),
  dialog: /** @type {HTMLDialogElement} */ ($('filtersDialog')),
  dialogSlot: $('dialogSlot'),
  filtersDone: /** @type {HTMLButtonElement} */ ($('filtersDone')),
  panel: $('panel'),
  live: $('live'),
  skip: /** @type {HTMLAnchorElement} */ ($('skip')),
  slView: $('slView'),
  slPrint: $('slPrint'),
  slOpen: /** @type {HTMLButtonElement[]} */ ([$('slOpenRail'), $('slOpenPhone')]),
  slUndo: [$('slUndoRail'), $('slUndoPhone')],
  slRestore: [$('slRestoreSetup'), $('slRestore')],
};

/** A pending re-announcement (see announce). @type {ReturnType<typeof setTimeout> | undefined} */
let liveTimer;
/**
 * Says `text` in the page's one polite live region. The same text again (the
 * same search re-run) is cleared first and set a moment later, since a region
 * whose text doesn't change says nothing.
 * @param {string} text
 */
function announce(text) {
  clearTimeout(liveTimer);
  if (text && els.live.textContent === text) {
    els.live.textContent = '';
    liveTimer = setTimeout(() => { els.live.textContent = text; }, 150);
  } else {
    els.live.textContent = text;
  }
}

/** When the page last said what an edit did (the rows' "done" sentence then waits its turn). */
let editSaidAt = 0;
/**
 * What the search says (its count, why there is none, a detail that failed,
 * the other semester's check). While the shortlist view is shown the search
 * runs behind it and says nothing.
 * @param {string} text
 */
function resultsSay(text) {
  if (!current.view) announce(text);
}

/**
 * A message in the status area with no results, said in the live region too.
 * @param {string} text
 * @param {boolean} [error]
 */
function message(text, error = false) {
  showMessage(targets, text, error);
  resultsSay(text);
}

// Static option lists: every filter but faculty works before /facets answers.
for (const o of SEMESTERS) els.sem.add(new Option(o.label, o.value));
for (const o of LEVELS) els.level.add(new Option(o.label, o.value));
for (const c of CREDITS) els.credits.add(new Option(unitsLabel(c), c));
for (const o of STUDIES) els.study.add(new Option(o.label, o.value));
els.filtersBtn.prepend(icon('filter'));

/**
 * A radio drawn as a tile, pill or segment: the input covers its label, so the
 * whole shape is the target, and the label's text is its name.
 * @param {string} cls
 * @param {string} name
 * @param {string} value
 * @param {import('./dom.js').Child[]} content
 */
const radio = (cls, name, value, content) => {
  const input = h('input', { attrs: { type: 'radio', name, value } });
  return h('label', { class: cls }, input, ...content);
};

// The rail's semester at NUS in exchange mode: Sem 1, Sem 2 or both. It drives
// #sem, which holds the value in every mode.
for (const [value, label] of [['1', 'Sem 1'], ['2', 'Sem 2'], ['', 'Both']]) els.semSegOptions.append(radio('seg-opt', 'xsem', value, [label]));
// The header's year line: the year's lists, and a clause for next year's applicants.
setChildren($('yearLine'), headerYearLine(DEFAULT_ACAD_YEAR));
// The first screen's two questions.
const months = semesterMonths(DEFAULT_ACAD_YEAR);
for (const [value, name, when] of [['1', 'Sem 1', months[1]], ['2', 'Sem 2', months[2]], ['', 'Both semesters', months.both]]) {
  els.setupSems.append(radio('tile', 'setupSem', value, [h('b', null, name), h('small', null, when), icon('tick', 'tick')]));
}
for (const o of STUDIES) els.setupStudies.append(radio('pill', 'setupStudy', o.value, [icon('tick', 'tick'), o.label]));

/** @param {string} name @returns {HTMLInputElement[]} */
const radios = (name) => /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll(`input[type="radio"][name="${name}"]`)]);
/** @param {string} name @returns {string | null} the checked radio's value, or null */
const checkedValue = (name) => radios(name).find((r) => r.checked)?.value ?? null;
/** @param {string} name @param {string | null} value */
const checkValue = (name, value) => { for (const r of radios(name)) r.checked = value !== null && r.value === value; };

// Exchange mode needs the year of study (the restrictions depend on it). It is
// remembered on this device only to pre-fill the set-up; the URL always wins.
/** The faculty names /facets lists (null until it answers, or for good if it fails or lists none). */
/** @type {Set<string> | null} */
let facultyNames = null;

const STUDY_KEY = 'vnm.study';
const savedStudy = () => { try { return localStorage.getItem(STUDY_KEY) ?? ''; } catch { return ''; } };
const saveStudy = (/** @type {string} */ v) => { try { localStorage.setItem(STUDY_KEY, v); } catch { /* private mode */ } };

/**
 * Selects `value`, adding it as an option first if the list lacks it (a
 * shared link's faculty before /facets answers, or one it doesn't list).
 * @param {HTMLSelectElement} select
 * @param {string} value
 * @param {string} [label]
 */
function selectValue(select, value, label = value) {
  if (value && ![...select.options].some((o) => o.value === value)) select.add(new Option(label, value));
  select.value = value;
}

/** Shows the controls each mode uses: the exchange set-up in exchange mode, the semester filter outside it. */
function syncExchange() {
  const ng = els.ng.checked;
  const special = els.sem.value === '3' || els.sem.value === '4';
  els.studyWrap.hidden = !ng;
  els.semSeg.hidden = !ng || special;
  els.semWrap.hidden = ng && !special;
  checkValue('xsem', ng && !special ? els.sem.value : null);
  els.key.closest('section')?.toggleAttribute('hidden', !ng);
}

/** The empty state names the next step. */
const EMPTY = 'Type what you want to study in the box above, then press Search.';

/** The state of the current history entry; the URL always says the same. */
let current = parseState(new URLSearchParams(location.search));

/**
 * The shortlist: page-wide, not per entry. Read from the URL once; Back
 * and Forward keep it. `droppedOnLoad`: how many of the link's values it left
 * out (malformed, duplicates, past a cap), for the view to say.
 */
const loaded = parseList(new URLSearchParams(location.search));
let list = loaded.list;
const droppedOnLoad = loaded.dropped;
/** The acad year of every /module row loaded (200s only), by code: `ay` comes from the first the list holds. @type {Map<string, string>} */
const rowYears = new Map();
/**
 * The acad year of the first loaded row a list holds, in rank order; '' before one loads.
 * @param {import('./list.js').List} [l]
 */
const rowYear = (l = list) => {
  for (const e of [...l.pick, ...l.alt]) {
    const y = rowYears.get(e.code);
    if (y) return y;
  }
  return '';
};

/** The test hooks, when a spec installs `globalThis.vnmTest` before the page loads. */
const testHooks = /** @type {any} */ (globalThis).vnmTest;
/** Every pushState and replaceState the page makes. */
const writer = createWriter({ history, forceCoalesce: testHooks?.forceCoalesce === true });
/** The page URL for a state, with the list. @param {State} s */
const pageUrl = (s) => urlFor(s, list, location.pathname);

/** localStorage, or null where reading it throws (blocked storage). */
const storage = (() => { try { return localStorage; } catch { return null; } })();

/**
 * The query the view opened with: while the view is shown the box keeps
 * whatever the student types, and on closing it keeps text that differs from
 * this. null when the view isn't shown.
 * @type {string | null}
 */
let viewQ = null;

/** @param {State} s */
function applyToForm(s) {
  // While the view is shown the box is the student's, not the state's (see nav.js: settings while the view is shown).
  const keepBox = viewQ !== null && (s.view !== '' || els.q.value !== viewQ);
  if (!keepBox) els.q.value = s.q;
  selectValue(els.sem, s.sem);
  selectValue(els.level, s.level, levelLabel(s.level));
  selectValue(els.credits, s.credits, unitsLabel(s.credits));
  selectValue(els.faculty, s.faculty, facultyNames?.has(s.faculty) ? s.faculty : quoteUser(s.faculty));
  els.ng.checked = s.ng;
  if (s.study) els.study.value = s.study;
  else if (!els.study.value) {
    const saved = savedStudy();
    if (STUDIES.some((o) => o.value === saved)) els.study.value = saved;
  }
  syncExchange();
  renderChips(s);
  syncView(s);
}

/**
 * The first screen (the exchange set-up) shows until the student searches
 * or chooses to browse, or a link opens the page with any state; then the
 * results layout stays for the page's life, Back to an empty entry included.
 */
let leftSetup = location.search !== '';
// index.html's inline line chose the same view before this module loaded.
delete document.documentElement.dataset.view;

/** @param {State} s */
function syncView(s) {
  const setup = !leftSetup && !s.q.trim();
  els.app.dataset.view = setup ? 'setup' : 'results';
  els.setup.hidden = !setup;
  els.layout.hidden = setup;
  els.skip.href = setup ? '#setup' : '#main';
  // The view replaces the results region (cards, intent chips, facets); the settings and the search form stay.
  const viewing = !setup && s.view === 'shortlist';
  els.slView.hidden = !viewing;
  els.status.hidden = viewing;
  els.results.hidden = viewing;
  for (const b of els.slOpen) {
    if (viewing) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
  if (viewing && viewQ === null) viewQ = s.q;
  if (!viewing) viewQ = null;
}

// The skip link moves focus to the shown <main> (the next Tab is its first
// control) without a fragment in the URL, which would add a history entry.
els.skip.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById(els.skip.hash.slice(1))?.focus();
});

/**
 * The filter chips (V1): every filter and the exchange set-up, labelled as the
 * controls say them. Each filter can be removed from its chip; the semester
 * and year that exchange mode needs are changed in the rail instead, since
 * removing them would leave nothing to search.
 * @param {State} s
 * @returns {{ key: string, label: string, removable: boolean }[]}
 */
function chipList(s) {
  const out = [];
  const special = s.sem === '3' || s.sem === '4';
  if (s.ng) {
    if (s.sem && !special) out.push({ key: 'sem', label: semLabel(s.sem), removable: true });
    else if (!s.sem) out.push({ key: 'sem', label: 'Both semesters', removable: false });
    else out.push({ key: 'sem', label: semLabel(s.sem), removable: true });
    const study = STUDIES.find((o) => o.value === s.study);
    if (study) out.push({ key: 'study', label: study.label, removable: false });
    out.push({ key: 'ng', label: 'Exchange students', removable: true });
  } else if (s.sem) {
    out.push({ key: 'sem', label: semLabel(s.sem), removable: true });
  }
  if (s.level) out.push({ key: 'level', label: levelLabel(s.level), removable: true });
  if (s.credits) out.push({ key: 'credits', label: unitsLabel(s.credits), removable: true });
  // Until /facets lists it, a link's faculty is the student's own text: quoted.
  if (s.faculty) out.push({ key: 'faculty', label: facultyNames?.has(s.faculty) ? s.faculty : quoteUser(s.faculty), removable: true });
  return out;
}

/** @param {State} s */
function renderChips(s) {
  const list = chipList(s);
  setChildren(els.chips, ...list.map((c) => h('li', null, c.removable
    ? h('button', { class: 'chip', attrs: { type: 'button', 'data-filter': c.key, 'aria-label': `Remove filter: ${c.label}` } }, c.label, icon('x'))
    : h('span', { class: 'chip chip-fixed', attrs: { 'data-filter': c.key } }, c.label))));
  els.filtersBtnText.textContent = `Filters (${list.length})`;
}

/**
 * How many chips the student could remove to see more: the next step a
 * no-results answer names. Never the exchange set-up (its semester, or
 * exchange mode itself): that is eligibility, not a preference.
 */
const removableFilters = () => chipList(current).filter((c) => c.removable && c.key !== 'ng' && !(current.ng && c.key === 'sem')).length;

/** @returns {State} what the controls show; ignore, open, from and view are the URL's */
function readForm() {
  return {
    q: els.q.value, sem: els.sem.value, level: els.level.value, credits: els.credits.value, faculty: els.faculty.value,
    ng: els.ng.checked, study: els.ng.checked ? els.study.value : '',
    ignore: current.ignore, open: current.open, from: current.from, view: current.view,
  };
}

const search = createSearchClient();
/** Answers already shown, by /search query string, so Back re-renders without a fetch. */
const answers = new Map();
const ANSWERS_KEPT = 50;
const targets = { status: els.status, results: els.results };
const moduleClient = createModuleClient();
/**
 * /module/:code through the shared client, noting each row's acad year: a row
 * loaded before its code joins the list still gives `ay`.
 */
const modules = {
  /** @param {string} code */
  get: (code) => moduleClient.get(code).then((outcome) => {
    if (outcome.kind === 'ok' && typeof outcome.body?.acad_year === 'string') rowYears.set(code.trim().toUpperCase(), outcome.body.acad_year);
    return outcome;
  }),
};
/**
 * The last search's error kind, kept beside `shown`: Back and Forward to
 * the same search run it again only after a network or server error, never
 * after a 429. Null when the last search answered.
 * @type {'retry' | 'rate' | 'other' | null}
 */
let lastError = null;

/** The exchange-mode sources and their dates, once /facets answers (null until then, or for good if it fails). */
/** @type {import('./explain.js').Source[] | null} */
let sources = null;
/**
 * The answer on screen, its /search key, and the cards render.js built for it.
 * @type {{ key: string, data: any, view: import('./render.js').Rendered } | null}
 */
let shown = null;

// The links the page renders carry no list and no view: a new tab starts with
// no list (or offers the remembered one), so two tabs never fork one list.
/** A link to the search for a course code, keeping the filters and exchange set-up. @param {string} code */
const searchHref = (code) => urlFor({ ...current, q: code, ignore: [], open: '', from: '', view: '' }, emptyList(), location.pathname);
/** An "Also as" link: the other code's search, its detail open, from the entry. @param {string} code @param {string} from */
const variantHref = (code, from) => urlFor({ ...current, q: code, ignore: [], open: code, from, view: '' }, emptyList(), location.pathname);

/**
 * Fills a card's detail from /module/:code (fetched once per page). `quiet`:
 * a re-fill (the sources' dates arrived), whose failure was already said.
 * @param {string} code
 * @param {HTMLElement} region
 * @param {{ quiet?: boolean }} [opts]
 */
async function loadDetail(code, region, { quiet = false } = {}) {
  if (!shown) return;
  const { data } = shown;
  detailLoading(region);
  const outcome = await modules.get(code);
  if (region.hidden || !region.isConnected) return;
  if (outcome.kind !== 'ok') {
    const sentence = outcome.kind === 'error' ? errorSentence(outcome.error) : '';
    detailError(region, sentence, () => loadDetail(code, region));
    if (!quiet) resultsSay(`The details of ${code} could not be loaded. ${sentence}`.trim());
    return;
  }
  renderDetail(region, outcome.body, {
    filters: data.filters ?? {}, sources, searchHref, onClose: () => act({ type: 'close' }), from: code === current.open ? current.from : '',
    toggle: (c) => shortlistToggle(c, hasEntry(list, c) !== ''),
  });
}

/**
 * `from=` makes the detail say the open course and that code are one course:
 * it stands only when the code is one of the open entry's own other
 * codes ("Also as"). Otherwise it is dropped, from the state and the URL, so a
 * crafted link can't claim two unrelated courses are the same.
 * @param {State} s
 * @returns {State}
 */
function checkFrom(s) {
  if (!s.open || !s.from || !shown) return s;
  const results = Array.isArray(shown.data?.results) ? shown.data.results : [];
  const entry = results.find((/** @type {any} */ r) => String(r?.code ?? '') === s.open);
  const others = Array.isArray(entry?.variants) ? entry.variants.map((/** @type {any} */ v) => String(v?.code ?? '')) : [];
  if (others.includes(s.from)) return s;
  const fixed = { ...s, from: '' };
  if (current === s) {
    current = fixed;
    writer.replace(pageUrl(fixed));
  }
  return fixed;
}

/**
 * Opens the state's detail and closes every other (at most one).
 * `focusCode`: return focus to that card's button (a detail just closed).
 * @param {State} s
 * @param {string} [focusCode]
 */
function syncDetail(s, focusCode = '') {
  if (!shown) return;
  checkFrom(s);
  for (const [code, { button, region }] of shown.view.cards) {
    const open = code === s.open;
    button.setAttribute('aria-expanded', String(open));
    if (open && region.hidden) {
      region.hidden = false;
      loadDetail(code, region);
    } else if (!open && !region.hidden) {
      region.hidden = true;
      setChildren(region);
    }
  }
  if (focusCode) shown.view.cards.get(focusCode)?.button.focus();
}

/** Says the answer on screen in the live region, with the phrases read from the query. */
function announceAnswer() {
  if (!shown) return;
  const read = intentChips(shown.data?.interpreted, current.ignore).map((c) => c.label);
  resultsSay([shown.view.announce, read.length ? `Read from your query: ${read.join(', ')}.` : ''].filter(Boolean).join(' '));
}

/**
 * Says why each hidden typed code isn't shown, from its own stored reasons,
 * under a stamp; where the other semester is open to the student, a
 * button switches to it.
 */
function explainHidden() {
  if (!shown) return;
  const { data, view } = shown;
  const filters = data.filters ?? {};
  const sem = filters.sem === 1 || filters.sem === 2 ? String(filters.sem) : '';
  const study = filters.ng === true ? String(filters.study ?? '') : '';
  for (const [code, { why, title, stamp, actions }] of view.hidden) {
    modules.get(code).then((outcome) => {
      if (!why.isConnected) return;
      if (outcome.kind !== 'ok') { setChildren(why, `${code} isn't shown with these settings. The reason could not be loaded; reload the page to try again.`); return; }
      setChildren(title, typeof outcome.body.title === 'string' ? outcome.body.title : '');
      setChildren(why, hiddenCodeLine({
        code, sem: filters.sem === undefined ? '' : String(filters.sem), study, exchange: outcome.body.exchange, sources, module: outcome.body, filters,
      }));
      const verdict = hiddenCodeStamp({ sem: filters.sem === undefined ? '' : String(filters.sem), study, exchange: outcome.body.exchange });
      setChildren(stamp, hiddenStamp(verdict.text));
      // Only from a chosen Sem 1 or 2 (never a special term), and only if the
      // rest of the settings would show the code there: a code exchange mode
      // allows but another filter hides gets no switch.
      if (!verdict.switchTo || !sem || otherFilterHides(outcome.body, filters)) { setChildren(actions); return; }
      const button = h('button', { class: 'linkbtn switch-sem', attrs: { type: 'button' } }, `Switch to ${semLabel(verdict.switchTo)} to see ${code}`);
      button.addEventListener('click', () => switchSemester(verdict.switchTo, code));
      setChildren(actions, button);
    });
  }
}

/**
 * Whether a filter other than the exchange set-up would hide this course too
 * (its level, units or faculty), so switching the semester would not show it.
 * @param {any} m /module/:code's row
 * @param {Record<string, unknown>} filters
 */
function otherFilterHides(m, filters) {
  return (filters.level !== undefined && String(m.level) !== String(filters.level))
    || (filters.credits !== undefined && String(m.credits) !== String(filters.credits))
    || (filters.faculty !== undefined && m.faculty !== filters.faculty);
}

/**
 * Switches the exchange semester (a settings change: replace), then focuses
 * the course's entry if the new answer shows it, else the search box.
 * @param {string} sem '1' or '2'
 * @param {string} code
 */
async function switchSemester(sem, code) {
  els.sem.value = sem;
  syncExchange();
  await actThenFocus({ type: 'settings', form: readForm() }, code);
}

/**
 * Applies an action that replaces the answer under the student's focus (the
 * switch, an "Also as" link), then focuses `code`'s entry once the new answer
 * shows it, else the search box. Not if the student has moved on while it
 * loaded (another action, Back): focus stays where they put it.
 * @param {import('./nav.js').Action} action
 * @param {string} code
 */
async function actThenFocus(action, code) {
  const done = act(action);
  const mine = current;
  await done;
  if (current !== mine) return;
  const button = shown?.view.cards.get(code)?.button;
  if (button) button.focus();
  else els.q.focus();
}

/**
 * A partial code emptied in one semester: does the other semester have
 * results? The button to see it appears only if it does.
 * @param {State} s
 */
async function checkOtherSemester(s) {
  const p = shown?.view.partial;
  if (!p || !p.sem) return;
  const other = p.sem === '1' ? '2' : '1';
  const params = searchParams({ ...s, sem: other });
  if (!params) return;
  const key = params.toString();
  const outcome = answers.has(key) ? { kind: 'ok', body: answers.get(key) } : await fetchSearch(params);
  if (shown?.view.partial !== p) return;
  if (outcome.kind === 'ok') remember(key, outcome.body);
  const has = outcome.kind === 'ok' ? Array.isArray(outcome.body?.results) && outcome.body.results.length > 0 : null;
  const before = p.line.textContent;
  settlePartial(p, has, () => {
    els.sem.value = other;
    act({ type: 'settings', form: readForm() });
  });
  // Said again only if it changed: the line now says "either semester", or a
  // button to see the other semester appeared (a failed check changes neither).
  const see = p.actions.querySelector('button');
  if (see || p.line.textContent !== before) resultsSay([p.line.textContent, see ? `The “${see.textContent}” button shows them.` : ''].filter(Boolean).join(' '));
}

/** @param {string} key @param {any} body */
function remember(key, body) {
  answers.set(key, body);
  if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
}

/**
 * Shows an answer, then everything that hangs off it.
 * @param {State} s
 * @param {string} key
 * @param {any} body
 */
function render(s, key, body) {
  shown = { key, data: body, view: showResults(targets, body, { searchHref, variantHref, removableFilters: removableFilters(), query: s.q, listed: (code) => hasEntry(list, code) !== '' }) };
  showIntentChips(body);
  announceAnswer();
  syncDetail(s);
  explainHidden();
  checkOtherSemester(s);
}

/**
 * The chips for the phrases /search read from the query; removing one
 * re-runs the search with `ignore=` that intent.
 * @param {any} body
 */
function showIntentChips(body) {
  const row = intentChipRow(body?.interpreted, current.ignore, (intent) => {
    act({ type: 'settings', form: { ...readForm(), q: current.q, ignore: [...new Set([...current.ignore, intent])].sort() } });
    els.q.focus();
  });
  if (row) els.status.append(row);
}

/**
 * Renders a state: from memory when this page has shown it before, else by
 * searching. `fromUser`: the student just acted, so a missing year of study
 * takes focus. `submitted`: they pressed Search, so the answer is said again
 * even when it is the one on screen.
 * @param {State} s
 * @param {{ fromUser?: boolean, submitted?: boolean }} [opts]
 */
async function show(s, { fromUser = false, submitted = false } = {}) {
  const params = searchParams(s);
  if (!params) {
    shown = null;
    search.abort();
    if (s.q.trim() && s.ng && !s.study) {
      message('Choose your year of study to see the courses open to you as an exchange student.');
      // After the event, not during it: a click on the exchange switch's label
      // runs this inside the label's activation, and WebKit then focuses the
      // checkbox itself where checkboxes take focus on click (Linux), which
      // would undo a focus moved here.
      // Not while the view is shown: its own controls keep focus (the export question).
      if (fromUser && !s.view) setTimeout(() => els.study.focus(), 0);
    } else if (leftSetup) {
      message(EMPTY);
    } else {
      // The first screen asks its own questions; "the box above" is the results view's.
      showMessage(targets, EMPTY);
      resultsSay('');
    }
    return;
  }
  const key = params.toString();
  // The same answer is on screen (a detail opened or closed, or Back to it):
  // only the detail changes, so focus and the scroll position stay.
  if (shown && shown.key === key) {
    search.abort();
    syncDetail(s);
    if (submitted) announceAnswer();
    return;
  }
  if (answers.has(key)) {
    search.abort();
    render(s, key, answers.get(key));
    return;
  }
  // The Search button stays enabled: disabling the focused button
  // would drop focus to the page, and a second search aborts this one anyway.
  shown = null;
  showLoading(targets);
  resultsSay('');
  const outcome = await search(params);
  if (outcome.kind === 'superseded') return;
  if (outcome.kind === 'error') {
    const status = outcome.error.status ?? 0;
    lastError = status === 429 ? 'rate' : status >= 400 && status < 500 ? 'other' : 'retry';
    message(errorSentence(outcome.error), true);
    return;
  }
  lastError = null;
  remember(key, outcome.body);
  render(s, key, outcome.body);
}

/**
 * Applies a user action: the transition's history op, then the render.
 * Resolves once the answer is on screen (at once for back() and no-ops).
 * @param {import('./nav.js').Action} action
 * @returns {Promise<void>}
 */
async function act(action) {
  // A pending edit lands in the entry being left first.
  writer.flush();
  const detailPushed = writer.state()?.vnmDetail === true;
  const { state, op } = transition(current, action, { detailPushed });
  if (op === 'none') return;
  // popstate restores the list entry, and its state, after back().
  if (op === 'back') { history.back(); return; }
  const url = pageUrl(state);
  const before = current;
  if (action.type === 'openView') {
    // The view's entry: it records the search it opened from, and this page pushed it (a detail
    // entry this page pushed is replaced by it), so closing it with nothing changed goes back().
    const data = { vnmShortlist: true, atOpen: searchKey(current) };
    if (op === 'replace-push') writer.replace(pageUrl({ ...current, open: '', from: '' }), null);
    if (op === 'replace') writer.replace(url, data);
    else writer.push(url, data);
  } else {
    if (op === 'replace-push') writer.replace(pageUrl({ ...current, open: '', from: '' }), null);
    if (op === 'push' || op === 'replace-push') writer.push(url, action.type === 'open' ? { vnmDetail: true } : null);
    // Settings while the view is shown keep the entry's state (its vnmShortlist and atOpen).
    else writer.replace(url, action.type === 'open' || state.view ? undefined : null);
  }
  const closing = action.type === 'close' ? current.open : '';
  current = state;
  applyToForm(state);
  if (action.type === 'openView') {
    // No show(): the search stays as it was, hidden behind the view; the rows load.
    enterView();
    return;
  }
  if (action.type === 'closeView') {
    // Closed by replace (something changed since it opened, or a link opened it): the search
    // runs again only by popstate's rule, and the count is said; focus on the shortlist button.
    leaveView();
    if (shown && shown.key === (searchParams(state)?.toString() ?? '')) announceAnswer();
    else if (searchAgain(before, state, lastError) || (!shown && lastError === 'retry')) await show(state);
    else announce(els.status.textContent ?? '');
    return;
  }
  const done = show(state, { fromUser: true, submitted: action.type === 'submit' });
  // Closed by replace: focus goes back to the card's button (closed by back(), popstate does it).
  if (closing) shown?.view.cards.get(closing)?.button.focus();
  if (before.view && state.view && action.type === 'settings') settingsInView();
  if (before.view && !state.view) { viewClosed(); }
  await done;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  act({ type: 'submit', form: readForm() });
});
// Enter is bound explicitly so the primary interaction never depends on
// implicit form submission, and so it can wait for IME composition.
/**
 * @param {HTMLInputElement} input
 * @param {() => void} submit
 */
function onEnter(input, submit) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    // Safari reports the keydown that ends a composition as keyCode 229 after
    // compositionend: swallow it so the form doesn't submit on its own either.
    if (!e.isComposing && e.keyCode === 229) { e.preventDefault(); return; }
    if (!isSubmitEnter(e)) return;
    e.preventDefault();
    submit();
  });
}
onEnter(els.q, () => act({ type: 'submit', form: readForm() }));
for (const el of [els.sem, els.level, els.credits, els.faculty, els.ng, els.study]) {
  el.addEventListener('change', () => {
    if (el === els.study) saveStudy(els.study.value);
    syncExchange();
    act({ type: 'settings', form: readForm() });
    // A special term changed to Sem 1 or 2 in exchange mode: the select gives
    // way to the segment, so focus moves to its choice instead of the page.
    if (el === els.sem && els.semWrap.hidden) radios('xsem').find((r) => r.checked)?.focus();
  });
}
// The rail's semester segment sets #sem, which every mode reads.
els.semSegOptions.addEventListener('change', () => {
  els.sem.value = checkedValue('xsem') ?? '';
  act({ type: 'settings', form: readForm() });
});

// A chip's button removes its filter; focus moves to the next chip, or the query.
els.chips.addEventListener('click', (e) => {
  const chip = e.target instanceof Element ? e.target.closest('button.chip') : null;
  if (!(chip instanceof HTMLButtonElement)) return;
  const at = [...els.chips.querySelectorAll('button.chip')].indexOf(chip);
  const key = chip.dataset.filter ?? '';
  const form = readForm();
  if (key === 'ng') { form.ng = false; form.study = ''; } else if (key === 'sem' || key === 'level' || key === 'credits' || key === 'faculty') form[key] = '';
  act({ type: 'settings', form });
  const left = /** @type {HTMLButtonElement[]} */ ([...els.chips.querySelectorAll('button.chip')]);
  (left[Math.min(at, left.length - 1)] ?? els.q).focus();
});

// The first screen: the semester and the year of study, then the query.
/** @param {string} text @param {HTMLElement} focus */
function setupAsk(text, focus) {
  els.setupError.textContent = text;
  els.setupError.hidden = false;
  focus.focus();
  announce(text);
}
function submitSetup() {
  const sem = checkedValue('setupSem');
  const study = checkedValue('setupStudy');
  const q = els.setupQ.value.trim();
  if (sem === null) { setupAsk('Choose the semester you will study at NUS.', radios('setupSem')[0]); return; }
  if (!study) { setupAsk('Choose your year of study during your exchange.', radios('setupStudy')[0]); return; }
  if (!q) { setupAsk('Type what you want to study.', els.setupQ); return; }
  els.setupError.hidden = true;
  saveStudy(study);
  leftSetup = true;
  act({ type: 'submit', form: { ...readForm(), q, sem, level: '', credits: '', faculty: '', ng: true, study } });
  // The results start at the top of the page, whatever the set-up was scrolled to.
  window.scrollTo(0, 0);
  els.q.focus({ preventScroll: true });
}
els.setupForm.addEventListener('submit', (e) => { e.preventDefault(); submitSetup(); });
onEnter(els.setupQ, submitSetup);
els.browseAll.addEventListener('click', () => {
  leftSetup = true;
  syncView(current);
  show(current);
  window.scrollTo(0, 0);
  els.q.focus();
});

// On a phone the rail is a modal dialog behind "Filters (n)": its panel
// moves into the dialog while it is open, so there is one set of controls.
// The browser's modal dialog keeps the rest of the page inert and closes on
// Escape; focus also wraps inside it, and returns to the button on close.
const rail = /** @type {HTMLElement} */ (els.panel.parentElement);
// The live region goes into the dialog too while it is open: a modal dialog
// makes the rest of the page inert, the header's live region included, so a
// change made in the dialog would be said to no one.
const liveHome = /** @type {HTMLElement} */ (els.live.parentElement);
els.filtersBtn.addEventListener('click', () => {
  els.dialogSlot.append(els.panel);
  els.dialog.append(els.live);
  els.dialog.showModal();
  /** @type {HTMLElement | null} */ (els.panel.querySelector('input, select'))?.focus();
});
els.filtersDone.addEventListener('click', () => els.dialog.close());
/** The control focused in the dialog when a resize closed it (the browser moves focus before `close`). */
/** @type {Element | null} */
let refocus = null;
els.dialog.addEventListener('close', () => {
  const was = refocus ?? document.activeElement;
  refocus = null;
  rail.prepend(els.panel);
  liveHome.append(els.live);
  // Back to the button; or, widened past the phone layout (no button), to the
  // control that had focus, now in the rail.
  if (getComputedStyle(els.filtersBtn).display !== 'none') els.filtersBtn.focus();
  else if (was instanceof HTMLElement && els.panel.contains(was)) was.focus();
  else els.q.focus();
});
/**
 * The dialog's controls in Tab order: one stop per radio group (its checked
 * radio, else its first), each shown control once.
 * @returns {HTMLElement[]}
 */
function dialogStops() {
  const all = /** @type {HTMLElement[]} */ ([...els.dialog.querySelectorAll('button, input, select, a[href]')])
    .filter((el) => !el.closest('[hidden]') && !(/** @type {any} */ (el).disabled) && el.getClientRects().length > 0);
  /** @type {Set<string>} */
  const groups = new Set();
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio') return true;
    if (groups.has(el.name)) return false;
    groups.add(el.name);
    return true;
  }).map((el) => (el instanceof HTMLInputElement && el.type === 'radio' ? radios(el.name).find((r) => r.checked) ?? el : el));
}
// Tab and Shift+Tab move through the dialog's controls and wrap, in every
// engine (WebKit's own Tab skips checkboxes and radios, and lets Shift+Tab
// leave a modal dialog).
els.dialog.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const stops = dialogStops();
  if (!stops.length) return;
  e.preventDefault();
  const active = document.activeElement;
  const at = stops.findIndex((el) => el === active
    || (active instanceof HTMLInputElement && active.type === 'radio' && el instanceof HTMLInputElement && el.name === active.name));
  const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
  stops[next].focus();
});
// Widened past the phone layout with the dialog open: the rail is back in view.
matchMedia('(min-width: 641px)').addEventListener('change', (e) => {
  if (!e.matches || !els.dialog.open) return;
  refocus = document.activeElement;
  els.dialog.close();
});

document.addEventListener('keydown', (e) => {
  if (!isCloseEscape(e) || els.dialog.open) return;
  // The view closes on Escape, as a detail does; the box, if focused, keeps its text.
  if (current.view) {
    e.preventDefault();
    closeView();
    return;
  }
  if (!current.open) return;
  // The detail closes and focus returns to its button; the search box, if
  // focused, keeps its text (a search field's own Escape clears it).
  e.preventDefault();
  act({ type: 'close' });
});
// A card's button opens its detail, or closes it (the APG disclosure pattern).
els.results.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('button.card-toggle') : null;
  if (!(button instanceof HTMLButtonElement)) return;
  act(button.getAttribute('aria-expanded') === 'true' ? { type: 'close' } : { type: 'open', code: button.dataset.code ?? '' });
});
// An "Also as" code opens its own entry: its search, with its detail open and
// saying where it came from. Focus goes to that entry's button, which
// brings the open detail into view; the href opens the same in a new tab.
els.results.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-variant]') : null;
  if (!(link instanceof HTMLAnchorElement) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  actThenFocus({ type: 'variant', code: link.dataset.variant ?? '', from: link.dataset.from ?? '' }, link.dataset.variant ?? '');
});
// A course code in the detail or a related-courses line searches for it here;
// its href still opens the same search in a new tab.
document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-search]') : null;
  if (!(link instanceof HTMLAnchorElement) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  act({ type: 'submit', form: { ...readForm(), q: link.dataset.search ?? '' } });
  window.scrollTo({ top: 0 });
  els.q.focus({ preventScroll: true });
});
// After Back and Forward the page places the view itself: the browser's own
// restoration runs after popstate, and would scroll a card just focused out of
// view.
history.scrollRestoration = 'manual';
window.addEventListener('popstate', async () => {
  // The browser has moved: a pending write is for the entry left. The
  // page keeps its list and writes it into the entry it arrived at (settle).
  writer.cancel();
  const left = current;
  const before = current.open;
  const answerBefore = shown?.key;
  current = settle(parseState(new URLSearchParams(location.search)));
  const after = current;
  // The view: Forward or Back into it shows it, focus on its heading; Back out of it,
  // focus on the shortlist button that is displayed. The search runs by the rule below.
  if (after.view && !left.view) enterView();
  if (!after.view && left.view) leaveView();
  // The same search after a 429 (or another 4xx) is not run again: its message stays.
  if (!shown && !searchAgain(left, after, lastError)) {
    if (!after.view && left.view) announce(els.status.textContent ?? '');
    return;
  }
  await show(after);
  if (current !== after) return;
  if (after.view || left.view) {
    if (!after.view && left.view) announceAnswer();
    return;
  }
  // Back from an open detail: the list, its detail closed, focus on its button.
  // Back to an open detail (from a search a course code in it ran): focus on
  // its button, where the student left the list. Focus brings it into view;
  // another answer without one starts at the top.
  const card = before && !after.open ? before : after.open && after.open !== before ? after.open : '';
  const button = card ? shown?.view.cards.get(card)?.button : null;
  if (button) { button.focus(); return; }
  if (shown?.key !== answerBefore) window.scrollTo(0, 0);
  // The control that had focus went with the answer it was in (a card's
  // button): focus the shown <main>, so the next Tab is the search box.
  if (!document.activeElement || document.activeElement === document.body) document.getElementById(els.skip.hash.slice(1))?.focus({ preventScroll: true });
});

// The header stays at the top of a wide screen, so whatever focus or a link
// scrolls into view stops below it, not under it (WCAG 2.4.11).
const header = /** @type {HTMLElement} */ (document.querySelector('.hdr'));
new ResizeObserver(() => {
  document.documentElement.style.scrollPaddingTop = getComputedStyle(header).position === 'sticky' ? `${header.offsetHeight + 8}px` : '';
}).observe(header);

// The tiles, pills and segments draw their radio's focus ring. WebKit doesn't
// count moving within a radio group by arrow keys as keyboard focus
// (:focus-visible), so the page tracks the last input itself: the ring shows
// for a key, never for a click or a tap.
document.addEventListener('keydown', () => { document.documentElement.dataset.keys = ''; }, true);
document.addEventListener('pointerdown', () => { delete document.documentElement.dataset.keys; }, true);

// /facets fills the faculty list and the exchange-mode sources. Nothing waits
// on it: the first search starts below, at once, and a shared link's
// faculty is already an option.
fetchFacets().then((f) => {
  if (!f) return;
  sources = Array.isArray(f.ngSources) ? f.ngSources : null;
  // The hidden-code lines and an open detail name the sources' dates: say them now.
  if (sources && shown) {
    explainHidden();
    for (const [code, { region }] of shown.view.cards) {
      if (!region.hidden && !region.contains(document.activeElement)) loadDetail(code, region, { quiet: true });
    }
  }
  /** @type {string[]} */
  const names = [];
  for (const x of Array.isArray(f.faculties) ? f.faculties : []) {
    const name = String(x?.name ?? '');
    if (!name) continue;
    names.push(name);
    const label = `${name} (${Number(x.count) || 0})`;
    const existing = [...els.faculty.options].find((o) => o.value === name);
    if (existing) existing.text = label;
    else els.faculty.add(new Option(label, name));
  }
  // A link's faculty that /facets doesn't list is no faculty: it would
  // only stand as a chip in the site's voice over no results. Drop it, and its
  // option, and search without it (a settings change: replace).
  if (names.length) {
    facultyNames = new Set(names);
    for (const o of [...els.faculty.options]) if (o.value && !names.includes(o.value)) o.remove();
    if (current.faculty && !names.includes(current.faculty)) {
      els.faculty.value = '';
      act({ type: 'settings', form: { ...readForm(), q: current.q, faculty: '' } });
    }
  }
  // A listed faculty's chip loses its quotes.
  if (current.faculty && facultyNames?.has(current.faculty)) renderChips(current);
  if (f.ng) {
    els.ngHint.textContent = f.ng.count
      ? `${f.ng.count} courses on the NUS Registrar's list${f.ng.updatedAsAt ? `, updated ${f.ng.updatedAsAt}` : ''}.`
      : 'The NG list could not be loaded. Reload the page to try again.';
  }
  if (sources) renderSources();
  // NUS's rules on courses off the exchange list, and the list's date, for the shortlist's rows and form.
  offListRules = Array.isArray(f.offListRules) ? f.offListRules : null;
  renderShortlist();
});

/** @param {RegExp} name @returns {string} a source's "updated as at" date, or '' */
const updated = (name) => {
  const src = (sources ?? []).find((x) => name.test(String(x?.name ?? '')));
  return typeof src?.updatedAsAt === 'string' ? src.updatedAsAt : '';
};

/** The first screen's sources box and the rail's key, with the lists' dates once /facets gives them. */
function renderSources() {
  const ngDate = updated(/offered/i);
  const rDate = updated(/restriction/i);
  setChildren(els.setupSources,
    h('h3', { class: 'lbl' }, 'Where the rules come from'),
    h('table', { class: 'srct' },
      h('thead', null, h('tr', null, h('th', { attrs: { scope: 'col' } }, 'NUS Registrar list'), h('th', { attrs: { scope: 'col' } }, 'Updated as at'))),
      h('tbody', null,
        h('tr', null, h('td', null, 'Courses offered to exchange students (the ', h('b', null, 'NG list'), ')'), h('td', null, ngDate || '…')),
        h('tr', null, h('td', null, 'Course restrictions for exchange students'), h('td', null, rDate || '…')))),
    h('p', null, '“NG” means non-graduating: NUS\'s word for exchange students. Course details come from NUSMods.'),
    h('div', { class: 'checknus' }, icon('check'), h('strong', null, 'This site is unofficial. Check with NUS before you register.')));
  setChildren(els.key,
    h('li', { class: 'k k-open' }, icon('open'), h('span', null, h('b', null, 'Open.'), ' Exchange students may take it in that semester.')),
    h('li', { class: 'k k-note' }, icon('note'), h('span', null, h('b', null, 'Open, with notes.'), ' Read every note: some limit who may take it.')),
    h('li', { class: 'k k-closed' }, icon('closed'), h('span', null, h('b', null, 'Not open.'), ' You cannot take it in that semester. Type its course code in the search box to see why.')),
    h('li', { class: 'gloss' }, h('b', null, 'NG list'), ' is the NUS Registrar\'s list of courses offered to exchange students (NUS calls them “non-graduating”, NG).',
      ngDate ? ` Updated ${ngDate}` : '', rDate ? `; restrictions list updated ${rDate}.` : (ngDate ? '.' : '')));
}
renderSources();

/**
 * Shows an entry's state in the form and makes its URL canonical. An
 * exchange-mode entry without a year of study takes the one the set-up
 * already shows (remembered on this device, or chosen since), and the URL
 * then states it.
 * @param {State} s
 * @returns {State}
 */
function settle(s) {
  applyToForm(s);
  const settled = s.ng && !s.study && els.study.value ? { ...s, study: els.study.value } : s;
  if (settled !== s) renderChips(settled);
  const canonical = pageUrl(settled);
  if (canonical !== `${location.pathname}${location.search}`) writer.replace(canonical);
  return settled;
}

// ---- The shortlist (state and controls). The exports call these too.

/** /facets' offListRules: null until it answers, and for good if it fails (the rows then say to ask NUS). */
/** @type {import('./shortlist.js').OffListRule[] | null} */
let offListRules = null;
/** Each entry's /module answer (shortlist.js answerOf); missing while it loads. @type {Map<string, import('./shortlist.js').Answer>} */
const rowAnswers = new Map();
/** Codes queued or in flight. @type {Set<string>} */
const rowWanted = new Set();
/** @type {string[]} */
const rowQueue = [];
let rowsActive = 0;
/** At most this many /module requests at once. */
const ROWS_AT_ONCE = 4;
/**
 * The last removal, for Undo, until the next edit: from a card's toggle (Undo
 * beside the shortlist button) or the view's Remove (Undo at the top of the view).
 * @type {{ removed: import('./list.js').Removed, where: 'card' | 'view' } | null}
 */
let undoable = null;
/** The view's one sentence after a settings change in it ("Sem 2 first: …"), until it closes. */
let viewSentence = '';
/** "Link copied", beside the actions; and the link to copy by hand when the browser refused. */
let copySaid = '';
let copyField = '';
/** The export question's parts asked since the view opened (kept while it stays open). */
let asked = { year: false, entries: /** @type {string[]} */ ([]) };
/** Whether "Loading N courses" was said, so "done" is said once after it. */
let progressSaid = false;
/** Counts edits, so a slow "added" sentence stands down when another edit came after it. */
let editCount = 0;
/**
 * An export pressed before every row was in: which, until the second
 * press does it or the view closes; and whether "Ready: press again" was said.
 * @type {'csv' | 'print' | null}
 */
let exportWaiting = null;
let exportReadySaid = false;
/** The page's own title, which printing the shortlist swaps for the file name and `afterprint` restores. */
const pageTitle = document.title;
/** The export's document as last drawn on the print page. @type {import('./export.js').Doc | null} */
let printed = null;
const printView = createPrintView(els.slPrint);

const slView = createShortlistView(els.slView, {
  close: () => closeView(),
  copy: () => copyLink(),
  exportPress: (kind) => exportPress(kind),
  invite: (which, on) => {
    const r = editList((l) => setInvite(l, which, on));
    if (!r.ok) return;
    const res = worked();
    const sem = res.order.find((s) => res.entries.some((w) => w.sem === s && w.faculty === which)) ?? res.order[0];
    say(`${which === 'biz' ? 'Business' : 'Law'} courses ${on ? 'counted' : 'not counted'}: ${semLabel(sem)}, ${picked(sem)} units picked`);
  },
  askStudy: (study) => {
    els.ng.checked = true;
    els.study.value = study;
    saveStudy(study);
    syncExchange();
    act({ type: 'settings', form: readForm() });
  },
  askSem: (sem) => {
    els.sem.value = sem;
    syncExchange();
    act({ type: 'settings', form: readForm() });
  },
  askEntry: (code, sem) => {
    const r = editList((l) => setSem(l, code, sem));
    say(r.ok ? `${code} moved to ${semLabel(sem)}` : r.why);
  },
  move: (code, dir, button) => {
    const w = entry(code);
    if (!w) return;
    const r = editList((l) => move(l, code, dir));
    if (!r.ok) { say(`${code} is already ${dir < 0 ? 'first' : 'last'}`); return; }
    button.scrollIntoView({ block: 'nearest' });
    const now = entry(code);
    if (!now) return;
    const n = now.which === 'pick' ? list.pick.length : list.alt.length;
    const form = worked().exchange && now.form.number ? `, number ${now.form.number} on the form` : '';
    say(`${code} moved ${dir < 0 ? 'up' : 'down'}: ${now.which === 'pick' ? 'pick' : 'backup'} ${now.rank} of ${n}${form}`);
  },
  make: (code, button) => {
    const r = editList((l) => makeOther(l, code));
    if (!r.ok) { say(r.why); return; }
    // The row moved to the other list: its same control, in its new place, then the sentence.
    button.focus();
    button.scrollIntoView({ block: 'nearest' });
    say(`${code} is now ${hasEntry(list, code) === 'alt' ? 'a backup' : 'a primary pick'}`);
  },
  sem: (code, to, button) => {
    const r = editList((l) => setSem(l, code, to));
    if (!r.ok) { say(r.why); return; }
    button.scrollIntoView({ block: 'nearest' });
    say(`${code} moved to ${semLabel(to)}`);
  },
  remove: (code) => removeFromView(code),
  undo: () => undoRemove(),
  retry: (code) => retryRow(code),
  forget: () => {
    forgetList(storage);
    renderShortlist();
    focusHeading(slView.title);
    say('This device no longer keeps your shortlist. The list in this page\'s link is unchanged.');
  },
});

/** The shortlist worked out now (shortlist.js), every entry at its own semester. */
function worked() {
  return workOut({ list, sem: current.sem, study: current.ng ? current.study : '', answers: rowAnswers, rules: offListRules });
}
/** @param {string} code */
const entry = (code) => worked().entries.find((w) => w.code === code);

/**
 * Units picked in a semester, as the shortlist button, the sentences and the
 * view's settings sentence say them: every tagged pick there whose units have
 * loaded, counted or not (`workOut`'s `picked`).
 * @param {'1' | '2'} sem
 */
const picked = (sem) => worked().sems[sem].picked;
/** Picks in a semester still loading. @param {string} sem */
const loadingIn = (sem) => list.pick.filter((e) => e.sem === sem && !rowAnswers.has(e.code)).length;

/** "Sem 1: 12 units picked", "Sem 1: 12 · Sem 2: 16 units picked" (the shortlist button). */
function buttonLine() {
  const n = entryCount(list);
  if (!n) return 'No courses yet';
  const sems = /** @type {('1' | '2')[]} */ (['1', '2']).filter((s) => list.pick.some((e) => e.sem === s));
  if (!list.pick.length) return `${n} backup${n === 1 ? '' : 's'}, no primary picks yet`;
  if (!sems.length) return `${list.pick.length} pick${list.pick.length === 1 ? '' : 's'}, no semester yet`;
  return `${sems.map((s) => `${semLabel(s)}: ${picked(s)}`).join(' · ')} units picked`;
}

/** Says what an edit did (the live region), and when, so the rows' "done" sentence doesn't overwrite it. @param {string} text */
function say(text) {
  editSaidAt = Date.now();
  announce(text);
}

/** Focuses a heading (tabindex -1) and brings it into view. @param {HTMLElement} el */
function focusHeading(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}
/** The shortlist button the layout shows: the rail's on a wide screen, the phone's under the form. */
const shownOpenButton = () => els.slOpen.find((b) => b.getClientRects().length > 0) ?? els.slOpen[0];

/** Loads every entry's row not yet in, four at a time, through the shared client. */
function ensureRows() {
  for (const e of [...list.pick, ...list.alt]) {
    if (rowAnswers.has(e.code) || rowWanted.has(e.code)) continue;
    rowWanted.add(e.code);
    rowQueue.push(e.code);
  }
  pumpRows();
}
function pumpRows() {
  while (rowsActive < ROWS_AT_ONCE && rowQueue.length) {
    const code = /** @type {string} */ (rowQueue.shift());
    rowsActive += 1;
    modules.get(code).then((outcome) => {
      rowsActive -= 1;
      rowWanted.delete(code);
      rowAnswers.set(code, answerOf(outcome));
      rowSettled.get(code)?.forEach((fn) => fn());
      rowSettled.delete(code);
      // The export question again: a row that answers may exempt its entry.
      if (current.view) updateAsked();
      renderShortlist();
      progressDone();
      exportReady();
      pumpRows();
    });
  }
}
/** Waiters on a row settling (the "added" sentence, Try again). @type {Map<string, (() => void)[]>} */
const rowSettled = new Map();
/** @param {string} code @returns {Promise<void>} */
const whenSettled = (code) => (rowAnswers.has(code) ? Promise.resolve() : new Promise((resolve) => {
  rowSettled.set(code, [...(rowSettled.get(code) ?? []), resolve]);
}));

/** "Loading 12 courses", once, only while the view is shown. */
function progressStart() {
  const waiting = [...list.pick, ...list.alt].filter((e) => !rowAnswers.has(e.code)).length;
  if (!current.view || !waiting || progressSaid) return;
  progressSaid = true;
  announce(`Loading ${waiting} course${waiting === 1 ? '' : 's'}`);
}
/** Once more when done or failed, unless an edit was said in the last second. */
function progressDone() {
  if (!progressSaid || [...list.pick, ...list.alt].some((e) => !rowAnswers.has(e.code))) return;
  progressSaid = false;
  if (!current.view || Date.now() - editSaidAt < 1000) return;
  const all = [...list.pick, ...list.alt];
  const failed = all.filter((e) => rowAnswers.get(e.code)?.kind === 'failed').length;
  const n = all.length - failed;
  announce(`${n} course${n === 1 ? '' : 's'} loaded${failed ? `; ${failed} could not be loaded` : ''}`);
}

/** The year line, the values a link dropped and the settings sentence, under the view's heading. */
function viewLines() {
  const out = [];
  if (viewSentence) out.push(viewSentence);
  const y = yearLine(list.ay, rowYear());
  if (y) out.push(`${y}.`);
  if (droppedOnLoad) out.push(`${droppedOnLoad} value${droppedOnLoad === 1 ? '' : 's'} in the link ${droppedOnLoad === 1 ? 'was' : 'were'} left out: not a course code, repeated, or past the most a list keeps.`);
  return out;
}

/**
 * Draws everything the list shows: the view, the shortlist buttons, every
 * toggle's state, Undo beside the button, and the restore offer.
 */
function renderShortlist() {
  const result = worked();
  const faculties = /** @type {('biz' | 'law')[]} */ (['biz', 'law'].filter((f) => result.entries.some((w) => w.faculty === f)));
  slView.update({
    result, answers: rowAnswers, study: current.ng ? current.study : '', sem: current.sem,
    lines: viewLines(), removed: undoable?.where === 'view' ? undoable.removed.entry.code : '',
    linkField: copyField, said: copySaid, ask: asked, faculties, inv: list.inv, listDate: updated(/offered/i),
    exportLine: exportLine(),
  });
  renderPrint(result);
  const line = buttonLine();
  for (const b of els.slOpen) {
    const small = b.querySelector('small');
    if (small) { if (small.textContent !== line) small.textContent = line; continue; }
    b.replaceChildren(icon('mark-on'), h('span', { class: 'sl-open-t' }, h('b', null, 'Your shortlist'), h('small', { class: 'sl-open-n' }, line)));
  }
  for (const t of /** @type {NodeListOf<HTMLButtonElement>} */ (document.querySelectorAll('button.sl-toggle'))) {
    const on = String(hasEntry(list, t.dataset.sl ?? '') !== '');
    if (t.getAttribute('aria-pressed') !== on) t.setAttribute('aria-pressed', on);
  }
  const cardUndo = undoable?.where === 'card' ? undoable.removed.entry.code : '';
  for (const p of els.slUndo) {
    p.hidden = !cardUndo;
    if (!cardUndo) { setChildren(p); delete p.dataset.code; continue; }
    if (p.dataset.code === cardUndo) continue;
    p.dataset.code = cardUndo;
    const b = h('button', { class: 'linkbtn', attrs: { type: 'button', 'aria-label': `Undo, put ${cardUndo} back` } }, 'Undo');
    b.addEventListener('click', () => undoRemove());
    setChildren(p, `${cardUndo} removed. `, b);
  }
  renderRestore();
}

/** "Restore your last shortlist", when this page's link has no list and the device keeps one. */
function renderRestore() {
  const offer = restoreOffer(list, storage);
  for (const slot of els.slRestore) {
    slot.hidden = !offer;
    if (!offer) { setChildren(slot); continue; }
    const n = entryCount(offer);
    const text = `Your last shortlist is kept on this device (${n} course${n === 1 ? '' : 's'}).`;
    if (slot.firstChild?.textContent === text) continue;
    const b = h('button', { class: 'linkbtn', attrs: { type: 'button' } }, 'Restore your last shortlist');
    b.addEventListener('click', () => restoreSaved());
    setChildren(slot, h('span', null, text), b);
  }
}

/** Writes the device's list, leaves the first screen and opens the view (focus on its heading). */
function restoreSaved() {
  const saved = restoreOffer(list, storage);
  if (!saved) return;
  list = saved;
  undoable = null;
  leftSetup = true;
  writer.replace(pageUrl(current));
  syncView(current);
  ensureRows();
  if (current.view) { renderShortlist(); focusHeading(slView.title); }
  else act({ type: 'openView' });
  const n = entryCount(list);
  say(`Your last shortlist is restored: ${n} course${n === 1 ? '' : 's'}`);
}

/**
 * Applies an edit to the list (list.js): the URL is replaced at once through
 * the writer (coalesced only past its budget), with `ay` from the rows once
 * one has loaded, and the device's copy is written at once. Never calls
 * show(): the search and the history position stay. Ends any Undo on offer;
 * draws the list and loads any row it lacks.
 * @param {(l: import('./list.js').List) => import('./list.js').Edit} fn
 * @returns {{ ok: true } | { ok: false, why: string }} a refusal says why (a full semester)
 */
function editList(fn) {
  const result = fn(list);
  if (!result.ok) return result;
  list = withYear(result.list, rowYear(result.list));
  writer.replace(pageUrl(current));
  saveList(storage, list);
  undoable = null;
  copySaid = '';
  editCount += 1;
  ensureRows();
  renderShortlist();
  return { ok: true };
}

/**
 * A card's or the detail head's toggle: on adds the course as the last pick
 * (its tag from the state's semester, else the one semester it is open or
 * taught in); off removes it from either list, with Undo beside the button.
 * @param {string} code
 */
function toggle(code) {
  const which = hasEntry(list, code);
  if (which) {
    const n = list[which].length;
    const rank = list[which].findIndex((e) => e.code === code) + 1;
    const r = remove(list, code);
    if (!r.ok) return;
    editList(() => ({ ok: true, list: r.list }));
    undoable = { removed: r.removed, where: 'card' };
    renderShortlist();
    say(`${code} removed from your ${which === 'pick' ? 'picks' : 'backups'} (${rank} of ${n}). Undo`);
    return;
  }
  const r = editList((l) => add(l, code, tagFor(current.sem, semsFromResults(code))));
  if (!r.ok) { say(r.why); return; }
  sayAdded(code);
}

/**
 * The semesters (of 1 and 2) a course on screen is open in (exchange mode)
 * or taught in, from its /search result; [] when it isn't on screen.
 * @param {string} code
 */
function semsFromResults(code) {
  const results = Array.isArray(shown?.data?.results) ? shown.data.results : [];
  const m = results.find((/** @type {any} */ x) => String(x?.code ?? '') === code);
  if (!m) return [];
  const filters = shown?.data?.filters ?? {};
  if (filters.ng === true && m.exchangeBySem && typeof m.exchangeBySem === 'object') {
    return [1, 2].filter((s) => m.exchangeBySem[s] && m.exchangeBySem[s].status !== 'closed');
  }
  if (filters.ng === true && m.exchange && (filters.sem === 1 || filters.sem === 2)) return m.exchange.status !== 'closed' ? [filters.sem] : [];
  return (Array.isArray(m.semesters) ? m.semesters : []).map(Number).filter((/** @type {number} */ s) => s === 1 || s === 2);
}

/**
 * "CS2113 added to your picks: Sem 1, 12 units picked so far", once the row
 * settles or after 2 s, whichever is first (cards don't fetch /module): past
 * 2 s, "8 units so far, 1 course still loading". Stands down if another edit
 * came first.
 * @param {string} code
 */
function sayAdded(code) {
  const at = editCount;
  const e = [...list.pick, ...list.alt].find((x) => x.code === code);
  if (!e) return;
  const head = `${code} added to your picks`;
  if (!e.sem) { say(`${head}, with no semester yet: choose one in your shortlist`); return; }
  const sem = e.sem;
  const late = new Promise((resolve) => { setTimeout(() => resolve('late'), 2_000); });
  Promise.race([whenSettled(code).then(() => 'in'), late]).then((how) => {
    if (editCount !== at) return;
    const loading = loadingIn(sem);
    say(how === 'in' || !loading
      ? `${head}: ${semLabel(sem)}, ${picked(sem)} units picked so far`
      : `${head}: ${semLabel(sem)}, ${picked(sem)} units so far, ${loading} course${loading === 1 ? '' : 's'} still loading`);
  });
}

/**
 * The view's Remove: focus goes to the next row's Remove in the same list,
 * else the previous row's; if that list is now empty, its heading; if the
 * whole list is, the view's heading. Undo stands at the top of the view.
 * @param {string} code
 */
function removeFromView(code) {
  const which = hasEntry(list, code);
  if (!which) return;
  const at = list[which].findIndex((e) => e.code === code);
  const sem = list[which][at].sem;
  const r = remove(list, code);
  if (!r.ok) return;
  editList(() => ({ ok: true, list: r.list }));
  undoable = { removed: r.removed, where: 'view' };
  renderShortlist();
  const left = list[which];
  const next = left[at] ?? left[at - 1];
  const target = next ? slView.row(next.code)?.remove : entryCount(list) ? (which === 'pick' ? slView.pickHead : slView.altHead) : slView.title;
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
  say(`${code} removed${sem ? `: ${semLabel(sem)}, ${picked(sem)} units picked` : ''}. Undo is at the top of the list`);
}

/** Undo: the entry back in its list, rank and semester; focus on its row's Remove (or its card's toggle). */
function undoRemove() {
  if (!undoable) return;
  const { removed, where } = undoable;
  const r = editList((l) => restore(l, removed));
  if (!r.ok) { say(r.why); return; }
  const code = removed.entry.code;
  const target = where === 'view' ? slView.row(code)?.remove
    : /** @type {HTMLElement | null} */ (document.querySelector(`#results button.sl-toggle[data-sl="${code}"]`)) ?? shownOpenButton();
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
  say(`${code} is back on your shortlist`);
}

/**
 * Try again on a row that failed: focus goes to its first control, and the
 * live region says how it ended.
 * @param {string} code
 */
function retryRow(code) {
  rowAnswers.delete(code);
  ensureRows();
  renderShortlist();
  const row = slView.row(code);
  row?.up.focus({ preventScroll: true });
  row?.up.scrollIntoView({ block: 'nearest' });
  whenSettled(code).then(() => {
    const a = rowAnswers.get(code);
    const year = worked().year;
    say(a?.kind === 'failed' ? `${code} still could not be loaded`
      : a?.kind === 'unknown' ? `${code}: no course with this code in ${year}`
        : a?.kind === 'catalogue-only' ? `${code}: not offered in ${year}` : `${code} loaded`);
  });
}

/** Copy link: the shortlist link, copied within the click; the link in a field if the browser refuses. */
function copyLink() {
  const link = shortlistLink();
  /** @param {string} said @param {string} fieldText */
  const done = (said, fieldText) => {
    copySaid = said;
    copyField = fieldText;
    renderShortlist();
    if (fieldText) {
      slView.linkInput.focus();
      slView.linkInput.select();
    }
    say(said || 'Copy the shortlist link from the field under the buttons');
  };
  try {
    navigator.clipboard.writeText(link).then(() => done('Link copied', ''), () => done('', link));
  } catch {
    done('', link);
  }
}

/** Every entry's row has settled: loaded, failed or a 404. */
const rowsSettled = () => [...list.pick, ...list.alt].every((e) => rowAnswers.has(e.code));
/** The export question still has something to answer (the view asks it; the exports wait on it). */
const questionOpen = () => exportQuestion({ list, study: current.ng ? current.study : '', answers: rowAnswers }).ask;

/**
 * The export's document now (export.js), from the same rows as the view.
 * The link is the shortlist link at the canonical URL, with `ay` once a row
 * has loaded.
 * @param {import('./shortlist.js').Result} [result]
 */
function exportDoc(result = worked()) {
  const l = withYear(list, rowYear());
  return buildExport({
    result, list: l, study: current.ng ? current.study : '', sources, answers: rowAnswers, today: new Date(),
    link: `${SITE_URL}${shortlistUrl(current, l, '/')}`, yearNote: yearLine(list.ay, rowYear()),
  });
}

/**
 * The print page, built eagerly from the rows while the view is shown, and
 * the print class: on only while the view is shown, every row has
 * settled and the export question is answered or not needed. Derived from
 * state, never set around print(), so Ctrl+P prints the shortlist then, and
 * the screen otherwise.
 * @param {import('./shortlist.js').Result} result
 */
function renderPrint(result) {
  const ready = current.view && entryCount(list) > 0 && rowsSettled() && !questionOpen();
  if (current.view && entryCount(list) > 0) {
    printed = exportDoc(result);
    printView.update(printed);
  }
  document.documentElement.classList.toggle('print-shortlist', !!ready);
}

/** The line the export buttons point to (aria-describedby) after an early press. */
function exportLine() {
  if (!exportWaiting) return '';
  const all = [...list.pick, ...list.alt];
  if (!rowsSettled()) return `Loading ${all.filter((e) => rowAnswers.has(e.code)).length} of ${all.length} courses`;
  return `Ready: press again to ${exportWaiting === 'csv' ? 'download' : 'print'}`;
}
/** Once the rows an early press waited on are in: "Ready: press again …", said once. */
function exportReady() {
  if (!exportWaiting || exportReadySaid || !rowsSettled()) return;
  exportReadySaid = true;
  say(exportLine());
}

/**
 * Download CSV or Print or save as PDF. While the export question has
 * something to answer, either focuses its heading and says so. Before every
 * row is in, the press waits: the button keeps its name, and its line says
 * how far the rows are, then "Ready: press again", so the export starts from
 * the user's own second press (print() and a download need the click).
 * Otherwise the CSV downloads, or the print page prints with the file name
 * as the title. Either writes `ay` into the URL.
 * @param {'csv' | 'print'} kind
 */
function exportPress(kind) {
  if (questionOpen()) {
    if (!slView.asking()) { updateAsked(); renderShortlist(); }
    focusHeading(slView.askTitle);
    const n = (asked.year ? 2 : 0) + asked.entries.length;
    say(askSentence(n));
    return;
  }
  if (!entryCount(list)) { say('Your shortlist is empty: add a course first'); return; }
  if (!rowsSettled()) {
    exportWaiting = kind;
    exportReadySaid = false;
    renderShortlist();
    say(exportLine());
    return;
  }
  exportWaiting = null;
  list = withYear(list, rowYear());
  writer.replace(pageUrl(current));
  writer.flush();
  renderShortlist();
  const doc = printed ?? exportDoc();
  if (kind === 'csv') {
    const name = downloadCsv(doc);
    say(`Downloading ${name}`);
    return;
  }
  document.title = doc.stem;
  window.print();
}

/**
 * Downloads the CSV: a Blob and an `<a download>`, its URL revoked a minute
 * later (revoking at once can cancel the download).
 * @param {import('./export.js').Doc} doc
 */
function downloadCsv(doc) {
  const name = fileName(doc, 'csv');
  const url = URL.createObjectURL(new Blob([toCsv(doc)], { type: 'text/csv;charset=utf-8' }));
  const a = h('a', { attrs: { href: url, download: name } });
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return name;
}

// A print the browser starts itself (Ctrl+P) prints the shortlist only when the print class is
// on; then its title is the file name. `afterprint` only restores the title.
window.addEventListener('beforeprint', () => {
  if (printed && document.documentElement.classList.contains('print-shortlist')) document.title = printed.stem;
});
window.addEventListener('afterprint', () => { document.title = pageTitle; });

/** The print fonts load when the view opens, so a print right after has them. */
function loadPrintFonts() {
  if (!document.fonts) return;
  for (const face of ['400 1em "IBM Plex Sans"', '500 1em "IBM Plex Sans"', '600 1em "IBM Plex Sans"', '400 1em "IBM Plex Mono"', '500 1em "IBM Plex Mono"']) {
    document.fonts.load(face).catch(() => {});
  }
}

/** The export question's parts, kept once asked while the view stays open. */
function updateAsked() {
  const q = exportQuestion({ list, study: current.ng ? current.study : '', answers: rowAnswers });
  asked = {
    year: asked.year || q.year,
    // Parts asked stay while the view does (an answered one keeps its choice), unless the entry
    // left the list or its row, now in, shows it can't take a semester.
    entries: [...new Set([...asked.entries, ...q.entries])].filter((c) => hasEntry(list, c) && askable(rowAnswers.get(c))),
  };
}

/** The view is shown (opened, or Back or Forward into it): drawn, its rows loading, focus on its heading. */
function enterView() {
  asked = { year: false, entries: [] };
  exportWaiting = null;
  loadPrintFonts();
  viewSentence = '';
  copySaid = '';
  copyField = '';
  updateAsked();
  ensureRows();
  renderShortlist();
  focusHeading(slView.title);
  progressStart();
}
/** The view closed by its button, Escape or Back: focus on the shortlist button that is displayed. */
function leaveView() {
  viewClosed();
  shownOpenButton().focus();
}
/** The view closed by a submit or a code link: its own state goes; focus is the search's. */
function viewClosed() {
  asked = { year: false, entries: [] };
  exportWaiting = null;
  viewSentence = '';
  copySaid = '';
  copyField = '';
  progressSaid = false;
  renderShortlist();
}
/** A settings change while the view is shown: the view's sentence, said ("Sem 2 first: …"). */
function settingsInView() {
  updateAsked();
  viewSentence = summary(worked());
  renderShortlist();
  say(viewSentence);
}
/** Closes the view: back() when this page pushed it and nothing changed since, else replace. */
function closeView() {
  const data = writer.state();
  act({ type: 'closeView', viewPushed: data?.vnmShortlist === true, atOpen: typeof data?.atOpen === 'string' ? data.atOpen : '' });
}

// The shortlist buttons open the view; pressed while it is shown, they focus its heading (no history write).
for (const b of els.slOpen) {
  b.addEventListener('click', () => {
    if (current.view) { focusHeading(slView.title); return; }
    act({ type: 'openView' });
  });
}
// Every toggle, on a card or in a detail head.
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target.closest('button.sl-toggle') : null;
  if (t instanceof HTMLButtonElement && t.dataset.sl) toggle(t.dataset.sl);
});

/** Copy link's URL, `ay` once a row has loaded; never waits. */
function shortlistLink() {
  writer.flush();
  return `${location.origin}${shortlistUrl(current, withYear(list, rowYear()), location.pathname)}`;
}

// A coalesced write still pending lands before the page is hidden or left.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writer.flush(); });
window.addEventListener('pagehide', () => writer.flush());

// The specs read what the page holds, and drive the list directly where a
// test needs many edits fast. Installed only when a spec sets `vnmTest` first.
if (testHooks && typeof testHooks === 'object') {
  Object.assign(testHooks, {
    list: () => list,
    droppedOnLoad,
    rowYear: () => rowYear(),
    edit: {
      add: (/** @type {string} */ code, /** @type {import('./list.js').Tag} */ sem = '') => editList((l) => add(l, code, sem)),
      remove: (/** @type {string} */ code) => editList((l) => remove(l, code)),
      move: (/** @type {string} */ code, /** @type {-1 | 1} */ dir) => editList((l) => move(l, code, dir)),
      makeOther: (/** @type {string} */ code) => editList((l) => makeOther(l, code)),
      setSem: (/** @type {string} */ code, /** @type {import('./list.js').Tag} */ sem) => editList((l) => setSem(l, code, sem)),
      setInvite: (/** @type {import('./list.js').Invite} */ which, /** @type {boolean} */ on) => editList((l) => setInvite(l, which, on)),
    },
    loadRow: (/** @type {string} */ code) => modules.get(code),
    shortlistLink,
    restoreOffer: () => restoreOffer(list, storage),
    forget: () => forgetList(storage),
    pending: () => writer.pending(),
  });
}

// The first screen pre-fills the year of study remembered on this device.
if (STUDIES.some((o) => o.value === savedStudy())) checkValue('setupStudy', savedStudy());

// Start: the URL's state, and its search, now; the list's rows load at once, and a link
// that opens on the view says their progress.
current = settle(current);
ensureRows();
renderShortlist();
if (current.view) { updateAsked(); renderShortlist(); progressStart(); loadPrintFonts(); }
show(current);
