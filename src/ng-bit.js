// @ts-check
// The exchange-mode allow-mask bit: one
// per (semester, study level), sem-major, 15 in all. Shared by ingest
// (src/eligibility.js, which computes the mask) and the Worker (every search
// path tests the one bit), which runs no rule logic and never imports
// eligibility.js.

/** @typedef {'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad'} Study */
/** @typedef {1 | 2 | 'any'} NgSem */

/** The reason id for a course off the NG list (stored as ng_rules NULL). */
export const OFF_NG_LIST = 'ng-list:not-listed';

/** @type {Study[]} */
export const STUDIES = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
/** @type {NgSem[]} */
export const NG_SEMS = [1, 2, 'any'];

/**
 * The allow-mask bit for (sem, study).
 * @param {NgSem} sem @param {Study} study
 */
export function bitOf(sem, study) {
  return 1 << (NG_SEMS.indexOf(sem) * STUDIES.length + STUDIES.indexOf(study));
}

/**
 * The bit an exchange-mode filter tests, or null outside exchange mode. `sem`
 * 1 or 2 picks that semester; unset is "either" (sem 3 and 4 never get here:
 * /search answers them `ng-special-term`).
 * @param {{ ng?: boolean, sem?: number, study?: Study }} echo
 * @returns {number | null}
 */
export function ngBit(echo) {
  if (echo.ng !== true || echo.study === undefined) return null;
  const sem = echo.sem === 1 || echo.sem === 2 ? echo.sem : echo.sem === undefined ? 'any' : null;
  if (sem === null) throw new RangeError(`exchange mode has no bit for sem ${echo.sem}`);
  return bitOf(sem, echo.study);
}
