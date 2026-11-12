// @ts-check
// The Worker's IntentContext for src/query-intent.js: the catalogue data files
// (data/, built by scripts/build-catalogue-data.mjs), the stopword list in force, the typo
// step's corpus vocabulary, and the offered-code lookup the caller supplies (the
// bundle's code list, or D1 when the bundle is unusable). The static part is
// built once per isolate.
//
// The per-corpus files are bare names, so each config points them at the
// corpus it searches (esbuild accepts no relative alias keys):
// - `vocabulary-data`: wrangler.jsonc aliases it to
//   data/vocabulary.json, built from the production bundle's corpus and
//   versioned with it (scripts/build-vocabulary.mjs);
// - `catalogue-codes-data` and `prefixes-data`: wrangler.jsonc
//   aliases them to data/catalogue-codes.json and data/prefixes.json, built
//   from `current` (data/corpus.json), so a code added to the catalogue since
//   the pinned snapshot answers `not-offered`.
// The Vitest configs alias them to the fixture's or the pinned builds, the
// ones for the corpus the tests search; test/wrangler.ui.jsonc to the UI
// stack's; and vitest.eval.config.mjs to each run workspace's data/ files,
// which the run overwrites with its run corpus's (eval/runner/run.mjs).
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
 * @param {(code: string) => boolean} isOffered upper-case code → offered in this Worker's corpus
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
