// @ts-check
// What the page says about exchange status (Phase 5 5C, D4, C2-3, C3-1, C3-2):
// each note in full, with its source; why a typed code is not shown; a partial
// code that exchange mode empties; and the typed codes past the three that pin.
// Pure: plain text in, plain text out; test/web/explain.node.test.js.
import { semLabel } from './format.js';

/**
 * A stored reason, as /search and /module answer it (src/ng-reasons.js).
 * @typedef {{ id: string, kind: string, text: string }} Reason
 * @typedef {'open' | 'note' | 'closed'} Status
 * @typedef {{ sem: number | 'any', study: string, status: Status, reasons: Reason[] }} ExchangeEntry
 *   one of /module/:code's `exchange` entries
 * @typedef {{ name?: unknown, updatedAsAt?: unknown, url?: unknown }} Source /facets' `ngSources` entry
 */

/** The reason ids the NG list itself gives (src/ng-bit.js, src/eligibility.js); every other comes from the restrictions. */
const NG_LIST_PREFIX = 'ng-list:';
const OFF_NG_LIST = 'ng-list:not-listed';
const NOT_IN_SEM = 'ng-list:not-in-semester';

/** @type {Readonly<Record<string, string>>} */
const STUDY_PHRASES = Object.freeze({
  ug1: 'at 1st year', ug2: 'at 2nd year', ug3: 'at 3rd year', ug4: 'at 4th year or later', grad: 'for graduate students',
});

/** "at 2nd year": the study level, after "open to exchange students in Sem 1". @param {string} study */
export const studyPhrase = (study) => STUDY_PHRASES[study] ?? '';

/** @param {string | number} sem 1 or 2 */
const otherSem = (sem) => (String(sem) === '1' ? 2 : 1);

/** @param {string | number} sem '' (or 'any') for both semesters */
const semPhrase = (sem) => (sem === '' || sem === 'any' ? 'in either semester' : `in ${semLabel(sem)}`);

/**
 * The source a reason comes from, with its "updated as at" date when /facets
 * gave one: "NG list, updated 01 Sep 2026" or "NG restrictions, …".
 * @param {string} id the reason id
 * @param {Source[] | null | undefined} sources /facets' `ngSources`, or null when it failed
 */
export function sourceNote(id, sources) {
  const restrictions = !id.startsWith(NG_LIST_PREFIX);
  const label = restrictions ? 'NG restrictions' : 'NG list';
  const src = (sources ?? []).find((s) => /restriction/i.test(String(s?.name ?? '')) === restrictions);
  const date = src && typeof src.updatedAsAt === 'string' && src.updatedAsAt ? src.updatedAsAt : '';
  return date ? `${label}, updated ${date}` : label;
}

/** @param {Status} status */
export function statusText(status) {
  if (status === 'open') return 'Open to exchange students';
  if (status === 'note') return 'Open to exchange students, with conditions';
  return 'Not open to exchange students';
}

/**
 * A semester's status as direction D's stamp says it: "Sem 1 · Open, with 2
 * notes", or, where two stamps sit side by side, "Sem 1 · Open, 2 notes".
 * @param {Status} status
 * @param {number | string} sem 1, 2, or 'any' (no semester chosen)
 * @param {number} notes how many notes the semester has
 * @param {boolean} [short] the both-semesters card's shorter form
 */
export function stampText(status, sem, notes, short = false) {
  const where = sem === 'any' || sem === '' ? 'Either semester' : semLabel(sem);
  const n = `${notes} note${notes === 1 ? '' : 's'}`;
  if (status === 'open') return `${where} · Open${short ? '' : ' to exchange students'}`;
  if (status === 'note') return `${where} · Open, ${short ? n : `with ${n}`}`;
  return `${where} · Not open${short ? '' : ' to exchange students'}`;
}

/** @type {Readonly<Record<string, string>>} */
const NOTE_LEADS = Object.freeze({
  quota: 'Places.', major: 'Your major.', semester: 'Timetable.', approval: 'Approval.', graded: 'Grading.',
  partner: 'Partner schools.', 'restricted-elsewhere': 'Conflicting rules.', letter: 'Letter.', audition: 'Audition.',
  fee: 'Fee.', closed: 'Not open.',
});

/**
 * The lead-in word a note starts with on the card and in the detail ("Places."
 * for a quota), so a student can scan what each condition is about.
 * @param {string} kind the reason's kind (src/ng-reasons.js)
 */
export const noteLead = (kind) => NOTE_LEADS[kind] ?? 'Note.';

/**
 * A note in full (C2-3). The `semester` note is worded as what to do; "the
 * other semester" is named.
 * @param {Reason} r
 * @param {number | string} sem the semester the note is about: 1, 2, or 'any'
 */
export function noteText(r, sem) {
  const s = String(sem);
  if (r.kind === 'semester') {
    return s === '1' || s === '2'
      ? `Not on NUSMods' timetable for ${semLabel(s)}: check with the department.`
      : "Not on NUSMods' timetable in the semester the NG list gives: check with the department.";
  }
  if (r.id === NOT_IN_SEM && (s === '1' || s === '2')) return `Offered to exchange students only in ${semLabel(otherSem(s))}.`;
  return String(r.text ?? '');
}

/**
 * A note with its source: "Limited quota (NG restrictions, updated 31 Aug 2026)."
 * @param {Reason} r
 * @param {number | string} sem
 * @param {Source[] | null | undefined} sources
 */
export function reasonLine(r, sem, sources) {
  return `${noteText(r, sem).replace(/\.$/, '')} (${sourceNote(r.id, sources)}).`;
}

/**
 * The filters a course fails, as clauses ("it isn't offered in Sem 1"). In
 * exchange mode the NG list decides the semester, not NUSMods' timetable
 * (src/search.js localMatchesFilters), so the semester is never blamed there.
 * @param {{ semesters?: unknown, level?: unknown, credits?: unknown, faculty?: unknown }} m /module/:code's row
 * @param {Record<string, unknown>} filters /search's `filters` echo
 * @returns {string[]}
 */
export function filterMisses(m, filters) {
  const out = [];
  const sems = Array.isArray(m.semesters) ? m.semesters.map(String) : [];
  if (filters.sem !== undefined && filters.ng !== true && !sems.includes(String(filters.sem))) out.push(`it isn't offered in ${semLabel(String(filters.sem))}`);
  if (filters.level !== undefined && String(m.level) !== String(filters.level)) out.push(`it is a level ${m.level}000 course`);
  if (filters.credits !== undefined && String(m.credits) !== String(filters.credits)) out.push(`it is ${m.credits} units`);
  if (filters.faculty !== undefined && m.faculty !== filters.faculty) out.push(`it is in ${m.faculty}`);
  return out;
}

/**
 * Why a typed code is not shown (D4), from its own stored reasons at the
 * chosen semester and year (C3-1). Never a result card: SC1 holds.
 * @param {{
 *   code: string, sem: string, study: string, exchange: ExchangeEntry[] | null | undefined,
 *   sources: Source[] | null | undefined,
 *   module?: { semesters?: unknown, level?: unknown, credits?: unknown, faculty?: unknown },
 *   filters?: Record<string, unknown>,
 * }} a `sem` '' for both semesters; `study` '' outside exchange mode
 */
export function hiddenCodeLine({ code, sem, study, exchange, sources, module, filters }) {
  const entries = Array.isArray(exchange) ? exchange : [];
  /** @param {number | 'any'} s */
  const at = (s) => entries.find((e) => String(e.sem) === String(s) && e.study === study);
  const here = study ? at(sem === '' ? 'any' : Number(sem)) : undefined;
  if (!here || here.status !== 'closed') {
    const misses = module && filters ? filterMisses(module, filters) : [];
    if (!misses.length) return `${code} doesn't match this search's filters.`;
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
  const lines = here.reasons.map((r) => reasonLine(r, sem === '' ? 'any' : sem, sources));
  // On the list only for the other semester, and closed there too: say why there as well.
  if (ids.includes(NOT_IN_SEM) && other?.status === 'closed' && other.reasons.length) {
    const why = other.reasons.map((r) => reasonLine(r, other.sem, sources)).join(' ');
    lines.push(`In ${semLabel(otherSem(sem))}: ${why}`);
  }
  return `${code} isn't open to exchange students ${semPhrase(sem)} ${studyPhrase(study)}. ${lines.join(' ')}`;
}

/**
 * A catalogue-only code (`notOffered`, or a whole-query `not-offered` noMatch).
 * @param {string} code
 * @param {string | null} [title]
 */
export function notOfferedLine(code, title = null) {
  return `${code}${title ? ` (${title})` : ''} isn't offered this academic year.`;
}

/** "CS32" → "CS32xx": a partial code, padded to four digits. @param {string} prefix */
export function prefixLabel(prefix) {
  const digits = prefix.match(/\d+$/)?.[0] ?? '';
  return digits ? `${prefix}${'x'.repeat(Math.max(0, 4 - digits.length))}` : prefix;
}

/**
 * A partial code exchange mode empties (C3-2). With one semester chosen and
 * the other's results unknown or present, the chosen semester (the page offers
 * the other with a button when it has results); with both chosen, or the other
 * empty too, either semester. Never "loosen a filter": the filter is
 * eligibility.
 * @param {{ prefix: string, sem: string, study: string, otherHasResults: boolean | null }} a
 */
export function partialCodeLine({ prefix, sem, study, otherHasResults }) {
  const where = sem && otherHasResults !== false ? semPhrase(sem) : semPhrase('');
  return `No ${prefixLabel(prefix)} course is open to exchange students ${where} ${studyPhrase(study)}.`;
}

/** /search pins at most this many typed codes (src/query-intent.js MAX_PINS). */
export const MAX_PINS = 3;
/** /search reads at most this many typed codes (src/query-intent.js MAX_CODES). */
const MAX_CODES = 10;

/**
 * The code-shaped words typed, in order, upper-cased, once each; letters and
 * digits split by one space are one code, as /search joins them (`cs 3244`).
 * The server also checks each prefix against the catalogue, which the page
 * can't; unpinnedLine only asks this when three codes already pinned.
 * @param {string} query
 */
export function typedCodes(query) {
  const seen = [...query.matchAll(/\b([A-Za-z]{1,4}) ?(\d{4}[A-Za-z0-9]{0,5})\b/g)].map((m) => `${m[1]}${m[2]}`.toUpperCase());
  return [...new Set(seen)].slice(0, MAX_CODES);
}

/** @param {string[]} codes */
const andList = (codes) => (codes.length < 2 ? codes.join('') : `${codes.slice(0, -1).join(', ')} and ${codes[codes.length - 1]}`);

/**
 * Only the first MAX_PINS typed codes offered this year pin (5C-api); a later
 * one that passes the filters is neither pinned nor hidden, so it may not
 * appear. /search's `interpreted.pin` holds every offered code up to three, so
 * with fewer pinned no offered code was left out: null. Else, when another
 * typed code (not one reported as not offered) exists, the rule, and the
 * typed codes neither shown nor explained.
 * @param {string} query
 * @param {{ pinned: string[], hidden: string[], notOffered: string[], shown: Set<string> }} known
 */
export function unpinnedLine(query, { pinned, hidden, notOffered, shown }) {
  if (pinned.length < MAX_PINS) return null;
  const extra = typedCodes(query).filter((c) => !pinned.includes(c) && !notOffered.includes(c));
  if (!extra.length) return null;
  const rule = 'Only the first three course codes you type that are offered this year are pinned to the top of the results.';
  const missing = extra.filter((c) => !hidden.includes(c) && !shown.has(c));
  if (!missing.length) return rule;
  const one = missing.length === 1;
  return `${rule} ${andList(missing)} ${one ? 'is' : 'are'} not in these results: search for ${one ? 'it' : 'each'} on its own.`;
}
