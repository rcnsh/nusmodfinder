// @ts-check
// Exchange-mode reason texts for the Worker (docs/plans/phase4.md §2
// "Storage"): D1's ng_rules holds rule ids only; this turns them into what a
// result card shows. data/ng-reasons.json is built by
// scripts/build-ng-reasons.mjs from the restrictions data. Worker-only, like
// group-data.js: nothing here runs rule logic.
import file from '../data/ng-reasons.json';
import { NG_SEMS, OFF_NG_LIST, STUDIES } from './ng-bit.js';
import { yearNote } from './year-note.js';

/** @typedef {{ id: string, kind: string, text: string }} NgReason */
/**
 * The columns exchange status reads: /module/:code's row has `prerequisite`,
 * a /search row `year_prereq` (src/modules.js RESULT_COLUMNS).
 * @typedef {{ ng?: number, ng_allow?: number | null, ng_rules?: string | null,
 *   prerequisite?: string | null, year_prereq?: string | null }} ExchangeRow
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
 * 6A: NUS's rules about courses off the exchange list, each with the scope it
 * states (/facets' `offListRules`).
 * @type {{ id: string, text: string, scope: { departments?: string[], faculties?: string[], levels?: number[] } }[]}
 */
export const OFF_LIST_RULES = file.offListRules;

/** The acad year the reason texts were built for: /module/:code's `acadYear` when nothing else names one (6A). */
export const NG_ACAD_YEAR = file.acadYear;

/**
 * The eligibility of a row at one bit: `open` or `note` where the bit is set,
 * `closed` where it isn't (a missing or zero ng_allow is closed), with the
 * stored reasons. A shown course also gets R3's year-of-study note (ADR 0008,
 * src/year-note.js) from its prerequisite, read now, never stored: it adds a
 * note and never closes or opens anything, so the allow mask, the filters and
 * the order stay the stored ones.
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
  const year = yearNote(row.prerequisite ?? row.year_prereq, STUDIES[index % STUDIES.length]);
  if (year) reasons.push(year);
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
