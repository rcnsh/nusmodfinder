// @ts-check

/** @type {Readonly<Record<string, string>>} */
const SEM_NAMES = Object.freeze({ 1: 'Sem 1', 2: 'Sem 2', 3: 'Special term 1', 4: 'Special term 2' });

/** @param {number | string} s */
export const semLabel = (s) => SEM_NAMES[String(s)] ?? String(s);

/** @param {number} n */
const num = (n) => String(Math.round(n * 100) / 100);

/** @param {{ lecture: number, tutorial: number, lab: number, project: number, prep: number, total: number } | { raw: string } | null | undefined} w */
export function workloadText(w) {
  if (!w) return 'Workload not listed';
  if ('raw' in w) return `As NUS lists it: ${w.raw}`;
  /** @type {[string, number][]} */
  const parts = [['lecture', w.lecture], ['tutorial', w.tutorial], ['lab', w.lab], ['project', w.project], ['preparation', w.prep]];
  const split = parts.filter(([, h]) => h > 0).map(([name, h]) => `${num(h)} ${name}`).join(', ');
  return `${num(w.total)} hour${w.total === 1 ? '' : 's'} a week${split ? `: ${split}` : ''}`;
}

const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** @param {string} iso */
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

/** @param {ExamDate} e */
export function examLine(e) {
  const t = sgt(e.date);
  const length = e.durationMins > 0 ? `, ${duration(e.durationMins)}` : '';
  return `${semLabel(e.sem)}: ${t.day} ${t.date} ${t.month} ${t.year}, ${t.time}${length}`;
}

/**
 * @param {ExamDate[] | null | undefined} exams
 * @param {string} sem
 * @returns {{ label: string, when: string }[]}
 */
export function examParts(exams, sem) {
  const list = [...(exams ?? [])].filter((e) => !sem || String(e.sem) === sem)
    .sort((a, b) => a.sem - b.sem || Date.parse(a.date) - Date.parse(b.date));
  return list.map((e) => {
    const t = sgt(e.date);
    return { label: sem ? 'Exam' : `${semLabel(e.sem)} exam`, when: `${t.day} ${t.date} ${t.month}, ${t.time}` };
  });
}

/**
 * @param {ExamDate[] | null | undefined} exams
 * @returns {string[]}
 */
export function examLines(exams) {
  const list = [...(exams ?? [])].sort((a, b) => a.sem - b.sem || Date.parse(a.date) - Date.parse(b.date));
  return list.length ? list.map(examLine) : ['No final exam listed'];
}

export const ECHO_MAX = 60;
// eslint-disable-next-line no-control-regex -- matching control characters is the point: they are removed.
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/** @param {string} text */
export const hasHidden = (text) => text.replace(HIDDEN, '') !== text;
const QUOTE_MARKS = /[\p{Pi}\p{Pf}„‚"＂″‶‴⁗〃〝〞〟ˮ˝״׳❛❜❝❞❮❯🙶🙷🙸ʹʻʼʽˈ′‵＇`´]/gu;
const APOSTROPHES = /'{2,}/g;

/** @param {unknown} text */
export function echoText(text) {
  const clean = String(text ?? '').replace(HIDDEN, '').replace(QUOTE_MARKS, "'").replace(APOSTROPHES, "'")
    .replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  return chars.length > ECHO_MAX ? `${chars.slice(0, ECHO_MAX - 1).join('').trimEnd()}…` : clean;
}

/** @param {unknown} text */
export const quoteUser = (text) => `“${echoText(text)}”`;

/** @param {string | null | undefined} text */
export function cleanPrereq(text) {
  return String(text ?? '')
    .replace(/(THEN|AND|OR)(?=[a-z])|(?<=^|[a-z)\s]|\s[A-Z]{1,2}[+-]?)(THEN|AND|OR)(?=\()/g, (_m, a, b) => ` ${a ?? b} `)
    .replace(/(?<=[a-z)])(THEN|AND|OR)(?=\s|$)/g, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string | null | undefined} raw
 * @param {boolean} cohortOnly
 * @returns {{ kind: 'cohort' | 'rule', line: string | null, text: string } | null}
 */
export function prereqView(raw, cohortOnly) {
  const text = cleanPrereq(raw);
  if (!text) return null;
  if (!cohortOnly) return { kind: 'rule', line: null, text };
  const cohorts = /\bcohorts?\b/i.test(text);
  const programmes = /\bundertaking (?:1 of )?\d{4}[A-Z0-9]{2,}/i.test(text);
  const names = cohorts && programmes ? 'groups of NUS students by the year they started and by degree programme'
    : programmes ? 'NUS degree programmes' : 'groups of NUS students by the year they started';
  return { kind: 'cohort', line: `No course you must pass first. NUS's rule only names ${names}; ask NUS whether it applies to you.`, text };
}

const CODE_IN_TEXT = /\b[A-Z]{1,4}\d{4}[A-Z0-9]{0,5}\b/g;

/**
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
