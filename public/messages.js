// @ts-check

import { quoteUser } from './format.js';

const TRY_AGAIN = 'Try again in a moment.';

/** @type {Readonly<Record<string, string>>} */
export const ERROR_SENTENCES = Object.freeze({
  bad_request: 'That search could not be run. Check the query and the filters, then try again.',
  'study-required': 'Choose your year of study to see the courses open to you as an exchange student.',
  rate_limited: 'Too many searches from your connection. Try again in a minute.',
  cross_site: 'This search was sent from another website, so it was not run. Open NUS Mod Finder itself to search.',
  upstream_failure: `The search service could not reach its course data. ${TRY_AGAIN}`,
  internal: `Something went wrong in the search service. ${TRY_AGAIN}`,
  not_found: 'This page may be out of date. Reload it and try again.',
  unauthorized: 'This page may be out of date. Reload it and try again.',
  timeout: 'The search took too long to answer. Try again, or try a shorter query.',
  network: 'Could not reach the search service. Check your connection and try again.',
  not_json: `The search service answered with an error page. ${TRY_AGAIN}`,
  http: `The search service had a problem. ${TRY_AGAIN}`,
});

/** @param {number} seconds */
function retryIn(seconds) {
  if (seconds <= 0) return 'Try again now.';
  if (seconds < 90) return `Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`;
  return `Try again in ${Math.ceil(seconds / 60)} minutes.`;
}

/**
 * @param {import('./api.js').ApiError} error
 * @returns {string}
 */
export function errorSentence(error) {
  if (error.code === 'rate_limited' && typeof error.retryAfter === 'number') {
    return `Too many searches from your connection. ${retryIn(error.retryAfter)}`;
  }
  return Object.hasOwn(ERROR_SENTENCES, error.code) ? ERROR_SENTENCES[error.code] : ERROR_SENTENCES.http;
}

/**
 * @typedef {{ reason: string, code?: string, title?: string | null, ngSemesters?: unknown }} NoMatch
 * @typedef {{ query: string, noMatch?: NoMatch | null }} NoMatchBody
 */

const quoted = quoteUser;

/** @param {unknown} sems */
const listedFor = (sems) => {
  const list = Array.isArray(sems) ? sems.filter((s) => s === 1 || s === 2) : [];
  return list.length ? list.map((s) => `Sem ${s}`).join(' and ') : 'exchange students';
};

/** @type {Readonly<Record<string, (body: NoMatchBody, nm: NoMatch) => string>>} */
export const NO_MATCH = Object.freeze({
  'ng-special-term': () => "The NG list covers only Sem 1 and Sem 2, not NUS's special terms (short terms in the vacation). Choose Sem 1 or Sem 2.",
  'not-offered': (_b, nm) => `${nm.code}${nm.title ? ` (${nm.title})` : ''} isn't offered this academic year.`,
  'unknown-code': (_b, nm) => `There is no course ${nm.code} in the NUS catalogue. Check the code.`,
  'ng-unscheduled': (_b, nm) => `NUS lists ${nm.code}${nm.title ? ` (${nm.title})` : ''} for ${listedFor(nm.ngSemesters)}, but NUSMods shows no classes for it this academic year.`,
  'no-signal': (b) => `Nothing in the catalogue matches ${quoted(b.query)}. Try other words for the topic.`,
});

/** @param {NoMatchBody} body */
export function noMatchSentence(body) {
  const nm = body.noMatch;
  if (nm && Object.hasOwn(NO_MATCH, nm.reason)) return NO_MATCH[nm.reason](body, nm);
  return `No courses match ${quoted(body.query)}.`;
}

/** @param {{ source: string, reason: string } | null | undefined} degraded */
export function degradedNote(degraded) {
  return degraded ? 'Search is in a simpler mode right now: it finds only courses that contain the words you typed. Try the course name or code, or search again later.' : null;
}
