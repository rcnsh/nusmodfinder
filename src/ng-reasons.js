// @ts-check
// Exchange-mode reason texts for the Worker: D1's ng_rules holds rule ids only; this turns them into what a
// result card shows. data/ng-reasons.json is built by
// scripts/build-ng-reasons.mjs from the restrictions data. Worker-only, like
// group-data.js: nothing here runs rule logic.
import file from '../data/ng-reasons.json';
import { NG_SEMS, OFF_NG_LIST, STUDIES } from './ng-bit.js';
import { levelNote } from './level-note.js';
import { yearNote } from './year-note.js';

/** @typedef {{ id: string, kind: string, text: string }} NgReason */
/**
 * The columns exchange status reads: /module/:code's row has `prerequisite`,
 * a /search row `year_prereq` (src/modules.js RESULT_COLUMNS); both have
 * `level` and `faculty`, for GRO's level note.
 * @typedef {{ ng?: number, ng_allow?: number | null, ng_rules?: string | null,
 *   prerequisite?: string | null, year_prereq?: string | null,
 *   level?: number | null, faculty?: string | null }} ExchangeRow
 */

const GENERIC = "NUS limits who can take this course, and this site can't show the rule. Read NUS's course restrictions for exchange students (linked at the bottom of the page), or ask NUS.";
/** @type {Record<string, { kind: string, text: string, cite: string }>} */
const REASONS = file.reasons;

/**
 * The texts for stored rule ids, in order. An id this build doesn't know (a
 * row ingested under newer rules) gets a generic text, never an error.
 * @param {string[]} ids
 * @returns {NgReason[]}
 */
export function reasonsFor(ids) {
  return ids.map((id) => {
    const r = REASONS[id];
    return r ? { id, kind: r.kind, text: r.text } : { id, kind: 'unknown', text: GENERIC };
  });
}

/** @param {string} id */
export const knownReason = (id) => Object.hasOwn(REASONS, id);

/** The source documents with their "updated as at" dates (/facets). */
export const NG_SOURCES = file.sources;

/**
 * NUS's rules about courses off the exchange list, each with the scope it
 * states (/facets' `offListRules`).
 * @type {{ id: string, text: string, scope: { departments?: string[], faculties?: string[], levels?: number[] } }[]}
 */
export const OFF_LIST_RULES = file.offListRules;

/** The acad year the reason texts were built for: /module/:code's `acadYear` when nothing else names one. */
export const NG_ACAD_YEAR = file.acadYear;

/**
 * The eligibility of a row at one bit: `open` or `note` where the bit is set,
 * `closed` where it isn't (a missing or zero ng_allow is closed), with the
 * stored reasons. A shown course also gets the year-of-study note (ADR 0007,
 * src/year-note.js) from its prerequisite, and GRO's level 4000 note
 * (ADR 0007, src/level-note.js) from its level and faculty, each read now,
 * never stored: they add notes and never close or open anything, so the allow
 * mask, the filters and the order stay the stored ones.
 * @param {ExchangeRow} row
 * @param {number} bit
 * @returns {{ status: 'open' | 'note' | 'closed', reasons: NgReason[] }}
 */
export function exchangeAt(row, bit) {
  /** @type {Record<string, string[]> | null} */
  let stored = null;
  const index = Math.log2(bit);
  try { stored = row.ng_rules ? JSON.parse(row.ng_rules) : null; } catch { /* unreadable: no reasons */ }
  const ids = stored?.[String(index)] ?? (row.ng !== 1 ? [OFF_NG_LIST] : []);
  const shown = ((row.ng_allow ?? 0) & bit) !== 0;
  const reasons = reasonsFor(ids);
  if (!shown) return { status: 'closed', reasons };
  const study = STUDIES[index % STUDIES.length];
  const year = yearNote(row.prerequisite ?? row.year_prereq, study);
  if (year) reasons.push(year);
  const level = levelNote(row, study);
  if (level) reasons.push(level);
  return { status: reasons.length ? 'note' : 'open', reasons };
}

/**
 * Every (semester, study level), as /module/:code answers it.
 * @param {ExchangeRow} row
 */
export function exchangeAll(row) {
  return NG_SEMS.flatMap((sem, s) => STUDIES.map((study, t) => ({
    sem, study, ...exchangeAt(row, 1 << (s * STUDIES.length + t)),
  })));
}
