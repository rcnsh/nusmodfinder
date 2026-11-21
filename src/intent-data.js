// @ts-check
import catalogueCodes from 'catalogue-codes-data';
import collision from '../data/collision-list.json';
import constraintPhrases from '../data/constraint-phrases.json';
import ge from '../data/ge-pillars.json';
import prefixes from 'prefixes-data';
import vocabularyFile from 'vocabulary-data';
import { intentContextFrom } from './query-texts.js';
import { parseVocabulary } from './vocabulary.js';

/** @type {import('./query-intent.js').IntentContext | null} */
let base = null;

/**
 * @param {(code: string) => boolean} isOffered
 * @returns {import('./query-intent.js').IntentContext}
 */
export function intentContext(isOffered) {
  base ??= intentContextFrom({ prefixes, catalogueCodes, collision, ge, constraintPhrases },
    parseVocabulary(/** @type {import('./vocabulary.js').VocabularyFile} */ (vocabularyFile)));
  return { ...base, isOffered };
}
