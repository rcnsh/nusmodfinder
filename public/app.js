// @ts-check
// The page's controller (Phase 5 5B, 5C): reads the URL into state, keeps the
// form and the URL in step through nav.js's transitions, searches through
// api.js, and renders with render.js. 5C adds the cards' disclosure (one open
// detail, `open=`), the detail from /module/:code, why typed codes are hidden,
// and the partial-code check of the other semester. The look is 5D's.
import { createModuleClient, createSearchClient, fetchFacets, fetchSearch } from './api.js';
import { detailError, detailLoading, renderDetail } from './detail.js';
import { h, setChildren } from './dom.js';
import { hiddenCodeLine } from './explain.js';
import { intentChipRow } from './intent-chips.js';
import { isCloseEscape, isSubmitEnter } from './keys.js';
import { errorSentence } from './messages.js';
import { transition } from './nav.js';
import { settlePartial, showLoading, showMessage, showResults } from './render.js';
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
const searchHref = (code) => urlFor({ ...current, q: code, ignore: [], open: '' }, location.pathname);

/**
 * Fills a card's detail from /module/:code (fetched once per page).
 * @param {string} code
 * @param {HTMLElement} region
 */
async function loadDetail(code, region) {
  if (!shown) return;
  const { data } = shown;
  detailLoading(region);
  const outcome = await modules.get(code);
  if (region.hidden || !region.isConnected) return;
  if (outcome.kind !== 'ok') {
    detailError(region, outcome.kind === 'error' ? errorSentence(outcome.error) : '', () => loadDetail(code, region));
    return;
  }
  renderDetail(region, outcome.body, { filters: data.filters ?? {}, sources, searchHref, onClose: () => act({ type: 'close' }) });
}

/**
 * Opens the state's detail and closes every other (at most one, A2-4).
 * `focusCode`: return focus to that card's button (a detail just closed).
 * @param {State} s
 * @param {string} [focusCode]
 */
function syncDetail(s, focusCode = '') {
  if (!shown) return;
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

/** Says why each hidden typed code isn't shown, from its own stored reasons (D4). */
function explainHidden() {
  if (!shown) return;
  const { data, view } = shown;
  const filters = data.filters ?? {};
  for (const [code, li] of view.hidden) {
    modules.get(code).then((outcome) => {
      if (!li.isConnected) return;
      if (outcome.kind !== 'ok') { setChildren(li, `${code} isn't shown with these settings. Why could not be checked just now.`); return; }
      setChildren(li, hiddenCodeLine({
        code, sem: filters.sem === undefined ? '' : String(filters.sem), study: filters.ng === true ? String(filters.study ?? '') : '',
        exchange: outcome.body.exchange, sources, module: outcome.body, filters,
      }));
    });
  }
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
  settlePartial(p, has, () => {
    els.sem.value = other;
    act({ type: 'settings', form: readForm() });
  });
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
  shown = { key, data: body, view: showResults(targets, body, { searchHref }) };
  showIntentChips(body);
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
 * takes focus.
 * @param {State} s
 * @param {{ fromUser?: boolean }} [opts]
 */
async function show(s, { fromUser = false } = {}) {
  const params = searchParams(s);
  if (!params) {
    shown = null;
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
  // The same answer is on screen (a detail opened or closed, or Back to it):
  // only the detail changes, so focus and the scroll position stay.
  if (shown && shown.key === key) {
    search.abort();
    els.go.disabled = false;
    syncDetail(s);
    return;
  }
  if (answers.has(key)) {
    search.abort();
    els.go.disabled = false;
    render(s, key, answers.get(key));
    return;
  }
  shown = null;
  els.go.disabled = true;
  showLoading(targets);
  const outcome = await search(params);
  if (outcome.kind === 'superseded') return;
  els.go.disabled = false;
  if (outcome.kind === 'error') {
    showMessage(targets, errorSentence(outcome.error), true);
    return;
  }
  remember(key, outcome.body);
  render(s, key, outcome.body);
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
  const closing = action.type === 'close' ? current.open : '';
  current = state;
  applyToForm(state);
  show(state, { fromUser: true });
  // Closed by replace: focus goes back to the card's button (closed by back(), popstate does it).
  if (closing) shown?.view.cards.get(closing)?.button.focus();
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
  if (isCloseEscape(e) && current.open) act({ type: 'close' });
});
// A card's button opens its detail, or closes it (the APG disclosure pattern).
els.results.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('button.card-toggle') : null;
  if (!(button instanceof HTMLButtonElement)) return;
  act(button.getAttribute('aria-expanded') === 'true' ? { type: 'close' } : { type: 'open', code: button.dataset.code ?? '' });
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
window.addEventListener('popstate', async () => {
  const before = current.open;
  current = settle(parseState(new URLSearchParams(location.search)));
  const after = current;
  await show(after);
  // Back from an open detail: the list, its detail closed, focus on its button.
  if (before && !after.open && current === after) shown?.view.cards.get(before)?.button.focus();
});

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
      if (!region.hidden && !region.contains(document.activeElement)) loadDetail(code, region);
    }
  }
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
  const list = sources ?? [];
  if (list.length) {
    setChildren(els.sources, 'Sources: ', ...list.flatMap((/** @type {any} */ x, /** @type {number} */ i) => [
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
