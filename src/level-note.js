// @ts-check
// ADR 0007: NUS Global's (GRO's) sentence on higher-level undergraduate courses reads as a
// condition, like a Registrar quota note ("places limited"): a level 4000
// course it covers is "Open, with 1 note", the note is GRO's sentence with GRO
// named, and the shortlist counts it, "if NUS accepts you into it".
//
// The scope, from the sources:
// - "Higher level undergraduate courses (e.g. course code starting from 4000
//   & above)": NUS's undergraduate courses run from level 1000 to 4000 (the
//   "Exchange at NUS" brochure: "1000–3000: Undergraduate courses; 4000:
//   Honours courses; 5000–6000: Not open to exchange students"; the
//   Registrar's rule D: "Level 5000 and 6000 courses are graduate courses").
//   So the note covers level 4 (`level` is the code's first digit, CS4212 is
//   4). A graduate course is left to rule D and the departments' rules.
// - Undergraduate exchange students only (ug1 to ug4): GRO's course list is
//   of "courses available to undergraduate exchange students", so a graduate
//   gets no note.
// - Not Law: the Registrar's §5 opens only LL4 electives to exchange
//   students, so every Law course on the list is level 4000, and NUS Law
//   registers the students it invited itself.
// - Only where the course is shown: like the year-of-study note (src/year-note.js) it is
//   computed per request in exchangeAt, never stored, and never closes or
//   opens anything, so the allow mask, the filters and the ranking stay the
//   stored ones.
// The exchange-eligibility oracle (test/oracle/oracle.mjs) reads it on its own.

/** @typedef {import('./ng-bit.js').Study} Study */

/** The reason id of the note. Never stored in D1: computed per request. */
export const LEVEL_NOTE = 'gro:level-4000';

/** GRO, "Incoming Exchange Students", word for word. */
export const GRO_LEVEL4 = 'Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very limited supply and are usually NOT available to exchange students. In order to increase the chances of securing enough courses, incoming exchange students should consider taking courses with course code starting from 1000 to 3000';

/**
 * Whether GRO's sentence covers a course for a student at `study`.
 * @param {{ level?: number | null, faculty?: string | null }} course
 * @param {Study} study
 */
export function levelNoteApplies(course, study) {
  return /^ug[1-4]$/.test(study) && Number(course.level) === 4 && course.faculty !== 'Law';
}

/**
 * The note for a course at `study`, or null.
 * @param {{ level?: number | null, faculty?: string | null }} course
 * @param {Study} study
 * @returns {{ id: string, kind: string, text: string } | null}
 */
export function levelNote(course, study) {
  if (!levelNoteApplies(course, study)) return null;
  return { id: LEVEL_NOTE, kind: 'supply', text: `GRO: “${GRO_LEVEL4}”` };
}
