// @ts-check
import { STOPWORDS_IN_FORCE } from './fts-query.js';
import { PARSE_PHRASES, compileConstraintPhrases } from './intents.js';
import { buildIntentContext, canonicalQuery, parseQuery } from './query-intent.js';
import { EMBED_CORRECTED } from './typo.js';

/**
 * @typedef {{
 *   prefixes: { prefixes: Record<string, unknown> },
 *   catalogueCodes: { codes: string[] },
 *   collision: { list: string[] },
 *   ge: any,
 *   constraintPhrases: any,
 * }} IntentData
 */

/**
 * @param {IntentData} data
 * @param {import('./query-intent.js').IntentContext['vocabulary']} vocabulary
 * @returns {import('./query-intent.js').IntentContext}
 */
export const intentContextFrom = (data, vocabulary) => buildIntentContext({
  prefixes: Object.keys(data.prefixes.prefixes),
  catalogueCodes: data.catalogueCodes.codes,
  collision: data.collision.list,
  ge: data.ge,
  stopwords: STOPWORDS_IN_FORCE,
  isOffered: () => false,
  vocabulary,
  constraintPhrases: PARSE_PHRASES ? compileConstraintPhrases(data.constraintPhrases) : [],
});

/**
 * @param {{ dense: string, corrected: string | null }} parsed
 * @param {boolean} [embedCorrected]
 */
export const denseTexts = (parsed, embedCorrected = EMBED_CORRECTED) =>
  (embedCorrected && parsed.corrected !== null ? [parsed.dense, parsed.corrected] : [parsed.dense]);

/**
 * @param {string} text
 * @param {import('./query-intent.js').IntentContext} ctx
 */
export const queryDenseTexts = (text, ctx) => denseTexts(parseQuery(canonicalQuery(text.trim()), ctx));
