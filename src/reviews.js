// @ts-check
// Course review scores (ADR 0018), bundled from data/reviews.json (scripts/reviews.mjs builds
// it): per course, how many student reviews NUSMods has, the latest academic year one is about,
// and the age-weighted mean of each 1-5 score (null where reviews don't say). Display only:
// nothing in search or ranking reads it.
import file from '../data/reviews.json';

/** @typedef {{ n: number, latest: string, overall: number | null, workload: number | null, difficulty: number | null, teaching: number | null }} CourseReviews */

const courses = /** @type {Record<string, CourseReviews>} */ (file.courses);

/**
 * A course's review scores, or null when NUSMods has no review of it.
 * @param {string} code
 * @returns {CourseReviews | null}
 */
export function reviewsOf(code) {
  return Object.hasOwn(courses, code) ? courses[code] : null;
}
