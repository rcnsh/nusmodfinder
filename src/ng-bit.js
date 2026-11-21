// @ts-check

/** @typedef {'ug1' | 'ug2' | 'ug3' | 'ug4' | 'grad'} Study */
/** @typedef {1 | 2 | 'any'} NgSem */

export const OFF_NG_LIST = 'ng-list:not-listed';

/** @type {Study[]} */
export const STUDIES = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
/** @type {NgSem[]} */
export const NG_SEMS = [1, 2, 'any'];

/**
 * @param {NgSem} sem
 * @param {Study} study
 */
export function bitOf(sem, study) {
  return 1 << (NG_SEMS.indexOf(sem) * STUDIES.length + STUDIES.indexOf(study));
}

/**
 * @param {{ ng?: boolean, sem?: number, study?: Study }} echo
 * @returns {number | null}
 */
export function ngBit(echo) {
  if (echo.ng !== true || echo.study === undefined) return null;
  const sem = echo.sem === 1 || echo.sem === 2 ? echo.sem : echo.sem === undefined ? 'any' : null;
  if (sem === null) throw new RangeError(`exchange mode has no bit for sem ${echo.sem}`);
  return bitOf(sem, echo.study);
}
