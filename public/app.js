// @ts-check
import { createModuleClient, createSearchClient, fetchFacets, fetchSearch } from './api.js';
import { combobox, pillGroup } from './choice.js';
import { detailError, detailLoading, renderDetail } from './detail.js';
import { h, setChildren } from './dom.js';
import { echoHas, hiddenCodeLine, hiddenCodeStamp } from './explain.js';
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
import { CREDITS, LEVELS, SEMESTERS, STUDIES, levelLabel, listValues, parseState, searchParams, shortlistUrl, unitsLabel, urlFor } from './state.js';
import { DEFAULT_ACAD_YEAR, headerYearLine, semesterMonths } from './year.js';

/** @typedef {import('./state.js').State} State */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @returns {T}
 */
const $ = (id) => /** @type {T} */ (document.getElementById(id));
/** @param {string} v */
const levelPill = (v) => [h('span', { class: 'vh' }, 'Level '), `${v}000`];
/** @param {string} v */
const unitsPill = (v) => [v, h('span', { class: 'vh' }, v === '1' ? ' unit' : ' units')];

const els = {
  form: /** @type {HTMLFormElement} */ ($('f')),
  q: /** @type {HTMLInputElement} */ ($('q')),
  sem: pillGroup($('semWrap'), 'sem', [{ value: '', label: 'Any' }, ...SEMESTERS], { seg: 3 }),
  level: pillGroup($('levelWrap'), 'level', [{ value: '', label: 'Any' }, ...LEVELS.map((o) => ({ value: o.value, label: levelPill(o.value) }))], { multi: true }),
  credits: pillGroup($('creditsWrap'), 'credits', [{ value: '', label: 'Any' }, ...CREDITS.map((c) => ({ value: c, label: unitsPill(c) }))], { multi: true }),
  faculty: combobox($('facultyWrap'), 'faculty', { value: '', label: 'Any faculty' }),
  ng: /** @type {HTMLInputElement} */ ($('ng')),
  ngOff: /** @type {HTMLInputElement} */ ($('ngOff')),
  study: pillGroup($('studyWrap'), 'study', [...STUDIES]),
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
  setupWhos: $('setupWhos'),
  setupSemStep: $('setupSemStep'),
  setupStudyStep: $('setupStudyStep'),
  setupQNum: $('setupQNum'),
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

/** @type {ReturnType<typeof setTimeout> | undefined} */
let liveTimer;
/** @param {string} text */
function announce(text) {
  clearTimeout(liveTimer);
  if (text && els.live.textContent === text) {
    els.live.textContent = '';
    liveTimer = setTimeout(() => { els.live.textContent = text; }, 150);
  } else {
    els.live.textContent = text;
  }
}

let editSaidAt = 0;
/** @param {string} text */
function resultsSay(text) {
  if (!current.view) announce(text);
}

/**
 * @param {string} text
 * @param {boolean} [error]
 */
function message(text, error = false) {
  showMessage(targets, text, error);
  resultsSay(text);
}

els.filtersBtn.prepend(icon('filter'));

/**
 * @param {string} cls
 * @param {string} name
 * @param {string} value
 * @param {import('./dom.js').Child[]} content
 */
const radio = (cls, name, value, content) => {
  const input = h('input', { attrs: { type: 'radio', name, value } });
  return h('label', { class: cls }, input, ...content);
};

for (const [value, label] of [['1', 'Sem 1'], ['2', 'Sem 2'], ['', 'Both']]) els.semSegOptions.append(radio('seg-opt', 'xsem', value, [label]));
setChildren($('yearLine'), headerYearLine(DEFAULT_ACAD_YEAR));
for (const [value, name, what] of [['nus', 'NUS student', 'Every NUS course'], ['exchange', 'Exchange student', 'Only the courses open to exchange students']]) {
  els.setupWhos.append(radio('tile', 'setupWho', value, [h('b', null, name), h('small', null, what), icon('tick', 'tick')]));
}
const months = semesterMonths(DEFAULT_ACAD_YEAR);
for (const [value, name, when] of [['1', 'Sem 1', months[1]], ['2', 'Sem 2', months[2]], ['', 'Both semesters', months.both]]) {
  els.setupSems.append(radio('tile', 'setupSem', value, [h('b', null, name), h('small', null, when), icon('tick', 'tick')]));
}
for (const o of STUDIES) els.setupStudies.append(radio('pill', 'setupStudy', o.value, [icon('tick', 'tick'), o.label]));

/** @param {string} name @returns {HTMLInputElement[]} */
const radios = (name) => /** @type {HTMLInputElement[]} */ ([...document.querySelectorAll(`input[type="radio"][name="${name}"]`)]);
/**
 * @param {string} name
 * @returns {string | null}
 */
const checkedValue = (name) => radios(name).find((r) => r.checked)?.value ?? null;
/** @param {string} name @param {string | null} value */
const checkValue = (name, value) => { for (const r of radios(name)) r.checked = value !== null && r.value === value; };

/** @type {Set<string> | null} */
let facultyNames = null;

const STUDY_KEY = 'vnm.study';
const savedStudy = () => { try { return localStorage.getItem(STUDY_KEY) ?? ''; } catch { return ''; } };
const saveStudy = (/** @type {string} */ v) => { try { localStorage.setItem(STUDY_KEY, v); } catch {} };
const WHO_KEY = 'vnm.who';
const savedWho = () => {
  try {
    const who = localStorage.getItem(WHO_KEY);
    if (who === 'exchange' || who === 'nus') return who;
    return localStorage.getItem(STUDY_KEY) ? 'exchange' : 'nus';
  } catch { return 'nus'; }
};
const saveWho = (/** @type {string} */ v) => { try { localStorage.setItem(WHO_KEY, v); } catch {} };

/**
 * @param {import('./choice.js').Choice} choice
 * @param {string} value
 * @param {string | import('./dom.js').Child[] | ((one: string) => string | import('./dom.js').Child[])} [label]
 */
function selectValue(choice, value, label = value) {
  choice.ensure(value, label);
  choice.value = value;
}

function syncExchange() {
  const ng = els.ng.checked;
  const special = els.sem.value === '3' || els.sem.value === '4';
  els.ngOff.checked = !ng;
  els.ngHint.hidden = !ng;
  els.studyWrap.hidden = !ng;
  els.semSeg.hidden = !ng || special;
  els.semWrap.hidden = ng && !special;
  checkValue('xsem', ng && !special ? els.sem.value : null);
  els.key.closest('section')?.toggleAttribute('hidden', !ng);
}

const EMPTY = 'Type what you want to study in the box above, then press Search.';

let current = parseState(new URLSearchParams(location.search));

const loaded = parseList(new URLSearchParams(location.search));
let list = loaded.list;
const droppedOnLoad = loaded.dropped;
/** @type {Map<string, string>} */
const rowYears = new Map();
/** @param {import('./list.js').List} [l] */
const rowYear = (l = list) => {
  for (const e of [...l.pick, ...l.alt]) {
    const y = rowYears.get(e.code);
    if (y) return y;
  }
  return '';
};

const testHooks = /** @type {any} */ (globalThis).vnmTest;
const writer = createWriter({ history, forceCoalesce: testHooks?.forceCoalesce === true });
/** @param {State} s */
const pageUrl = (s) => urlFor(s, list, location.pathname);

const storage = (() => { try { return localStorage; } catch { return null; } })();

/** @type {string | null} */
let viewQ = null;

/** @param {State} s */
function applyToForm(s) {
  const keepBox = viewQ !== null && (s.view !== '' || els.q.value !== viewQ);
  if (!keepBox) els.q.value = s.q;
  selectValue(els.sem, s.sem);
  selectValue(els.level, s.level, levelPill);
  selectValue(els.credits, s.credits, unitsPill);
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

let leftSetup = location.search !== '';
delete document.documentElement.dataset.view;

/** @param {State} s */
function syncView(s) {
  const setup = !leftSetup && !s.q.trim();
  els.app.dataset.view = setup ? 'setup' : 'results';
  els.setup.hidden = !setup;
  els.layout.hidden = setup;
  els.skip.href = setup ? '#setup' : '#main';
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

els.skip.addEventListener('click', (e) => {
  e.preventDefault();
  document.getElementById(els.skip.hash.slice(1))?.focus();
});

/**
 * @param {State} s
 * @returns {{ key: string, value?: string, label: string, removable: boolean }[]}
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
  for (const v of listValues(s.level)) out.push({ key: 'level', value: v, label: levelLabel(v), removable: true });
  for (const v of listValues(s.credits)) out.push({ key: 'credits', value: v, label: unitsLabel(v), removable: true });
  if (s.faculty) out.push({ key: 'faculty', label: facultyNames?.has(s.faculty) ? s.faculty : quoteUser(s.faculty), removable: true });
  return out;
}

/** @param {State} s */
function renderChips(s) {
  const list = chipList(s);
  setChildren(els.chips, ...list.map((c) => h('li', null, c.removable
    ? h('button', { class: 'chip', attrs: { type: 'button', 'data-filter': c.key, ...(c.value ? { 'data-value': c.value } : {}), 'aria-label': `Remove filter: ${c.label}` } }, c.label, icon('x'))
    : h('span', { class: 'chip chip-fixed', attrs: { 'data-filter': c.key } }, c.label))));
  els.filtersBtnText.textContent = `Filters (${list.length})`;
}

const removableFilters = () => chipList(current).filter((c) => c.removable && c.key !== 'ng' && !(current.ng && c.key === 'sem')).length;

/** @returns {State} */
function readForm() {
  return {
    q: els.q.value, sem: els.sem.value, level: els.level.value, credits: els.credits.value, faculty: els.faculty.value,
    ng: els.ng.checked, study: els.ng.checked ? els.study.value : '',
    ignore: current.ignore, open: current.open, from: current.from, view: current.view,
  };
}

const search = createSearchClient();
const answers = new Map();
const ANSWERS_KEPT = 50;
const targets = { status: els.status, results: els.results };
const moduleClient = createModuleClient();
const modules = {
  /** @param {string} code */
  get: (code) => moduleClient.get(code).then((outcome) => {
    if (outcome.kind === 'ok' && typeof outcome.body?.acad_year === 'string') rowYears.set(code.trim().toUpperCase(), outcome.body.acad_year);
    return outcome;
  }),
};
/** @type {'retry' | 'rate' | 'other' | null} */
let lastError = null;

/** @type {import('./explain.js').Source[] | null} */
let sources = null;
/** @type {{ key: string, data: any, view: import('./render.js').Rendered } | null} */
let shown = null;

/** @param {string} code */
const searchHref = (code) => urlFor({ ...current, q: code, ignore: [], open: '', from: '', view: '' }, emptyList(), location.pathname);
/**
 * @param {string} code
 * @param {string} from
 */
const variantHref = (code, from) => urlFor({ ...current, q: code, ignore: [], open: code, from, view: '' }, emptyList(), location.pathname);

/**
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

function announceAnswer() {
  if (!shown) return;
  const read = intentChips(shown.data?.interpreted, current.ignore).map((c) => c.label);
  resultsSay([shown.view.announce, read.length ? `Read from your query: ${read.join(', ')}.` : ''].filter(Boolean).join(' '));
}

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
      if (!verdict.switchTo || !sem || otherFilterHides(outcome.body, filters)) { setChildren(actions); return; }
      const button = h('button', { class: 'linkbtn switch-sem', attrs: { type: 'button' } }, `Switch to ${semLabel(verdict.switchTo)} to see ${code}`);
      button.addEventListener('click', () => switchSemester(verdict.switchTo, code));
      setChildren(actions, button);
    });
  }
}

/**
 * @param {any} m
 * @param {Record<string, unknown>} filters
 */
function otherFilterHides(m, filters) {
  return (filters.level !== undefined && !echoHas(filters.level, m.level))
    || (filters.credits !== undefined && !echoHas(filters.credits, m.credits))
    || (filters.faculty !== undefined && m.faculty !== filters.faculty);
}

/**
 * @param {string} sem
 * @param {string} code
 */
async function switchSemester(sem, code) {
  els.sem.value = sem;
  syncExchange();
  await actThenFocus({ type: 'settings', form: readForm() }, code);
}

/**
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

/** @param {State} s */
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
  const see = p.actions.querySelector('button');
  if (see || p.line.textContent !== before) resultsSay([p.line.textContent, see ? `The “${see.textContent}” button shows them.` : ''].filter(Boolean).join(' '));
}

/** @param {string} key @param {any} body */
function remember(key, body) {
  answers.set(key, body);
  if (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value);
}

/**
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

/** @param {any} body */
function showIntentChips(body) {
  const row = intentChipRow(body?.interpreted, current.ignore, (intent) => {
    act({ type: 'settings', form: { ...readForm(), q: current.q, ignore: [...new Set([...current.ignore, intent])].sort() } });
    els.q.focus();
  });
  if (row) els.status.append(row);
}

/**
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
      if (fromUser && !s.view) setTimeout(() => els.study.focus(), 0);
    } else if (leftSetup) {
      message(EMPTY);
    } else {
      showMessage(targets, EMPTY);
      resultsSay('');
    }
    return;
  }
  const key = params.toString();
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
 * @param {import('./nav.js').Action} action
 * @returns {Promise<void>}
 */
async function act(action) {
  writer.flush();
  const detailPushed = writer.state()?.vnmDetail === true;
  const { state, op } = transition(current, action, { detailPushed });
  if (op === 'none') return;
  if (op === 'back') { history.back(); return; }
  const url = pageUrl(state);
  const before = current;
  if (action.type === 'openView') {
    const data = { vnmShortlist: true, atOpen: searchKey(current) };
    if (op === 'replace-push') writer.replace(pageUrl({ ...current, open: '', from: '' }), null);
    if (op === 'replace') writer.replace(url, data);
    else writer.push(url, data);
  } else {
    if (op === 'replace-push') writer.replace(pageUrl({ ...current, open: '', from: '' }), null);
    if (op === 'push' || op === 'replace-push') writer.push(url, action.type === 'open' ? { vnmDetail: true } : null);
    else writer.replace(url, action.type === 'open' || state.view ? undefined : null);
  }
  const closing = action.type === 'close' ? current.open : '';
  current = state;
  applyToForm(state);
  if (action.type === 'openView') {
    enterView();
    return;
  }
  if (action.type === 'closeView') {
    leaveView();
    if (shown && shown.key === (searchParams(state)?.toString() ?? '')) announceAnswer();
    else if (searchAgain(before, state, lastError) || (!shown && lastError === 'retry')) await show(state);
    else announce(els.status.textContent ?? '');
    return;
  }
  const done = show(state, { fromUser: true, submitted: action.type === 'submit' });
  if (closing) shown?.view.cards.get(closing)?.button.focus();
  if (before.view && state.view && action.type === 'settings') settingsInView();
  if (before.view && !state.view) { viewClosed(); }
  await done;
}

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  act({ type: 'submit', form: readForm() });
});
/**
 * @param {HTMLInputElement} input
 * @param {() => void} submit
 */
function onEnter(input, submit) {
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!e.isComposing && e.keyCode === 229) { e.preventDefault(); return; }
    if (!isSubmitEnter(e)) return;
    e.preventDefault();
    submit();
  });
}
onEnter(els.q, () => act({ type: 'submit', form: readForm() }));
for (const el of [els.sem.root, els.level.root, els.credits.root, els.faculty.root, els.ng, els.ngOff, els.study.root]) {
  el.addEventListener('change', () => {
    if (el === els.study.root) saveStudy(els.study.value);
    if (el === els.ng || el === els.ngOff) saveWho(els.ng.checked ? 'exchange' : 'nus');
    syncExchange();
    act({ type: 'settings', form: readForm() });
    if (el === els.sem.root && els.semWrap.hidden) radios('xsem').find((r) => r.checked)?.focus();
  });
}
els.semSegOptions.addEventListener('change', () => {
  els.sem.value = checkedValue('xsem') ?? '';
  act({ type: 'settings', form: readForm() });
});

els.chips.addEventListener('click', (e) => {
  const chip = e.target instanceof Element ? e.target.closest('button.chip') : null;
  if (!(chip instanceof HTMLButtonElement)) return;
  const at = [...els.chips.querySelectorAll('button.chip')].indexOf(chip);
  const key = chip.dataset.filter ?? '';
  const form = readForm();
  if (key === 'ng') { form.ng = false; form.study = ''; } else if (key === 'level' || key === 'credits') {
    form[key] = listValues(form[key]).filter((v) => v !== chip.dataset.value).join(',');
  } else if (key === 'sem' || key === 'faculty') form[key] = '';
  act({ type: 'settings', form });
  const left = /** @type {HTMLButtonElement[]} */ ([...els.chips.querySelectorAll('button.chip')]);
  (left[Math.min(at, left.length - 1)] ?? els.q).focus();
});

function syncWho() {
  const exchange = checkedValue('setupWho') === 'exchange';
  els.setupSemStep.hidden = !exchange;
  els.setupStudyStep.hidden = !exchange;
  els.setupSources.hidden = !exchange;
  els.setupQNum.textContent = exchange ? '04' : '02';
  els.setupError.hidden = true;
}
for (const r of radios('setupWho')) r.addEventListener('change', syncWho);
/** @param {string} text @param {HTMLElement} focus */
function setupAsk(text, focus) {
  els.setupError.textContent = text;
  els.setupError.hidden = false;
  focus.focus();
  announce(text);
}
function submitSetup() {
  const q = els.setupQ.value.trim();
  if (checkedValue('setupWho') !== 'exchange') {
    if (!q) { setupAsk('Type what you want to study.', els.setupQ); return; }
    els.setupError.hidden = true;
    saveWho('nus');
    leaveSetup({ ...readForm(), q, sem: '', level: '', credits: '', faculty: '', ng: false, study: '' });
    return;
  }
  const sem = checkedValue('setupSem');
  const study = checkedValue('setupStudy');
  if (sem === null) { setupAsk('Choose the semester you will study at NUS.', radios('setupSem')[0]); return; }
  if (!study) { setupAsk('Choose your year of study during your exchange.', radios('setupStudy')[0]); return; }
  if (!q) { setupAsk('Type what you want to study.', els.setupQ); return; }
  els.setupError.hidden = true;
  saveStudy(study);
  saveWho('exchange');
  leaveSetup({ ...readForm(), q, sem, level: '', credits: '', faculty: '', ng: true, study });
}
/** @param {ReturnType<typeof readForm>} form */
function leaveSetup(form) {
  leftSetup = true;
  act({ type: 'submit', form });
  window.scrollTo(0, 0);
  els.q.focus({ preventScroll: true });
}
els.setupForm.addEventListener('submit', (e) => { e.preventDefault(); submitSetup(); });
onEnter(els.setupQ, submitSetup);
els.browseAll.addEventListener('click', () => {
  leftSetup = true;
  if (checkedValue('setupWho') === 'exchange') {
    saveWho('exchange');
    const study = checkedValue('setupStudy');
    if (study) saveStudy(study);
    act({ type: 'settings', form: { ...readForm(), q: '', sem: checkedValue('setupSem') ?? '', ng: true, study: checkedValue('setupStudy') ?? '' } });
  } else {
    saveWho('nus');
    syncView(current);
    show(current);
  }
  window.scrollTo(0, 0);
  els.q.focus();
});

const rail = /** @type {HTMLElement} */ (els.panel.parentElement);
const liveHome = /** @type {HTMLElement} */ (els.live.parentElement);
els.filtersBtn.addEventListener('click', () => {
  els.dialogSlot.append(els.panel);
  els.dialog.append(els.live);
  els.dialog.showModal();
  (els.ng.checked ? els.ng : els.ngOff).focus();
});
els.filtersDone.addEventListener('click', () => els.dialog.close());
/** @type {Element | null} */
let refocus = null;
els.dialog.addEventListener('close', () => {
  const was = refocus ?? document.activeElement;
  refocus = null;
  rail.prepend(els.panel);
  liveHome.append(els.live);
  if (getComputedStyle(els.filtersBtn).display !== 'none') els.filtersBtn.focus();
  else if (was instanceof HTMLElement && els.panel.contains(was)) was.focus();
  else els.q.focus();
});
/** @returns {HTMLElement[]} */
function dialogStops() {
  const all = /** @type {HTMLElement[]} */ ([...els.dialog.querySelectorAll('button, input, select, a[href]')])
    .filter((el) => !el.closest('[hidden]') && !(/** @type {any} */ (el).disabled) && el.getClientRects().length > 0 && el.tabIndex >= 0);
  /** @type {Set<string>} */
  const groups = new Set();
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio') return true;
    if (groups.has(el.name)) return false;
    groups.add(el.name);
    return true;
  }).map((el) => (el instanceof HTMLInputElement && el.type === 'radio' ? radios(el.name).find((r) => r.checked) ?? el : el));
}
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
matchMedia('(min-width: 641px)').addEventListener('change', (e) => {
  if (!e.matches || !els.dialog.open) return;
  refocus = document.activeElement;
  els.dialog.close();
});

document.addEventListener('keydown', (e) => {
  if (!isCloseEscape(e) || els.dialog.open) return;
  if (current.view) {
    e.preventDefault();
    closeView();
    return;
  }
  if (!current.open) return;
  e.preventDefault();
  act({ type: 'close' });
});
els.results.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('button.card-toggle') : null;
  if (!(button instanceof HTMLButtonElement)) return;
  act(button.getAttribute('aria-expanded') === 'true' ? { type: 'close' } : { type: 'open', code: button.dataset.code ?? '' });
});
els.results.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-variant]') : null;
  if (!(link instanceof HTMLAnchorElement) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  actThenFocus({ type: 'variant', code: link.dataset.variant ?? '', from: link.dataset.from ?? '' }, link.dataset.variant ?? '');
});
document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-search]') : null;
  if (!(link instanceof HTMLAnchorElement) || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  act({ type: 'submit', form: { ...readForm(), q: link.dataset.search ?? '' } });
  window.scrollTo({ top: 0 });
  els.q.focus({ preventScroll: true });
});
history.scrollRestoration = 'manual';
window.addEventListener('popstate', async () => {
  writer.cancel();
  const left = current;
  const before = current.open;
  const answerBefore = shown?.key;
  current = settle(parseState(new URLSearchParams(location.search)));
  const after = current;
  if (after.view && !left.view) enterView();
  if (!after.view && left.view) leaveView();
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
  const card = before && !after.open ? before : after.open && after.open !== before ? after.open : '';
  const button = card ? shown?.view.cards.get(card)?.button : null;
  if (button) { button.focus(); return; }
  if (shown?.key !== answerBefore) window.scrollTo(0, 0);
  if (!document.activeElement || document.activeElement === document.body) document.getElementById(els.skip.hash.slice(1))?.focus({ preventScroll: true });
});

const header = /** @type {HTMLElement} */ (document.querySelector('.hdr'));
new ResizeObserver(() => {
  document.documentElement.style.scrollPaddingTop = getComputedStyle(header).position === 'sticky' ? `${header.offsetHeight + 8}px` : '';
}).observe(header);

document.addEventListener('keydown', () => { document.documentElement.dataset.keys = ''; }, true);
document.addEventListener('pointerdown', () => { delete document.documentElement.dataset.keys; }, true);

fetchFacets().then((f) => {
  if (!f) return;
  sources = Array.isArray(f.ngSources) ? f.ngSources : null;
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
    els.faculty.upsert({ value: name, label: name, note: String(Number(x.count) || 0) });
  }
  if (names.length) {
    facultyNames = new Set(names);
    els.faculty.retain(facultyNames);
    if (current.faculty && !names.includes(current.faculty)) {
      els.faculty.value = '';
      act({ type: 'settings', form: { ...readForm(), q: current.q, faculty: '' } });
    }
  }
  if (current.faculty && facultyNames?.has(current.faculty)) renderChips(current);
  if (f.ng) {
    els.ngHint.textContent = f.ng.count
      ? `${f.ng.count} courses on the NUS Registrar's list${f.ng.updatedAsAt ? `, updated ${f.ng.updatedAsAt}` : ''}.`
      : 'The NG list could not be loaded. Reload the page to try again.';
  }
  if (sources) renderSources();
  offListRules = Array.isArray(f.offListRules) ? f.offListRules : null;
  renderShortlist();
});

/**
 * @param {RegExp} name
 * @returns {string}
 */
const updated = (name) => {
  const src = (sources ?? []).find((x) => name.test(String(x?.name ?? '')));
  return typeof src?.updatedAsAt === 'string' ? src.updatedAsAt : '';
};

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

/** @type {import('./shortlist.js').OffListRule[] | null} */
let offListRules = null;
/** @type {Map<string, import('./shortlist.js').Answer>} */
const rowAnswers = new Map();
/** @type {Set<string>} */
const rowWanted = new Set();
/** @type {string[]} */
const rowQueue = [];
let rowsActive = 0;
const ROWS_AT_ONCE = 4;
/** @type {{ removed: import('./list.js').Removed, where: 'card' | 'view' } | null} */
let undoable = null;
let viewSentence = '';
let copySaid = '';
let copyField = '';
let asked = { year: false, entries: /** @type {string[]} */ ([]) };
let progressSaid = false;
let editCount = 0;
/** @type {'csv' | 'print' | null} */
let exportWaiting = null;
let exportReadySaid = false;
const pageTitle = document.title;
/** @type {import('./export.js').Doc | null} */
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

function worked() {
  return workOut({ list, sem: current.sem, study: current.ng ? current.study : '', answers: rowAnswers, rules: offListRules, nus: !current.ng });
}
/** @param {string} code */
const entry = (code) => worked().entries.find((w) => w.code === code);

/** @param {'1' | '2'} sem */
const picked = (sem) => worked().sems[sem].picked;
/** @param {string} sem */
const loadingIn = (sem) => list.pick.filter((e) => e.sem === sem && !rowAnswers.has(e.code)).length;

function buttonLine() {
  const n = entryCount(list);
  if (!n) return 'No courses yet';
  const sems = /** @type {('1' | '2')[]} */ (['1', '2']).filter((s) => list.pick.some((e) => e.sem === s));
  if (!list.pick.length) return `${n} backup${n === 1 ? '' : 's'}, no primary picks yet`;
  if (!sems.length) return `${list.pick.length} pick${list.pick.length === 1 ? '' : 's'}, no semester yet`;
  return `${sems.map((s) => `${semLabel(s)}: ${picked(s)}`).join(' · ')} units picked`;
}

/** @param {string} text */
function say(text) {
  editSaidAt = Date.now();
  announce(text);
}

/** @param {HTMLElement} el */
function focusHeading(el) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
}
const shownOpenButton = () => els.slOpen.find((b) => b.getClientRects().length > 0) ?? els.slOpen[0];

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
      if (current.view) updateAsked();
      renderShortlist();
      progressDone();
      exportReady();
      pumpRows();
    });
  }
}
/** @type {Map<string, (() => void)[]>} */
const rowSettled = new Map();
/** @param {string} code @returns {Promise<void>} */
const whenSettled = (code) => (rowAnswers.has(code) ? Promise.resolve() : new Promise((resolve) => {
  rowSettled.set(code, [...(rowSettled.get(code) ?? []), resolve]);
}));

function progressStart() {
  const waiting = [...list.pick, ...list.alt].filter((e) => !rowAnswers.has(e.code)).length;
  if (!current.view || !waiting || progressSaid) return;
  progressSaid = true;
  announce(`Loading ${waiting} course${waiting === 1 ? '' : 's'}`);
}
function progressDone() {
  if (!progressSaid || [...list.pick, ...list.alt].some((e) => !rowAnswers.has(e.code))) return;
  progressSaid = false;
  if (!current.view || Date.now() - editSaidAt < 1000) return;
  const all = [...list.pick, ...list.alt];
  const failed = all.filter((e) => rowAnswers.get(e.code)?.kind === 'failed').length;
  const n = all.length - failed;
  announce(`${n} course${n === 1 ? '' : 's'} loaded${failed ? `; ${failed} could not be loaded` : ''}`);
}

function viewLines() {
  const out = [];
  if (viewSentence) out.push(viewSentence);
  const y = yearLine(list.ay, rowYear());
  if (y) out.push(`${y}.`);
  if (droppedOnLoad) out.push(`${droppedOnLoad} value${droppedOnLoad === 1 ? '' : 's'} in the link ${droppedOnLoad === 1 ? 'was' : 'were'} left out: not a course code, repeated, or past the most a list keeps.`);
  return out;
}

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
 * @param {(l: import('./list.js').List) => import('./list.js').Edit} fn
 * @returns {{ ok: true } | { ok: false, why: string }}
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

/** @param {string} code */
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

/** @param {string} code */
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

/** @param {string} code */
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

/** @param {string} code */
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

/** @param {string} code */
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

const rowsSettled = () => [...list.pick, ...list.alt].every((e) => rowAnswers.has(e.code));
const questionOpen = () => exportQuestion({ list, study: current.ng ? current.study : '', answers: rowAnswers, nus: !current.ng }).ask;

/** @param {import('./shortlist.js').Result} [result] */
function exportDoc(result = worked()) {
  const l = withYear(list, rowYear());
  return buildExport({
    result, list: l, study: current.ng ? current.study : '', sources, answers: rowAnswers, today: new Date(),
    link: `${SITE_URL}${shortlistUrl(current, l, '/')}`, yearNote: yearLine(list.ay, rowYear()),
  });
}

/** @param {import('./shortlist.js').Result} result */
function renderPrint(result) {
  const ready = current.view && entryCount(list) > 0 && rowsSettled() && !questionOpen();
  if (current.view && entryCount(list) > 0) {
    printed = exportDoc(result);
    printView.update(printed);
  }
  document.documentElement.classList.toggle('print-shortlist', !!ready);
}

function exportLine() {
  if (!exportWaiting) return '';
  const all = [...list.pick, ...list.alt];
  if (!rowsSettled()) return `Loading ${all.filter((e) => rowAnswers.has(e.code)).length} of ${all.length} courses`;
  return `Ready: press again to ${exportWaiting === 'csv' ? 'download' : 'print'}`;
}
function exportReady() {
  if (!exportWaiting || exportReadySaid || !rowsSettled()) return;
  exportReadySaid = true;
  say(exportLine());
}

/** @param {'csv' | 'print'} kind */
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

/** @param {import('./export.js').Doc} doc */
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

window.addEventListener('beforeprint', () => {
  if (printed && document.documentElement.classList.contains('print-shortlist')) document.title = printed.stem;
});
window.addEventListener('afterprint', () => { document.title = pageTitle; });

function loadPrintFonts() {
  if (!document.fonts) return;
  for (const face of ['400 1em "IBM Plex Sans"', '500 1em "IBM Plex Sans"', '600 1em "IBM Plex Sans"', '400 1em "IBM Plex Mono"', '500 1em "IBM Plex Mono"']) {
    document.fonts.load(face).catch(() => {});
  }
}

function updateAsked() {
  const q = exportQuestion({ list, study: current.ng ? current.study : '', answers: rowAnswers, nus: !current.ng });
  asked = {
    year: current.ng && (asked.year || q.year),
    entries: [...new Set([...asked.entries, ...q.entries])].filter((c) => hasEntry(list, c) && askable(rowAnswers.get(c))),
  };
}

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
function leaveView() {
  viewClosed();
  shownOpenButton().focus();
}
function viewClosed() {
  asked = { year: false, entries: [] };
  exportWaiting = null;
  viewSentence = '';
  copySaid = '';
  copyField = '';
  progressSaid = false;
  renderShortlist();
}
function settingsInView() {
  updateAsked();
  viewSentence = summary(worked());
  renderShortlist();
  say(viewSentence);
}
function closeView() {
  const data = writer.state();
  act({ type: 'closeView', viewPushed: data?.vnmShortlist === true, atOpen: typeof data?.atOpen === 'string' ? data.atOpen : '' });
}

for (const b of els.slOpen) {
  b.addEventListener('click', () => {
    if (current.view) { focusHeading(slView.title); return; }
    act({ type: 'openView' });
  });
}
document.addEventListener('click', (e) => {
  const t = e.target instanceof Element ? e.target.closest('button.sl-toggle') : null;
  if (t instanceof HTMLButtonElement && t.dataset.sl) toggle(t.dataset.sl);
});

function shortlistLink() {
  writer.flush();
  return `${location.origin}${shortlistUrl(current, withYear(list, rowYear()), location.pathname)}`;
}

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') writer.flush(); });
window.addEventListener('pagehide', () => writer.flush());

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

checkValue('setupWho', savedWho());
syncWho();
if (STUDIES.some((o) => o.value === savedStudy())) checkValue('setupStudy', savedStudy());

current = settle(current);
ensureRows();
renderShortlist();
if (current.view) { updateAsked(); renderShortlist(); progressStart(); loadPrintFonts(); }
show(current);
