// @ts-check
import { semLabel } from './format.js';

/**
 * @typedef {{ id: string, kind: string, text: string }} Reason
 * @typedef {'open' | 'note' | 'closed'} Status
 * @typedef {{ sem: number | 'any', study: string, status: Status, reasons: Reason[] }} ExchangeEntry
 * @typedef {{ name?: unknown, updatedAsAt?: unknown, url?: unknown }} Source
 */

const NG_LIST_PREFIX = 'ng-list:';
const PREREQ_PREFIX = 'prereq:';
const GRO_PREFIX = 'gro:';
const UNPUBLISHED_PREFIX = 'ng:';
const OFF_NG_LIST = 'ng-list:not-listed';
const NOT_IN_SEM = 'ng-list:not-in-semester';
const UNPUBLISHED_UNLISTED = 'ng:unpublished-sem-unlisted';

/** @type {Readonly<Record<string, string>>} */
const STUDY_ADJ = Object.freeze({ ug1: '1st-year', ug2: '2nd-year', ug3: '3rd-year', ug4: '4th-year (or later)', grad: 'graduate' });

/** @param {string} study */
export const studyPhrase = (study) => (STUDY_ADJ[study] ? `${STUDY_ADJ[study]} exchange students` : 'exchange students');

/** @param {string} study */
export const studyAdj = (study) => STUDY_ADJ[study] ?? '';

/** @param {string | number} sem */
const otherSem = (sem) => (String(sem) === '1' ? 2 : 1);

/** @param {string | number} sem */
const semPhrase = (sem) => (sem === '' || sem === 'any' ? 'in either semester' : `in ${semLabel(sem)}`);

/**
 * @param {string} id
 * @param {Source[] | null | undefined} sources
 */
export function sourceNote(id, sources) {
  if (id.startsWith(PREREQ_PREFIX)) return 'NUS prerequisite';
  if (id.startsWith(GRO_PREFIX)) return 'GRO, Incoming Exchange Students';
  if (id.startsWith(UNPUBLISHED_PREFIX)) return 'NG list';
  const restrictions = !id.startsWith(NG_LIST_PREFIX);
  const label = restrictions ? 'NG restrictions' : 'NG list';
  const src = (sources ?? []).find((s) => /restriction/i.test(String(s?.name ?? '')) === restrictions);
  const date = src && typeof src.updatedAsAt === 'string' && src.updatedAsAt ? src.updatedAsAt : '';
  return date ? `${label}, updated ${date}` : label;
}

/** @param {number | { kind?: string }[] | undefined} notes */
const asksToConfirm = (notes) => Array.isArray(notes) && notes.some((r) => r?.kind === 'ask');

/** @param {Status} status @param {{ kind?: string }[]} [reasons] */
export function statusText(status, reasons) {
  if (status === 'open') return 'Open to exchange students';
  if (status === 'note') return asksToConfirm(reasons) ? 'To confirm with NUS, with notes' : 'Open to exchange students, with notes';
  return 'Not open to exchange students';
}

/**
 * @param {Status} status
 * @param {number | string} sem
 * @param {number | { kind?: string }[]} notes
 * @param {boolean} [short]
 */
export function stampText(status, sem, notes, short = false) {
  const where = sem === 'any' || sem === '' ? 'Either semester' : semLabel(sem);
  const count = Array.isArray(notes) ? notes.length : notes;
  const n = `${count} note${count === 1 ? '' : 's'}`;
  if (status === 'open') return `${where} · Open${short ? '' : ' to exchange students'}`;
  if (status === 'note' && asksToConfirm(notes)) return `${where} · To confirm${short ? `, ${n}` : ` with NUS, with ${n}`}`;
  if (status === 'note') return `${where} · Open, ${short ? n : `with ${n}`}`;
  return `${where} · Not open${short ? '' : ' to exchange students'}`;
}

/** @type {Readonly<Record<string, string>>} */
const NOTE_LEADS = Object.freeze({
  quota: 'Places.', major: 'Your major.', semester: 'Timetable.', approval: 'Approval.', graded: 'Grading.',
  partner: 'Partner schools.', 'restricted-elsewhere': 'Rules disagree.', letter: 'Letter.', audition: 'Audition.',
  fee: 'Fee.', closed: 'Not open.', year: 'Year of study.', supply: 'Places.', ask: 'To confirm.',
});

/** @param {string} kind */
export const noteLead = (kind) => NOTE_LEADS[kind] ?? 'Note.';

/**
 * @param {Reason} r
 * @param {number | string} sem
 */
export function noteText(r, sem) {
  const s = String(sem);
  if (r.kind === 'semester') {
    return s === '1' || s === '2'
      ? `The NG list offers it in ${semLabel(s)}, but NUSMods shows no classes for it in ${semLabel(s)}. Ask the department that teaches it whether it will run.`
      : 'The NG list offers it to exchange students, but NUSMods shows no classes for it in the semester the NG list gives. Ask the department that teaches it whether it will run.';
  }
  if (r.id === NOT_IN_SEM && (s === '1' || s === '2')) return `Offered to exchange students only in ${semLabel(otherSem(s))}.`;
  return String(r.text ?? '');
}

/**
 * @param {Reason} r
 * @param {number | string} sem
 * @param {Source[] | null | undefined} sources
 */
export function reasonLine(r, sem, sources) {
  return `${noteText(r, sem).replace(/\.$/, '')} (${sourceNote(r.id, sources)}).`;
}

/**
 * @param {unknown} echo
 * @param {unknown} v
 */
export const echoHas = (echo, v) => (Array.isArray(echo) ? echo : [echo]).some((x) => String(x) === String(v));

/**
 * @param {{ semesters?: unknown, level?: unknown, credits?: unknown, faculty?: unknown }} m
 * @param {Record<string, unknown>} filters
 * @returns {string[]}
 */
export function filterMisses(m, filters) {
  const out = [];
  const sems = Array.isArray(m.semesters) ? m.semesters.map(String) : [];
  if (filters.sem !== undefined && filters.ng !== true && !sems.includes(String(filters.sem))) out.push(`it isn't offered in ${semLabel(String(filters.sem))}`);
  if (filters.level !== undefined && !echoHas(filters.level, m.level)) out.push(`it is a level ${m.level}000 course`);
  if (filters.credits !== undefined && !echoHas(filters.credits, m.credits)) out.push(`it is ${m.credits} units`);
  if (filters.faculty !== undefined && m.faculty !== filters.faculty) out.push(`it is in ${m.faculty}`);
  return out;
}

/**
 * @param {{
 *   code: string, sem: string, study: string, exchange: ExchangeEntry[] | null | undefined,
 *   sources: Source[] | null | undefined,
 *   module?: { semesters?: unknown, level?: unknown, credits?: unknown, faculty?: unknown },
 *   filters?: Record<string, unknown>,
 * }} a
 */
export function hiddenCodeLine({ code, sem, study, exchange, sources, module, filters }) {
  const entries = Array.isArray(exchange) ? exchange : [];
  /** @param {number | 'any'} s */
  const at = (s) => entries.find((e) => String(e.sem) === String(s) && e.study === study);
  const here = study ? at(sem === '' ? 'any' : Number(sem)) : undefined;
  if (!here || here.status !== 'closed') {
    const misses = module && filters ? filterMisses(module, filters) : [];
    if (!misses.length) return `A setting in this search hides ${code}, but the page can't tell which one. Try removing filters one at a time.`;
    return `${code} is hidden by your filters: ${misses.join(', and ')}.`;
  }
  const ids = here.reasons.map((r) => r.id);
  if (ids.includes(OFF_NG_LIST)) {
    return `${code} isn't on the Registrar's list of courses offered to exchange students (${sourceNote(OFF_NG_LIST, sources)}).`;
  }
  const other = sem === '' ? undefined : at(otherSem(sem));
  if (ids.length === 1 && ids[0] === NOT_IN_SEM && other && other.status !== 'closed') {
    return `${code} is open to exchange students only in ${semLabel(otherSem(sem))} (${sourceNote(NOT_IN_SEM, sources)}).`;
  }
  if (ids.includes(NOT_IN_SEM) && other?.status === 'closed' && other.reasons.length) {
    const here1 = here.reasons.map((r) => (r.id === NOT_IN_SEM
      ? `the NG list offers it in ${semLabel(otherSem(sem))} only (${sourceNote(NOT_IN_SEM, sources)}).`
      : reasonLine(r, sem, sources))).join(' ');
    const there = other.reasons.map((r) => reasonLine(r, other.sem, sources)).join(' ');
    return `${code} isn't open to ${studyPhrase(study)} in ${semLabel(sem)} or in ${semLabel(otherSem(sem))}. ${semLabel(sem)}: ${here1} ${semLabel(otherSem(sem))}: ${there}`;
  }
  const lines = here.reasons.map((r) => reasonLine(r, sem === '' ? 'any' : sem, sources));
  return `${code} isn't open to ${studyPhrase(study)} ${semPhrase(sem)}. ${lines.join(' ')}`;
}

/**
 * @param {{ sem: string, study: string, exchange: ExchangeEntry[] | null | undefined }} a
 * @returns {{ text: string, switchTo: string }}
 */
export function hiddenCodeStamp({ sem, study, exchange }) {
  const entries = Array.isArray(exchange) ? exchange : [];
  /** @param {number | 'any'} s */
  const at = (s) => entries.find((e) => String(e.sem) === String(s) && e.study === study);
  const here = study ? at(sem === '' ? 'any' : Number(sem)) : undefined;
  if (!here || here.status !== 'closed') return { text: 'Outside your filters', switchTo: '' };
  const ids = here.reasons.map((r) => r.id);
  const other = sem === '' ? undefined : at(otherSem(sem));
  const switchTo = other && other.status !== 'closed' ? String(otherSem(sem)) : '';
  if (ids.includes(OFF_NG_LIST)) return { text: 'Not for exchange students', switchTo };
  if (sem === '') return { text: 'Not open in either semester', switchTo: '' };
  if (ids.length === 1 && ids[0] === NOT_IN_SEM) return { text: `Not on the NG list for ${semLabel(sem)}`, switchTo };
  if (ids.length === 1 && ids[0] === UNPUBLISHED_UNLISTED) return { text: `Not on last year's NG list for ${semLabel(sem)}`, switchTo };
  return { text: `Not open in ${semLabel(sem)}`, switchTo };
}

export const NOT_OFFERED_STAMP = 'Not this year';

/**
 * @param {string} code
 * @param {string | null} [title]
 */
export function notOfferedLine(code, title = null) {
  return `${code}${title ? ` (${title})` : ''} isn't offered this academic year.`;
}

/**
 * @param {unknown} notOffered
 * @param {{ reason?: unknown, code?: unknown } | null | undefined} noMatch
 * @returns {string[]}
 */
export function boxNotOffered(notOffered, noMatch) {
  const named = noMatch?.reason === 'not-offered' || noMatch?.reason === 'ng-unscheduled' ? noMatch.code : null;
  return (Array.isArray(notOffered) ? notOffered.map(String) : []).filter((c) => c !== named);
}

/** @param {string} prefix */
export function prefixLabel(prefix) {
  const digits = prefix.match(/\d+$/)?.[0] ?? '';
  return digits ? `${prefix}${'x'.repeat(Math.max(0, 4 - digits.length))}` : prefix;
}

/** @param {{ prefix: string, sem: string, study: string, otherHasResults: boolean | null }} a */
export function partialCodeLine({ prefix, sem, study, otherHasResults }) {
  const where = sem && otherHasResults !== false ? semPhrase(sem) : semPhrase('');
  return `No ${prefixLabel(prefix)} course is open to ${studyPhrase(study)} ${where}.`;
}

export const MAX_PINS = 3;
const MAX_CODES = 10;

/** @param {string} query */
export function typedCodes(query) {
  const seen = [...query.matchAll(/\b([A-Za-z]{1,4}) ?(\d{4}[A-Za-z0-9]{0,5})\b/g)].map((m) => `${m[1]}${m[2]}`.toUpperCase());
  return [...new Set(seen)].slice(0, MAX_CODES);
}

const CODE_WORD = /\b[A-Za-z]{1,4} ?\d{4}[A-Za-z0-9]{0,5}\b/g;

/** @param {string} query */
export function codesOnly(query) {
  return typedCodes(query).length > 0 && query.replace(CODE_WORD, '').replace(/[\s,;+&/]+/g, '') === '';
}

/**
 * @param {string} query
 * @param {any[]} results
 * @param {string[]} pinned
 * @returns {{ count: string, rest: string }}
 */
export function codesCount(query, results, pinned) {
  const typed = typedCodes(query);
  /** @param {any} r */
  const codesOf = (r) => [String(r?.code ?? ''), ...(Array.isArray(r?.variants) ? r.variants.map((/** @type {any} */ v) => String(v?.code ?? '')) : [])];
  const top = results.findIndex((r) => !codesOf(r).some((c) => pinned.includes(c)));
  const lead = top < 0 ? results : results.slice(0, top);
  const atTop = new Set(lead.flatMap(codesOf));
  const named = typed.filter((c) => atTop.has(c));
  const others = results.length - lead.length;
  const count = `${results.length} course${results.length === 1 ? '' : 's'}`;
  const more = `${others} other match${others === 1 ? '' : 'es'}`;
  if (!named.length) return { count, rest: ` shown: other matches for the code${typed.length === 1 ? '' : 's'} you typed` };
  return { count, rest: ` shown: ${named.join(', ')}${others ? `, then ${more}` : ''}` };
}

/** @param {string[]} codes */
const andList = (codes) => (codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`);

/**
 * @param {string} query
 * @param {{ pinned: string[], hidden: string[], notOffered: string[], shown: Set<string> }} known
 */
export function unpinnedLine(query, { pinned, hidden, notOffered, shown }) {
  if (pinned.length < MAX_PINS) return null;
  const extra = typedCodes(query).filter((c) => !pinned.includes(c) && !notOffered.includes(c));
  if (!extra.length) return null;
  const rule = 'The results put at most three of the codes you type at the top: the first three that NUS offers this year.';
  const missing = extra.filter((c) => !hidden.includes(c) && !shown.has(c));
  if (!missing.length) return rule;
  const one = missing.length === 1;
  return `${rule} ${andList(missing)} ${one ? 'is' : 'are'} not in these results: search for ${one ? 'it' : 'each'} on its own.`;
}
