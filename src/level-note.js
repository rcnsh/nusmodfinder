// @ts-check

/** @typedef {import('./ng-bit.js').Study} Study */

export const LEVEL_NOTE = 'gro:level-4000';

export const GRO_LEVEL4 = 'Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very limited supply and are usually NOT available to exchange students. In order to increase the chances of securing enough courses, incoming exchange students should consider taking courses with course code starting from 1000 to 3000';

/**
 * @param {{ level?: number | null, faculty?: string | null }} course
 * @param {Study} study
 */
export function levelNoteApplies(course, study) {
  return /^ug[1-4]$/.test(study) && Number(course.level) === 4 && course.faculty !== 'Law';
}

/**
 * @param {{ level?: number | null, faculty?: string | null }} course
 * @param {Study} study
 * @returns {{ id: string, kind: string, text: string } | null}
 */
export function levelNote(course, study) {
  if (!levelNoteApplies(course, study)) return null;
  return { id: LEVEL_NOTE, kind: 'supply', text: `GRO: “${GRO_LEVEL4}”` };
}
