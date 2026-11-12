// @ts-check
// The shortlist: its half of the URL and every edit made to it,
// as pure functions. No DOM; test/web/list.node.test.js runs it in Node.
//
// - `pick` (primary) and `alt` (backup), each repeated in rank order. A value
//   is `CODE.S` (S is 1 or 2) or `CODE` (no semester chosen). Tags are kept as
//   written: the page never tags an entry on its own after load.
// - Parsing upper-cases and trims, drops malformed values and other tags, keeps
//   the first of duplicates (picks are read first, so a code in both lists
//   stays a pick), and keeps at most 20 entries in each tagged semester and 40
//   in all. `dropped` says how many it left out.
// - `ay` (`YYYY-YYYY`, as acad_year writes it) is set once, from the first
//   loaded row (withYear), and never rewritten.
// - `inv` (`biz`, `law`): NUS Business School or NUS Law invited the student.
//
// The list is page-wide, held apart from the search state (state.js): Back
// and Forward keep it. state.js's urlFor writes both.

/** @typedef {'' | '1' | '2'} Tag */
/** @typedef {{ code: string, sem: Tag }} Entry */
/** @typedef {'pick' | 'alt'} Which */
/** @typedef {'biz' | 'law'} Invite */
/** @typedef {{ pick: Entry[], alt: Entry[], ay: string, inv: Invite[] }} List */
/** @typedef {{ which: Which, index: number, entry: Entry }} Removed */
/** @typedef {{ ok: true, list: List } | { ok: false, why: string }} Edit */

/** The most entries one tagged semester keeps. */
export const MAX_PER_SEM = 20;
/** The most entries the list keeps (NUS's form takes 40 units: about ten 4-unit courses a semester). */
export const MAX_ENTRIES = 40;
/** The invitations, in the URL's order. @type {readonly Invite[]} */
export const INVITES = Object.freeze(/** @type {Invite[]} */ (['biz', 'law']));

/** A course code (upper-case): /module/:code's shape (src/modules.js MODULE_CODE_RE). */
const CODE = /^[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}$/;
/** A list value: a code, then `.1` or `.2` or nothing. */
const VALUE = /^([A-Z]{1,4}\d{4}[A-Z0-9]{0,5})(?:\.([12]))?$/;

/** Whether a string is a course code (already upper-case). @param {string} s */
export const isCode = (s) => CODE.test(s);

/** @returns {List} */
export const emptyList = () => ({ pick: [], alt: [], ay: '', inv: [] });

/** `CS2030.1`, or `CS2030` with no semester. @param {Entry} e */
export const entryValue = (e) => (e.sem ? `${e.code}.${e.sem}` : e.code);

/** @param {List} list */
export const entryCount = (list) => list.pick.length + list.alt.length;

/**
 * An acad year as acad_year writes it, two consecutive years, `YYYY-YYYY`.
 * @param {string} v
 */
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
 * Why one more entry in `sem` would pass a cap, or '' if it fits.
 * @param {List} list
 * @param {Tag} sem
 * @param {{ adding: boolean }} how `adding`: a new entry (else an existing one changes semester)
 */
function capWhy(list, sem, { adding }) {
  if (adding && entryCount(list) >= MAX_ENTRIES) return `Your shortlist already has ${MAX_ENTRIES} courses, the most it keeps.`;
  if (sem && inSem(list, sem) >= MAX_PER_SEM) return `Sem ${sem} already has ${MAX_PER_SEM} courses on your shortlist, the most it keeps for one semester.`;
  return '';
}

/**
 * The list a URL holds, and how many values it dropped (malformed, other
 * tags, duplicates, past a cap).
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
      // The first of duplicates is the one kept or dropped: a code dropped at a cap stays dropped.
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
 * The list's URL pairs, in order: pick, alt, ay, inv.
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

/** Which list holds `code`, or ''. @param {List} list @param {string} code @returns {Which | ''} */
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

/** @param {List} list @returns {List} a copy whose arrays can be changed */
const copy = (list) => ({ ...list, pick: [...list.pick], alt: [...list.alt], inv: [...list.inv] });

/**
 * Adds a course as the last pick (a card's toggle). Already on the list:
 * nothing changes. Refused past a cap.
 * @param {List} list
 * @param {string} code
 * @param {Tag} sem its tag (tagFor)
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
 * Removes a course from either list; `removed` restores it (Undo).
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
 * Puts a removed entry back in its list, rank and semester (Undo).
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
 * Move up (-1) or Move down (+1): swaps the entry with its neighbour in the
 * same list, whatever their semesters (one order for the year).
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
 * Make backup (a pick) or Make primary (a backup): the entry goes last in the
 * other list, its semester kept.
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
 * Chooses or changes an entry's semester. Refused past the semester's cap.
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
 * Ticks or unticks an invitation (`inv`).
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
 * Sets `ay` from the rows' acad year if the list has none: a parsed `ay` is
 * never rewritten. Called on the first edit or export, never on load alone.
 * @param {List} list
 * @param {string} year a row's acad_year, '' if none loaded
 * @returns {List}
 */
export function withYear(list, year) {
  return !list.ay && isAcadYear(year) ? { ...list, ay: year } : list;
}

/**
 * A new entry's tag: the state's semester if it is 1 or 2, else the one of
 * Sem 1 and Sem 2 the course is open in (exchange mode) or taught in (browse
 * mode), else none.
 * @param {string} stateSem the state's `sem`
 * @param {number[]} sems the semesters (of 1 and 2) the course is open in, or taught in
 * @returns {Tag}
 */
export function tagFor(stateSem, sems) {
  if (stateSem === '1' || stateSem === '2') return stateSem;
  const both = [1, 2].filter((s) => sems.includes(s));
  return both.length === 1 ? /** @type {Tag} */ (String(both[0])) : '';
}
