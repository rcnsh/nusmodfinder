// @ts-check

/** @typedef {'' | '1' | '2'} Tag */
/** @typedef {{ code: string, sem: Tag }} Entry */
/** @typedef {'pick' | 'alt'} Which */
/** @typedef {'biz' | 'law'} Invite */
/** @typedef {{ pick: Entry[], alt: Entry[], ay: string, inv: Invite[] }} List */
/** @typedef {{ which: Which, index: number, entry: Entry }} Removed */
/** @typedef {{ ok: true, list: List } | { ok: false, why: string }} Edit */

export const MAX_PER_SEM = 20;
export const MAX_ENTRIES = 40;
/** @type {readonly Invite[]} */
export const INVITES = Object.freeze(/** @type {Invite[]} */ (['biz', 'law']));

const CODE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;
const VALUE = /^([A-Z]{1,4}\d{4}[A-Z0-9]{0,5})(?:\.([12]))?$/;

/** @param {string} s */
export const isCode = (s) => CODE.test(s);

/** @returns {List} */
export const emptyList = () => ({ pick: [], alt: [], ay: '', inv: [] });

/** @param {Entry} e */
export const entryValue = (e) => (e.sem ? `${e.code}.${e.sem}` : e.code);

/** @param {List} list */
export const entryCount = (list) => list.pick.length + list.alt.length;

/** @param {string} v */
export function isAcadYear(v) {
  const m = /^(\d{4})-(\d{4})$/.exec(v);
  return !!m && Number(m[2]) === Number(m[1]) + 1;
}

/** @param {string} raw @returns {Entry | null} */
function parseEntry(raw) {
  const m = VALUE.exec(raw.trim().toUpperCase());
  return m ? { code: m[1], sem: /** @type {Tag} */ (m[2] ?? '') } : null;
}

/** @param {List} list @param {Tag} sem */
const inSem = (list, sem) => [...list.pick, ...list.alt].filter((e) => e.sem === sem).length;

/**
 * @param {List} list
 * @param {Tag} sem
 * @param {{ adding: boolean }} how
 */
function capWhy(list, sem, { adding }) {
  if (adding && entryCount(list) >= MAX_ENTRIES) return `Your shortlist already has ${MAX_ENTRIES} courses, the most it keeps.`;
  if (sem && inSem(list, sem) >= MAX_PER_SEM) return `Sem ${sem} already has ${MAX_PER_SEM} courses on your shortlist, the most it keeps for one semester.`;
  return '';
}

/**
 * @param {URLSearchParams} params
 * @returns {{ list: List, dropped: number }}
 */
export function parseList(params) {
  const list = emptyList();
  let dropped = 0;
  /** @type {Set<string>} */
  const seen = new Set();
  for (const which of /** @type {Which[]} */ (['pick', 'alt'])) {
    for (const raw of params.getAll(which)) {
      const e = parseEntry(raw);
      if (!e || seen.has(e.code)) { dropped += 1; continue; }
      seen.add(e.code);
      if (capWhy(list, e.sem, { adding: true })) { dropped += 1; continue; }
      list[which].push(e);
    }
  }
  const ay = params.get('ay') ?? '';
  list.ay = isAcadYear(ay) ? ay : '';
  const inv = params.getAll('inv');
  list.inv = INVITES.filter((i) => inv.includes(i));
  return { list, dropped };
}

/**
 * @param {List} list
 * @returns {[string, string][]}
 */
export function listPairs(list) {
  /** @type {[string, string][]} */
  const pairs = [];
  for (const e of list.pick) pairs.push(['pick', entryValue(e)]);
  for (const e of list.alt) pairs.push(['alt', entryValue(e)]);
  if (list.ay) pairs.push(['ay', list.ay]);
  for (const i of list.inv) pairs.push(['inv', i]);
  return pairs;
}

/**
 * @param {List} list
 * @param {string} code
 * @returns {Which | ''}
 */
export function hasEntry(list, code) {
  const c = code.trim().toUpperCase();
  if (list.pick.some((e) => e.code === c)) return 'pick';
  if (list.alt.some((e) => e.code === c)) return 'alt';
  return '';
}

/** @param {List} list @param {string} code @returns {{ which: Which, index: number } | null} */
function find(list, code) {
  const c = code.trim().toUpperCase();
  for (const which of /** @type {Which[]} */ (['pick', 'alt'])) {
    const index = list[which].findIndex((e) => e.code === c);
    if (index >= 0) return { which, index };
  }
  return null;
}

/**
 * @param {List} list
 * @returns {List}
 */
const copy = (list) => ({ ...list, pick: [...list.pick], alt: [...list.alt], inv: [...list.inv] });

/**
 * @param {List} list
 * @param {string} code
 * @param {Tag} sem
 * @returns {Edit}
 */
export function add(list, code, sem) {
  const c = code.trim().toUpperCase();
  if (!CODE.test(c)) return { ok: false, why: `${code} is not a course code.` };
  if (hasEntry(list, c)) return { ok: true, list };
  const why = capWhy(list, sem, { adding: true });
  if (why) return { ok: false, why };
  const next = copy(list);
  next.pick.push({ code: c, sem });
  return { ok: true, list: next };
}

/**
 * @param {List} list
 * @param {string} code
 * @returns {{ ok: true, list: List, removed: Removed } | { ok: false, why: string }}
 */
export function remove(list, code) {
  const at = find(list, code);
  if (!at) return { ok: false, why: `${code} is not on your shortlist.` };
  const next = copy(list);
  const [entry] = next[at.which].splice(at.index, 1);
  return { ok: true, list: next, removed: { ...at, entry } };
}

/**
 * @param {List} list
 * @param {Removed} removed
 * @returns {Edit}
 */
export function restore(list, removed) {
  if (hasEntry(list, removed.entry.code)) return { ok: true, list };
  const why = capWhy(list, removed.entry.sem, { adding: true });
  if (why) return { ok: false, why };
  const next = copy(list);
  next[removed.which].splice(Math.min(removed.index, next[removed.which].length), 0, removed.entry);
  return { ok: true, list: next };
}

/**
 * @param {List} list
 * @param {string} code
 * @param {-1 | 1} dir
 * @returns {Edit}
 */
export function move(list, code, dir) {
  const at = find(list, code);
  if (!at) return { ok: false, why: `${code} is not on your shortlist.` };
  const to = at.index + dir;
  const entries = list[at.which];
  if (to < 0) return { ok: false, why: `${entries[at.index].code} is already first` };
  if (to >= entries.length) return { ok: false, why: `${entries[at.index].code} is already last` };
  const next = copy(list);
  [next[at.which][at.index], next[at.which][to]] = [next[at.which][to], next[at.which][at.index]];
  return { ok: true, list: next };
}

/**
 * @param {List} list
 * @param {string} code
 * @returns {Edit}
 */
export function makeOther(list, code) {
  const at = find(list, code);
  if (!at) return { ok: false, why: `${code} is not on your shortlist.` };
  const next = copy(list);
  const [entry] = next[at.which].splice(at.index, 1);
  next[at.which === 'pick' ? 'alt' : 'pick'].push(entry);
  return { ok: true, list: next };
}

/**
 * @param {List} list
 * @param {string} code
 * @param {Tag} sem
 * @returns {Edit}
 */
export function setSem(list, code, sem) {
  const at = find(list, code);
  if (!at) return { ok: false, why: `${code} is not on your shortlist.` };
  if (list[at.which][at.index].sem === sem) return { ok: true, list };
  const why = capWhy(list, sem, { adding: false });
  if (why) return { ok: false, why };
  const next = copy(list);
  next[at.which][at.index] = { ...next[at.which][at.index], sem };
  return { ok: true, list: next };
}

/**
 * @param {List} list
 * @param {Invite} which
 * @param {boolean} on
 * @returns {Edit}
 */
export function setInvite(list, which, on) {
  const inv = INVITES.filter((i) => (i === which ? on : list.inv.includes(i)));
  return { ok: true, list: { ...list, inv } };
}

/**
 * @param {List} list
 * @param {string} year
 * @returns {List}
 */
export function withYear(list, year) {
  return !list.ay && isAcadYear(year) ? { ...list, ay: year } : list;
}

/**
 * @param {string} stateSem
 * @param {number[]} sems
 * @returns {Tag}
 */
export function tagFor(stateSem, sems) {
  if (stateSem === '1' || stateSem === '2') return stateSem;
  const both = [1, 2].filter((s) => sems.includes(s));
  return both.length === 1 ? /** @type {Tag} */ (String(both[0])) : '';
}
