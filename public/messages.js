// @ts-check
// Plain sentences for every error and every no-match answer (Phase 5 5B, F7).
// The page never shows a raw code (`rate_limited`) or the server's message.
// test/web/messages.node.test.js reads src/ for every code and reason the
// Worker can answer, so a new one fails the tests until it has a sentence here.

const TRY_AGAIN = 'Try again in a moment.';

/**
 * By error code: the Worker's `error` field, then the fetch layer's own
 * (public/api.js). `rate_limited` is built from Retry-After instead.
 * @type {Readonly<Record<string, string>>}
 */
export const ERROR_SENTENCES = Object.freeze({
  // The Worker's (src/http.js, src/index.js, src/search.js, src/modules.js, src/ingest.js).
  bad_request: 'That search could not be run. Check the query and the filters, then try again.',
  'study-required': 'Choose your year of study to see the courses open to you as an exchange student.',
  rate_limited: 'Too many searches from your connection. Try again in a minute.',
  upstream_failure: `The search service could not reach its course data. ${TRY_AGAIN}`,
  internal: `Something went wrong in the search service. ${TRY_AGAIN}`,
  not_found: 'The search service did not recognise this request. Reload the page and try again.',
  unauthorized: 'The search service did not recognise this request. Reload the page and try again.',
  // The fetch layer's.
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
 * @typedef {{ reason: string, code?: string, title?: string | null }} NoMatch
 * @typedef {{ query: string, noMatch?: NoMatch | null }} NoMatchBody
 */

/** @param {string} q */
const quoted = (q) => `“${q}”`;

/**
 * By noMatch reason (src/search.js, src/query-intent.js).
 * @type {Readonly<Record<string, (body: NoMatchBody, nm: NoMatch) => string>>}
 */
export const NO_MATCH = Object.freeze({
  'ng-special-term': () => "The Registrar's exchange-student list covers Semesters 1 and 2 only, so there is nothing to show for a special term.",
  'not-offered': (_b, nm) => `${nm.code}${nm.title ? ` (${nm.title})` : ''} isn't offered this academic year.`,
  'unknown-code': (_b, nm) => `There is no course ${nm.code} in the NUS catalogue. Check the code.`,
  'no-signal': (b) => `Nothing in the catalogue matches ${quoted(b.query)}. Try other words for the topic.`,
});

/**
 * The sentence for a /search answer with no results.
 * @param {NoMatchBody} body
 */
export function noMatchSentence(body) {
  const nm = body.noMatch;
  if (nm && Object.hasOwn(NO_MATCH, nm.reason)) return NO_MATCH[nm.reason](body, nm);
  return `No modules matched ${quoted(body.query)}.`;
}

/**
 * The note shown above a keyword-only answer (`degraded`), or null.
 * @param {{ source: string, reason: string } | null | undefined} degraded
 */
export function degradedNote(degraded) {
  return degraded ? 'Showing keyword matches only: meaning-based search is unavailable right now.' : null;
}
