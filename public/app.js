// @ts-check
// The page's controller (Phase 5 5B): reads the URL into state, keeps the form
// and the URL in step through nav.js's transitions, searches through api.js,
// and renders with render.js. The look and the cards are the Phase 4 page's;
// 5C and 5D change them.
import { createSearchClient, fetchFacets } from './api.js';
import { h, setChildren } from './dom.js';
import { isSubmitEnter } from './keys.js';
import { errorSentence } from './messages.js';
import { transition } from './nav.js';
import { showLoading, showMessage, showResults } from './render.js';
import { CREDITS, LEVELS, SEMESTERS, STUDIES, parseState, searchParams, urlFor } from './state.js';

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
  go: /** @type {HTMLButtonElement} */ ($('go')),
  sem: /** @type {HTMLSelectElement} */ ($('sem')),
  level: /** @type {HTMLSelectElement} */ ($('level')),
  credits: /** @type {HTMLSelectElement} */ ($('credits')),
  faculty: /** @type {HTMLSelectElement} */ ($('faculty')),
  ng: /** @type {HTMLInputElement} */ ($('ng')),
  study: /** @type {HTMLSelectElement} */ ($('study')),
  studyWrap: $('studyWrap'),
  ngHint: $('ngHint'),
  sources: $('sources'),
  status: $('status'),
  results: $('results'),
};

// Static option lists (F4): every filter but faculty works before /facets answers.
for (const o of SEMESTERS) els.sem.add(new Option(o.label, o.value));
for (const o of LEVELS) els.level.add(new Option(o.label, o.value));
for (const c of CREDITS) els.credits.add(new Option(c, c));
for (const o of STUDIES) els.study.add(new Option(o.label, o.value));

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

function syncExchange() {
  els.studyWrap.hidden = !els.ng.checked;
  els.sources.hidden = !els.ng.checked || !els.sources.hasChildNodes();
}

/** The state of the current history entry; the URL always says the same. */
let current = parseState(new URLSearchParams(location.search));

/** @param {State} s */
function applyToForm(s) {
  els.q.value = s.q;
  selectValue(els.sem, s.sem);
  selectValue(els.level, s.level, `${s.level}000`);
  selectValue(els.credits, s.credits);
  selectValue(els.faculty, s.faculty);
  els.ng.checked = s.ng;
  if (s.study) els.study.value = s.study;
  else if (!els.study.value) {
    const saved = savedStudy();
    if (STUDIES.some((o) => o.value === saved)) els.study.value = saved;
  }
  syncExchange();
}

/** @returns {State} what the controls show; ignore, open, pick and alt are the URL's */
function readForm() {
  return {
    q: els.q.value, sem: els.sem.value, level: els.level.value, credits: els.credits.value, faculty: els.faculty.value,
    ng: els.ng.checked, study: els.ng.checked ? els.study.value : '',
    ignore: current.ignore, open: current.open, pick: current.pick, alt: current.alt,
  };
}

const search = createSearchClient();
/** Answers already shown, by /search query string, so Back re-renders without a fetch (F3). */
const answers = new Map();
const ANSWERS_KEPT = 50;
const targets = { status: els.status, results: els.results };

/**
 * Renders a state: from memory when this page has shown it before, else by
 * searching. `fromUser`: the student just acted, so a missing year of study
 * takes focus.
 * @param {State} s
 * @param {{ fromUser?: boolean }} [opts]
 */
async function show(s, { fromUser = false } = {}) {
  const params = searchParams(s);
  if (!params) {
    search.abort();
    els.go.disabled = false;
    if (s.q.trim() && s.ng && !s.study) {
      showMessage(targets, 'Choose your year of study to see the courses open to you as an exchange student.');
      // After the event, not during it: a click on the exchange switch's label
      // runs this inside the label's activation, and WebKit then focuses the
      // checkbox itself where checkboxes take focus on click (Linux), which
      // would undo a focus moved here.
      if (fromUser) setTimeout(() => els.study.focus(), 0);
    } else {
      showMessage(targets, 'Type a query to begin.');
    }
    return;
  }
  const key = params.toString();
  if (answers.has(key)) {
    search.abort();
    els.go.disabled = false;
    showResults(targets, answers.get(key));
    return;
  }
  els.go.disabled = true;
  showLoading(targets);
  const outcome = await search(params);
  if (outcome.kind === 'superseded') return;
  els.go.disabled = false;
  if (outcome.kind === 'error') {
    showMessage(targets, errorSentence(outcome.error), true);
    return;
  }
  answers.set(key, outcome.body);
  if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
  showResults(targets, outcome.body);
}

/**
 * Applies a user action: the transition's history op, then the render.
 * @param {import('./nav.js').Action} action
 */
function act(action) {
  const detailPushed = history.state?.vnmDetail === true;
  const { state, op } = transition(current, action, { detailPushed });
  if (op === 'none') return;
  // popstate restores the list entry, and its state, after back().
  if (op === 'back') { history.back(); return; }
  const url = urlFor(state, location.pathname);
  if (op === 'push') history.pushState(action.type === 'open' ? { vnmDetail: true } : null, '', url);
  else history.replaceState(action.type === 'open' ? history.state : null, '', url);
  current = state;
  applyToForm(state);
  show(state, { fromUser: true });
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  act({ type: 'submit', form: readForm() });
});
// Enter is bound explicitly so the primary interaction never depends on
// implicit form submission, and so it can wait for IME composition (F9).
els.q.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // Safari reports the keydown that ends a composition as keyCode 229 after
  // compositionend: swallow it so the form doesn't submit on its own either.
  if (!e.isComposing && e.keyCode === 229) { e.preventDefault(); return; }
  if (!isSubmitEnter(e)) return;
  e.preventDefault();
  act({ type: 'submit', form: readForm() });
});
for (const el of [els.sem, els.level, els.credits, els.faculty, els.ng, els.study]) {
  el.addEventListener('change', () => {
    if (el === els.study) saveStudy(els.study.value);
    syncExchange();
    act({ type: 'settings', form: readForm() });
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && current.open) act({ type: 'close' });
});
window.addEventListener('popstate', () => {
  current = settle(parseState(new URLSearchParams(location.search)));
  show(current);
});

// /facets fills the faculty list and the exchange-mode sources. Nothing waits
// on it (F4): the first search starts below, at once, and a shared link's
// faculty is already an option.
fetchFacets().then((f) => {
  if (!f) return;
  for (const x of Array.isArray(f.faculties) ? f.faculties : []) {
    const name = String(x?.name ?? '');
    if (!name) continue;
    const label = `${name} (${Number(x.count) || 0})`;
    const existing = [...els.faculty.options].find((o) => o.value === name);
    if (existing) existing.text = label;
    else els.faculty.add(new Option(label, name));
  }
  if (f.ng) {
    els.ngHint.textContent = f.ng.count
      ? ` — ${f.ng.count} courses, NUS Registrar list${f.ng.updatedAsAt ? `, ${f.ng.updatedAsAt}` : ''}`
      : ' — list not loaded';
  }
  const sources = Array.isArray(f.ngSources) ? f.ngSources : [];
  if (sources.length) {
    setChildren(els.sources, 'Sources: ', ...sources.flatMap((/** @type {any} */ x, /** @type {number} */ i) => [
      i ? '; ' : null,
      /^https?:\/\//i.test(String(x?.url)) ? h('a', { attrs: { href: String(x.url), target: '_blank', rel: 'noopener' } }, String(x.name ?? '')) : String(x?.name ?? ''),
      ` (updated ${String(x?.updatedAsAt ?? '')})`,
    ]), '. Check with NUS before you register.');
    syncExchange();
  }
});

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
  const canonical = urlFor(settled, location.pathname);
  if (canonical !== `${location.pathname}${location.search}`) history.replaceState(history.state, '', canonical);
  return settled;
}

// Start: the URL's state, and its search, now.
current = settle(current);
if (current.q.trim()) show(current);
