// @ts-check
// Exchange-mode reason texts for the Worker (docs/plans/phase4.md §2
// "Storage"): D1's ng_rules holds rule ids only; this turns them into what a
// result card shows. data/ng-reasons.json is built by
// scripts/build-ng-reasons.mjs from the restrictions data. Worker-only, like
// group-data.js: nothing here runs rule logic.
import file from '../data/ng-reasons.json';
import { NG_SEMS, OFF_NG_LIST, STUDIES } from './ng-bit.js';

/** @typedef {{ id: string, kind: string, text: string }} NgReason */

const GENERIC = 'Restricted for exchange students; see the source documents.';
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
 * The stored eligibility of a row at one bit: `open` or `note` where the bit
 * is set, `closed` where it isn't (a missing or zero ng_allow is closed).
 * @param {{ ng?: number, ng_allow?: number | null, ng_rules?: string | null }} row
 * @param {number} bit
 * @returns {{ status: 'open' | 'note' | 'closed', reasons: NgReason[] }}
 */
export function exchangeAt(row, bit) {
  /** @type {Record<string, string[]> | null} */
  let stored = null;
  try { stored = row.ng_rules ? JSON.parse(row.ng_rules) : null; } catch { /* unreadable: no reasons */ }
  const ids = stored?.[String(Math.log2(bit))] ?? (row.ng !== 1 ? [OFF_NG_LIST] : []);
  const shown = ((row.ng_allow ?? 0) & bit) !== 0;
  return { status: shown ? (ids.length ? 'note' : 'open') : 'closed', reasons: reasonsFor(ids) };
}

/**
 * Every (semester, study level), as /module/:code answers it.
 * @param {{ ng?: number, ng_allow?: number | null, ng_rules?: string | null }} row
 */
export function exchangeAll(row) {
  return NG_SEMS.flatMap((sem, s) => STUDIES.map((study, t) => ({
    sem, study, ...exchangeAt(row, 1 << (s * STUDIES.length + t)),
  })));
}
