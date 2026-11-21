// @ts-check
import catalogueCodes from 'catalogue-codes-data';
import collision from '../data/collision-list.json';
import constraintPhrases from '../data/constraint-phrases.json';
import ge from '../data/ge-pillars.json';
import prefixes from 'prefixes-data';
import vocabularyFile from 'vocabulary-data';
import { STOPWORDS_IN_FORCE } from './fts-query.js';
import { PARSE_PHRASES, compileConstraintPhrases } from './intents.js';
import { buildIntentContext } from './query-intent.js';
import { parseVocabulary } from './vocabulary.js';

/** @type {import('./query-intent.js').IntentContext | null} */
let base = null;

/**
 * @param {(code: string) => boolean} isOffered
 * @returns {import('./query-intent.js').IntentContext}
 */
export function intentContext(isOffered) {
  base ??= buildIntentContext({
    prefixes: Object.keys(prefixes.prefixes),
    catalogueCodes: catalogueCodes.codes,
    collision: collision.list,
    ge,
    stopwords: STOPWORDS_IN_FORCE,
    isOffered: () => false,
    vocabulary: parseVocabulary(/** @type {import('./vocabulary.js').VocabularyFile} */ (vocabularyFile)),
    constraintPhrases: PARSE_PHRASES ? compileConstraintPhrases(constraintPhrases) : [],
  });
  return { ...base, isOffered };
}
