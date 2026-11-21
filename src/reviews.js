// @ts-check
import file from '../data/reviews.json';

/** @typedef {{ n: number, latest: string, overall: number | null, workload: number | null, difficulty: number | null, teaching: number | null }} CourseReviews */

const courses = /** @type {Record<string, CourseReviews>} */ (file.courses);

/**
 * @param {string} code
 * @returns {CourseReviews | null}
 */
export function reviewsOf(code) {
  return Object.hasOwn(courses, code) ? courses[code] : null;
}
