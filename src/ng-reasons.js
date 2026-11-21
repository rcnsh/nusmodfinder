// @ts-check
import file from '../data/ng-reasons.json';
import { NG_SEMS, OFF_NG_LIST, STUDIES } from './ng-bit.js';
import { levelNote } from './level-note.js';
import { yearNote } from './year-note.js';

/** @typedef {{ id: string, kind: string, text: string }} NgReason */
/**
 * @typedef {{ ng?: number, ng_allow?: number | null, ng_rules?: string | null,
 *   prerequisite?: string | null, year_prereq?: string | null,
 *   level?: number | null, faculty?: string | null }} ExchangeRow
 */

const GENERIC = "NUS limits who can take this course, and this site can't show the rule. Read NUS's course restrictions for exchange students (linked at the bottom of the page), or ask NUS.";
/** @type {Record<string, { kind: string, text: string, cite: string }>} */
const REASONS = file.reasons;

/**
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

export const NG_SOURCES = file.sources;

/** @type {{ id: string, text: string, scope: { departments?: string[], faculties?: string[], levels?: number[] } }[]} */
export const OFF_LIST_RULES = file.offListRules;

export const NG_ACAD_YEAR = file.acadYear;

/**
 * @param {ExchangeRow} row
 * @param {number} bit
 * @returns {{ status: 'open' | 'note' | 'closed', reasons: NgReason[] }}
 */
export function exchangeAt(row, bit) {
  /** @type {Record<string, string[]> | null} */
  let stored = null;
  const index = Math.log2(bit);
  try { stored = row.ng_rules ? JSON.parse(row.ng_rules) : null; } catch {}
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

/** @param {ExchangeRow} row */
export function exchangeAll(row) {
  return NG_SEMS.flatMap((sem, s) => STUDIES.map((study, t) => ({
    sem, study, ...exchangeAt(row, 1 << (s * STUDIES.length + t)),
  })));
}
