// @ts-check

import { NG_SEMS, OFF_NG_LIST, STUDIES, bitOf } from './ng-bit.js';

export { NG_SEMS, OFF_NG_LIST, STUDIES, bitOf };
/** @typedef {import('./ng-bit.js').Study} Study */
/** @typedef {import('./ng-bit.js').NgSem} NgSem */
/** @typedef {'open' | 'note' | 'closed'} Status */

/**
 * @typedef {{
 *   codes?: string[], codeRe?: string, notCodeRe?: string, departments?: string[], faculties?: string[],
 *   levels?: number[], titleRe?: string, notInList?: string,
 * }} RuleMatch
 * @typedef {{
 *   id: string, effect: 'closed' | 'note' | 'open' | 'info', note?: string, studies?: Study[],
 *   match: RuleMatch, reason: string,
 * }} Rule
 * @typedef {{ rules: Rule[], lists?: Record<string, Record<string, string[]>> }} Rules
 */

/**
 * @typedef {{ code: string, title: string, department: string | null, faculty: string | null,
 *   level: number | null, semesters: number[], ng: boolean, ngSemesters: number[], ngUnpublished?: number[] }} EligibilityModule
 */

export const NOT_NG_IN_SEM = 'ng-list:not-in-semester';
export const SEMESTER_MISMATCH = 'ng-list:nusmods-semester-differs';
export const GRAD_LEVELS = 'D-grad-levels-closed-exchange';
export const UNPUBLISHED_SEM = 'ng:unpublished-sem';
export const UNPUBLISHED_UNLISTED = 'ng:unpublished-sem-unlisted';

/** @type {Map<string, RegExp>} */
const reCache = new Map();
/** @param {string} source */
function re(source) {
  let r = reCache.get(source);
  if (!r) { r = new RegExp(source); reCache.set(source, r); }
  return r;
}
/**
 * @param {EligibilityModule} m @param {RuleMatch} match @param {NgSem} sem
 * @param {Rules['lists']} lists
 */
export function matches(m, match, sem, lists) {
  if (match.codes && !match.codes.includes(m.code)) return false;
  if (match.codeRe && !re(match.codeRe).test(m.code)) return false;
  if (match.notCodeRe && re(match.notCodeRe).test(m.code)) return false;
  if (match.departments && !(m.department !== null && match.departments.includes(m.department))) return false;
  if (match.faculties && !(m.faculty !== null && match.faculties.includes(m.faculty))) return false;
  if (match.levels && !(m.level !== null && match.levels.includes(m.level))) return false;
  if (match.titleRe && !re(match.titleRe).test(m.title)) return false;
  if (match.notInList) {
    const list = lists?.[match.notInList];
    if (!list) throw new Error(`rules: list ${match.notInList} is missing`);
    const sems = sem === 'any' ? m.ngSemesters.map(String) : [String(sem)];
    if (sems.some((s) => (list[s] ?? []).includes(m.code))) return false;
  }
  return true;
}

/**
 * @param {EligibilityModule} m
 * @param {{ sem: NgSem, study: Study }} ctx
 * @param {Rules} rules
 * @returns {{ status: Status, reasons: string[] }}
 */
export function eligibility(m, { sem, study }, rules) {
  /** @type {string[]} */ const closed = [];
  /** @type {string[]} */ const notes = [];

  const unpublished = m.ngUnpublished ?? [];
  if (!m.ng || m.ngSemesters.length === 0) closed.push(OFF_NG_LIST);
  else if (sem === 'any') {
    if (!m.ngSemesters.some((s) => m.semesters.includes(s))) notes.push(SEMESTER_MISMATCH);
    if (unpublished.length && !m.ngSemesters.some((s) => m.semesters.includes(s) && !unpublished.includes(s))
      && m.ngSemesters.some((s) => unpublished.includes(s))) notes.push(UNPUBLISHED_SEM);
  } else if (!m.ngSemesters.includes(sem)) closed.push(unpublished.includes(sem) ? UNPUBLISHED_UNLISTED : NOT_NG_IN_SEM);
  else {
    if (!m.semesters.includes(sem)) notes.push(SEMESTER_MISMATCH);
    if (unpublished.includes(sem)) notes.push(UNPUBLISHED_SEM);
  }

  const applies = (/** @type {Rule} */ r) => (!r.studies || r.studies.includes(study)) && matches(m, r.match, sem, rules.lists);
  if (m.level !== null && m.level >= 5 && !rules.rules.some((r) => r.effect === 'open' && applies(r))) closed.push(GRAD_LEVELS);

  for (const r of rules.rules) {
    if ((r.effect !== 'closed' && r.effect !== 'note') || !applies(r)) continue;
    (r.effect === 'closed' ? closed : notes).push(r.id);
  }

  if (closed.length) return { status: 'closed', reasons: closed };
  if (notes.length) return { status: 'note', reasons: notes };
  return { status: 'open', reasons: [] };
}

/**
 * @param {EligibilityModule} m
 * @param {Rules} rules
 * @returns {{ allow: number, rules: Record<string, { status: Status, reasons: string[] }> }}
 */
export function eligibilityMask(m, rules) {
  let allow = 0;
  /** @type {Record<string, { status: Status, reasons: string[] }>} */
  const byBit = {};
  for (const sem of NG_SEMS) {
    for (const study of STUDIES) {
      const e = eligibility(m, { sem, study }, rules);
      const bit = bitOf(sem, study);
      if (e.status !== 'closed') allow |= bit;
      byBit[String(Math.log2(bit))] = e;
    }
  }
  return { allow, rules: byBit };
}

/**
 * @param {EligibilityModule} m
 * @param {Rules} rules
 * @returns {{ ngAllow: number, ngRules: Record<string, string[]> | null }}
 */
export function storedEligibility(m, rules) {
  const { allow, rules: byBit } = eligibilityMask(m, rules);
  if (!m.ng || m.ngSemesters.length === 0) return { ngAllow: 0, ngRules: null };
  /** @type {Record<string, string[]>} */
  const kept = {};
  for (const [bit, e] of Object.entries(byBit)) if (e.reasons.length) kept[bit] = e.reasons;
  return { ngAllow: allow, ngRules: kept };
}
