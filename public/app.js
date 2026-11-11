// @ts-check
// The page's controller (Phase 5 5B, 5C): reads the URL into state, keeps the
// form and the URL in step through nav.js's transitions, searches through
// api.js, and renders with render.js. 5C adds the cards' disclosure (one open
// detail, `open=`), the detail from /module/:code, why typed codes are hidden,
// and the partial-code check of the other semester. 5D lays it out as direction
// D: the exchange set-up as the first screen (D2), then a rail with the set-up,
// filters and key beside the search; removable filter chips; and on a phone
// one search bar with the rail in a modal "Filters" dialog (F10). 5E (F5,
// SC8): a skip link to the shown <main>; one polite live region that says each
// answer in a sentence (the count or why there is none, the typed codes not
// shown, errors and 429); the Search button is never disabled, so it keeps
// focus, and a second search aborts the first; Escape closes the open detail
// and focus returns to its button, as it does after Back to an open detail.
// 5G: an "Also as" code is a link to its own search with its detail open
// ("Opened from …", `from=`); a hidden typed code carries a stamp, and a
// "Switch to Sem 2" button when the other semester is open to the student.
import { createModuleClient, createSearchClient, fetchFacets, fetchSearch } from './api.js';
import { detailError, detailLoading, renderDetail } from './detail.js';
import { h, setChildren } from './dom.js';
import { hiddenCodeLine, hiddenCodeStamp } from './explain.js';
import { semLabel } from './format.js';
import { icon } from './icons.js';
import { intentChipRow } from './intent-chips.js';
import { intentChips } from './intents.js';
import { isCloseEscape, isSubmitEnter } from './keys.js';
import { errorSentence } from './messages.js';
import { transition } from './nav.js';
import { hiddenStamp, settlePartial, showLoading, showMessage, showResults } from './render.js';
import { CREDITS, LEVELS, SEMESTERS, STUDIES, levelLabel, parseState, searchParams, unitsLabel, urlFor } from './state.js';

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

/**
 * A message in the status area with no results, said in the live region too.
 * @param {string} text
 * @param {boolean} [error]
 */
function message(text, error = false) {
  showMessage(targets, text, error);
  announce(text);
}

// Static option lists (F4): every filter but faculty works before /facets answers.
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
// The first screen's two questions (D2).
for (const [value, name, months] of [['1', 'Sem 1', 'Aug–Dec 2026'], ['2', 'Sem 2', 'Jan–May 2027'], ['', 'Both semesters', 'Aug 2026–May 2027']]) {
  els.setupSems.append(radio('tile', 'setupSem', value, [h('b', null, name), h('small', null, months), icon('tick', 'tick')]));
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

/** @param {State} s */
function applyToForm(s) {
  els.q.value = s.q;
  selectValue(els.sem, s.sem);
  selectValue(els.level, s.level, levelLabel(s.level));
  selectValue(els.credits, s.credits, unitsLabel(s.credits));
  selectValue(els.faculty, s.faculty);
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
 * The first screen (the exchange set-up, D2) shows until the student searches
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
  if (s.faculty) out.push({ key: 'faculty', label: s.faculty, removable: true });
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

/** @returns {State} what the controls show; ignore, open, pick and alt are the URL's */
function readForm() {
  return {
    q: els.q.value, sem: els.sem.value, level: els.level.value, credits: els.credits.value, faculty: els.faculty.value,
    ng: els.ng.checked, study: els.ng.checked ? els.study.value : '',
    ignore: current.ignore, open: current.open, from: current.from, pick: current.pick, alt: current.alt,
  };
}

const search = createSearchClient();
/** Answers already shown, by /search query string, so Back re-renders without a fetch (F3). */
const answers = new Map();
const ANSWERS_KEPT = 50;
const targets = { status: els.status, results: els.results };
const modules = createModuleClient();

/** The exchange-mode sources and their dates, once /facets answers (null until then, or for good if it fails). */
/** @type {import('./explain.js').Source[] | null} */
let sources = null;
/**
 * The answer on screen, its /search key, and the cards render.js built for it.
 * @type {{ key: string, data: any, view: import('./render.js').Rendered } | null}
 */
let shown = null;

/** A link to the search for a course code, keeping the filters and exchange set-up. @param {string} code */
const searchHref = (code) => urlFor({ ...current, q: code, ignore: [], open: '', from: '' }, location.pathname);
/** An "Also as" link: the other code's search, its detail open, from the entry. @param {string} code @param {string} from */
const variantHref = (code, from) => urlFor({ ...current, q: code, ignore: [], open: code, from }, location.pathname);

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
    if (!quiet) announce(`The details of ${code} could not be loaded. ${sentence}`.trim());
    return;
  }
  renderDetail(region, outcome.body, {
    filters: data.filters ?? {}, sources, searchHref, onClose: () => act({ type: 'close' }), from: code === current.open ? current.from : '',
  });
}

/**
 * `from=` makes the detail say the open course and that code are one course
 * (5G S1): it stands only when the code is one of the open entry's own other
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
    history.replaceState(history.state, '', urlFor(fixed, location.pathname));
  }
  return fixed;
}

/**
 * Opens the state's detail and closes every other (at most one, A2-4).
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
  announce([shown.view.announce, read.length ? `Read from your query: ${read.join(', ')}.` : ''].filter(Boolean).join(' '));
}

/**
 * Says why each hidden typed code isn't shown, from its own stored reasons
 * (D4), under a stamp; where the other semester is open to the student, a
 * button switches to it (5G, direction D).
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
 * results? The button to see it appears only if it does (C3-2).
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
  if (see || p.line.textContent !== before) announce([p.line.textContent, see ? `The “${see.textContent}” button shows them.` : ''].filter(Boolean).join(' '));
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
  shown = { key, data: body, view: showResults(targets, body, { searchHref, variantHref, removableFilters: removableFilters(), query: s.q }) };
  showIntentChips(body);
  announceAnswer();
  syncDetail(s);
  explainHidden();
  checkOtherSemester(s);
}

/**
 * The chips for the phrases /search read from the query (5F); removing one
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
      if (fromUser) setTimeout(() => els.study.focus(), 0);
    } else if (leftSetup) {
      message(EMPTY);
    } else {
      // The first screen asks its own questions; "the box above" is the results view's.
      showMessage(targets, EMPTY);
      announce('');
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
  // The Search button stays enabled (5E, F5): disabling the focused button
  // would drop focus to the page, and a second search aborts this one anyway.
  shown = null;
  showLoading(targets);
  announce('');
  const outcome = await search(params);
  if (outcome.kind === 'superseded') return;
  if (outcome.kind === 'error') {
    message(errorSentence(outcome.error), true);
    return;
  }
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
  const detailPushed = history.state?.vnmDetail === true;
  const { state, op } = transition(current, action, { detailPushed });
  if (op === 'none') return;
  // popstate restores the list entry, and its state, after back().
  if (op === 'back') { history.back(); return; }
  const url = urlFor(state, location.pathname);
  if (op === 'push') history.pushState(action.type === 'open' ? { vnmDetail: true } : null, '', url);
  else history.replaceState(action.type === 'open' ? history.state : null, '', url);
  const closing = action.type === 'close' ? current.open : '';
  current = state;
  applyToForm(state);
  const done = show(state, { fromUser: true, submitted: action.type === 'submit' });
  // Closed by replace: focus goes back to the card's button (closed by back(), popstate does it).
  if (closing) shown?.view.cards.get(closing)?.button.focus();
  await done;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  act({ type: 'submit', form: readForm() });
});
// Enter is bound explicitly so the primary interaction never depends on
// implicit form submission, and so it can wait for IME composition (F9).
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

// The first screen: the semester and the year of study, then the query (D2).
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
  if (!study) { setupAsk('Choose your year of study at your home university.', radios('setupStudy')[0]); return; }
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

// On a phone the rail is a modal dialog behind "Filters (n)" (F10): its panel
// moves into the dialog while it is open, so there is one set of controls.
// The browser's modal dialog keeps the rest of the page inert and closes on
// Escape; focus also wraps inside it, and returns to the button on close.
const rail = /** @type {HTMLElement} */ (els.panel.parentElement);
// The live region goes into the dialog too while it is open: a modal dialog
// makes the rest of the page inert, the header's live region included, so a
// change made in the dialog would be said to no one (5E).
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
  if (!isCloseEscape(e) || !current.open || els.dialog.open) return;
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
// saying where it came from (5G). Focus goes to that entry's button, which
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
// view (5E).
history.scrollRestoration = 'manual';
window.addEventListener('popstate', async () => {
  const before = current.open;
  const answerBefore = shown?.key;
  current = settle(parseState(new URLSearchParams(location.search)));
  const after = current;
  await show(after);
  if (current !== after) return;
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
// on it (F4): the first search starts below, at once, and a shared link's
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
  // A link's faculty that /facets doesn't list is no faculty (5G S2): it would
  // only stand as a chip in the site's voice over no results. Drop it, and its
  // option, and search without it (a settings change: replace).
  if (names.length) {
    for (const o of [...els.faculty.options]) if (o.value && !names.includes(o.value)) o.remove();
    if (current.faculty && !names.includes(current.faculty)) {
      els.faculty.value = '';
      act({ type: 'settings', form: { ...readForm(), q: current.q, faculty: '' } });
    }
  }
  if (f.ng) {
    els.ngHint.textContent = f.ng.count
      ? `${f.ng.count} courses on the NUS Registrar's list${f.ng.updatedAsAt ? `, updated ${f.ng.updatedAsAt}` : ''}.`
      : 'The NG list could not be loaded. Reload the page to try again.';
  }
  if (sources) renderSources();
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
  const canonical = urlFor(settled, location.pathname);
  if (canonical !== `${location.pathname}${location.search}`) history.replaceState(history.state, '', canonical);
  return settled;
}

// The first screen pre-fills the year of study remembered on this device.
if (STUDIES.some((o) => o.value === savedStudy())) checkValue('setupStudy', savedStudy());

// Start: the URL's state, and its search, now.
current = settle(current);
show(current);
