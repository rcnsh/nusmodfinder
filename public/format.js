// @ts-check
// Pure formatting for the cards and the detail (Phase 5 5B, 5C): semester
// names, workload, exams in Singapore time, and NUS's prerequisite text with
// its missing spaces put back, its cohort-only case named, and its course codes
// found. Every function returns plain text or plain data; the caller puts it in
// a node with textContent.
import { isCohortOnly } from './cohort-only.js';

/** @type {Readonly<Record<string, string>>} */
const SEM_NAMES = Object.freeze({ 1: 'Sem 1', 2: 'Sem 2', 3: 'Special term 1', 4: 'Special term 2' });

/** @param {number | string} s */
export const semLabel = (s) => SEM_NAMES[String(s)] ?? String(s);

/** @param {number} n */
const num = (n) => String(Math.round(n * 100) / 100);

/**
 * /module's `workload`: hours a week and the parts that are not zero, NUS's own
 * text when it isn't the 5-number form, or that it isn't listed.
 * @param {{ lecture: number, tutorial: number, lab: number, project: number, prep: number, total: number } | { raw: string } | null | undefined} w
 */
export function workloadText(w) {
  if (!w) return 'Workload not listed';
  if ('raw' in w) return `As NUS lists it: ${w.raw}`;
  /** @type {[string, number][]} */
  const parts = [['lecture', w.lecture], ['tutorial', w.tutorial], ['lab', w.lab], ['project', w.project], ['preparation', w.prep]];
  const split = parts.filter(([, h]) => h > 0).map(([name, h]) => `${num(h)} ${name}`).join(', ');
  return `${num(w.total)} hour${w.total === 1 ? '' : 's'} a week${split ? `: ${split}` : ''}`;
}

/** Singapore has no daylight saving: UTC+8 all year. */
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The parts of an ISO UTC instant in Singapore time, computed by hand so the
 * text is the same in every browser and in Node, whatever its locale data.
 * @param {string} iso
 */
function sgt(iso) {
  const d = new Date(Date.parse(iso) + SGT_OFFSET_MS);
  const h = d.getUTCHours();
  return {
    day: DAYS[d.getUTCDay()], date: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], year: d.getUTCFullYear(),
    time: `${h % 12 === 0 ? 12 : h % 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`,
  };
}

/** @param {number} mins */
function duration(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** @typedef {{ sem: number, date: string, durationMins: number }} ExamDate */

/**
 * One exam for the detail: "Sem 2: Tue 27 Apr 2027, 5:00 pm, 2 h" (Singapore time).
 * @param {ExamDate} e
 */
export function examLine(e) {
  const t = sgt(e.date);
  const length = e.durationMins > 0 ? `, ${duration(e.durationMins)}` : '';
  return `${semLabel(e.sem)}: ${t.day} ${t.date} ${t.month} ${t.year}, ${t.time}${length}`;
}

/**
 * The card's exam line: the chosen semester's exam ("Exam 26 Nov"), else every
 * semester's, or "No final exam".
 * @param {ExamDate[] | null | undefined} exams
 * @param {string} sem the chosen semester, '' for both or any
 */
export function examSummary(exams, sem) {
  const list = (exams ?? []).filter((e) => !sem || String(e.sem) === sem);
  if (list.length === 0) return 'No final exam';
  /** @param {ExamDate} e */
  const day = (e) => { const t = sgt(e.date); return `${t.date} ${t.month}`; };
  if (list.length === 1) return `Exam ${day(list[0])}`;
  return `Exams ${list.map((e) => `${day(e)} (${semLabel(e.sem)})`).join(', ')}`;
}

/**
 * Every exam for the detail, in semester order, or that none is listed.
 * @param {ExamDate[] | null | undefined} exams
 * @returns {string[]}
 */
export function examLines(exams) {
  const list = [...(exams ?? [])].sort((a, b) => a.sem - b.sem || Date.parse(a.date) - Date.parse(b.date));
  return list.length ? list.map(examLine) : ['No final exam listed'];
}

/**
 * NUS's prerequisite rule language with the spaces it drops put back around
 * THEN, AND and OR ("DegreeTHENmust", "at least DANDmust", ")OR("). Only
 * spacing changes; the words stay NUS's. NUS writes the keywords in capitals
 * and glues them to what follows ("must", "if", "("), after a word, a grade
 * ("DANDmust", "CSORmust") or a programme code ("XDPANDmust"); so a keyword
 * running into a lower-case letter is split off, as is one before "(" that
 * follows a lower-case letter, ")", a space or a grade, and one glued to a lower-case
 * word or ")" before a space. Capitals that merely contain one ("MAJOR",
 * "STANDARD", "THENCEFORTH", "BACHELOR(") are left alone.
 * @param {string | null | undefined} text
 */
export function cleanPrereq(text) {
  return String(text ?? '')
    .replace(/(THEN|AND|OR)(?=[a-z])|(?<=^|[a-z)\s]|\s[A-Z]{1,2}[+-]?)(THEN|AND|OR)(?=\()/g, (_m, a, b) => ` ${a ?? b} `)
    .replace(/(?<=[a-z)])(THEN|AND|OR)(?=\s|$)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The detail's prerequisite: null when NUS lists none; `cohort` when the rule
 * names only NUS intake years or programmes (3H-0's P-6 rule), with a plain
 * line; otherwise NUS's `rule`, spaced. `text` is always NUS's own words. No
 * plain-English rewrite of the rule language (docs/plans/phase5.md 5C).
 * @param {string | null | undefined} raw
 * @returns {{ kind: 'cohort' | 'rule', line: string | null, text: string } | null}
 */
export function prereqView(raw) {
  const text = cleanPrereq(raw);
  if (!text) return null;
  if (!isCohortOnly(raw)) return { kind: 'rule', line: null, text };
  const cohorts = /\bcohorts?\b/i.test(text);
  const programmes = /\bundertaking (?:1 of )?\d{4}[A-Z0-9]{2,}/i.test(text);
  const names = cohorts && programmes ? 'NUS intake years and programmes' : programmes ? 'NUS programmes' : 'NUS intake years';
  return { kind: 'cohort', line: `No course prerequisite (the rule names ${names} only)`, text };
}

/** A course code inside NUS's text: letters then four digits and a suffix; not a programme code (digits first). */
const CODE_IN_TEXT = /\b[A-Z]{2,4}\d{4}[A-Z]{0,4}\b/g;

/**
 * NUS's text cut into plain runs and course codes, so the detail can link each
 * code to a search.
 * @param {string} text
 * @returns {({ text: string } | { code: string })[]}
 */
export function codeSegments(text) {
  /** @type {({ text: string } | { code: string })[]} */
  const out = [];
  let at = 0;
  for (const m of text.matchAll(CODE_IN_TEXT)) {
    const i = /** @type {number} */ (m.index);
    if (i > at) out.push({ text: text.slice(at, i) });
    out.push({ code: m[0] });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
