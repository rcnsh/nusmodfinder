// @ts-check
// Exchange-mode eligibility (docs/plans/phase4.md §2, ADR 0007): whether an
// exchange (Non-Graduating) student may take a module in a semester at a study
// level, under the NG course list and the Registrar's course restrictions.
//
// Pure, and the rules come in as an argument (data/ng-restrictions-<year>.json,
// built by scripts/build-ng-restrictions.mjs), so nothing here imports JSON:
// scripts/lib.mjs reads the file and calls this at ingest (4A), and the Worker
// only ever reads the stored result. Runs no I/O.

/** @typedef {'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad'} Study */
/** @typedef {1 | 2 | 'any'} NgSem */
/** @typedef {'open' | 'note' | 'closed'} Status */

/**
 * One rule. `match` keys are ANDed; an array key matches any of its values.
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
 * The fields eligibility reads from a normalised module.
 * @typedef {{ code: string, title: string, department: string | null, faculty: string | null,
 *   level: number | null, semesters: number[], ng: boolean, ngSemesters: number[] }} EligibilityModule
 */

/** @type {Study[]} */
export const STUDIES = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
/** @type {NgSem[]} */
export const NG_SEMS = [1, 2, 'any'];

// Built-in rule ids (not in the rules file): the NG list and rule D.
export const OFF_NG_LIST = 'ng-list:not-listed';
export const NOT_NG_IN_SEM = 'ng-list:not-in-semester';
export const SEMESTER_MISMATCH = 'ng-list:nusmods-semester-differs';
export const GRAD_LEVELS = 'D-grad-levels-closed-exchange';

/**
 * The allow-mask bit for (sem, study): sem-major, 5 studies per sem, 15 bits.
 * @param {NgSem} sem @param {Study} study
 */
export function bitOf(sem, study) {
  return 1 << (NG_SEMS.indexOf(sem) * STUDIES.length + STUDIES.indexOf(study));
}

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
    // Either semester: the semesters the course is NG-listed in, so a listing in
    // a semester the student can't take it in doesn't lift the condition.
    const sems = sem === 'any' ? m.ngSemesters.map(String) : [String(sem)];
    if (sems.some((s) => (list[s] ?? []).includes(m.code))) return false;
  }
  return true;
}

/**
 * @param {EligibilityModule} m
 * @param {{ sem: NgSem, study: Study }} ctx
 * @param {Rules} rules
 * @returns {{ status: Status, reasons: string[] }} reasons: the closing rule ids when closed, else the notes
 */
export function eligibility(m, { sem, study }, rules) {
  /** @type {string[]} */ const closed = [];
  /** @type {string[]} */ const notes = [];

  // 1. The NG list (plan §2 step 1; Jacob's Q7: off the list is closed; Q5: a
  //    NUSMods semester that differs from the NG list's is a note).
  if (!m.ng || m.ngSemesters.length === 0) closed.push(OFF_NG_LIST);
  else if (sem === 'any') {
    if (!m.ngSemesters.some((s) => m.semesters.includes(s))) notes.push(SEMESTER_MISMATCH);
  } else if (!m.ngSemesters.includes(sem)) closed.push(NOT_NG_IN_SEM);
  else if (!m.semesters.includes(sem)) notes.push(SEMESTER_MISMATCH);

  // 2. Rule D as a default: level 5000+ is closed unless an `open` rule
  //    specifies it for this study.
  const applies = (/** @type {Rule} */ r) => (!r.studies || r.studies.includes(study)) && matches(m, r.match, sem, rules.lists);
  if (m.level !== null && m.level >= 5 && !rules.rules.some((r) => r.effect === 'open' && applies(r))) closed.push(GRAD_LEVELS);

  // 3. Department and code rules: closed wins, notes accumulate.
  for (const r of rules.rules) {
    if ((r.effect !== 'closed' && r.effect !== 'note') || !applies(r)) continue;
    (r.effect === 'closed' ? closed : notes).push(r.id);
  }

  if (closed.length) return { status: 'closed', reasons: closed };
  if (notes.length) return { status: 'note', reasons: notes };
  return { status: 'open', reasons: [] };
}

/**
 * Every (sem, study) at once, as stored at ingest: `allow` has the bit set
 * where the module is shown (open or note); `rules[bit]` holds the reasons.
 * Zero means closed everywhere, so a missing or defaulted value fails closed.
 * @param {EligibilityModule} m @param {Rules} rules
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
