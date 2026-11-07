// @ts-check
// The Worker's IntentContext for src/query-intent.js: the 3B-0 data files
// (data/, built by scripts/build-3b-data.mjs from the pinned corpus), the
// stopword list in force, and the offered-code lookup the caller supplies (the
// bundle's code list, or D1 when the bundle is unusable). The static part is
// built once per isolate.
import catalogueCodes from '../data/catalogue-codes.json';
import collision from '../data/collision-list.json';
import ge from '../data/ge-pillars.json';
import prefixes from '../data/prefixes.json';
import { STOPWORDS_IN_FORCE } from './fts-query.js';
import { buildIntentContext } from './query-intent.js';

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
  });
  return { ...base, isOffered };
}
