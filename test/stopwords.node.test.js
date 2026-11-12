// @ts-check
// The stopword lists behind one selector: `current` (27) and `stopwords-v2`
// (35), equal to eval/query-rules/stopwords.json. Screened as separate rankers, so the selector
// is a single constant, like scripts/lib.mjs EMBEDDING_TEXT_VARIANT.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';
import { STOPWORDS_IN_FORCE as STOPWORDS, STOPWORDS_CURRENT, STOPWORDS_V2, STOPWORDS_VARIANT, STOPWORD_VARIANTS, ftsMatch } from '../src/fts-query.js';

const lists = JSON.parse(readFileSync(join(REPO, 'eval/query-rules/stopwords.json'), 'utf8'));

describe('stopword lists', () => {
  it('current and v2 are the eval\'s lists', () => {
    expect([...STOPWORDS_CURRENT].sort()).toEqual([...lists.current].sort());
    expect([...STOPWORDS_V2].sort()).toEqual([...lists.v2].sort());
    expect(STOPWORD_VARIANTS).toEqual({ current: STOPWORDS_CURRENT, v2: STOPWORDS_V2 });
  });

  it('the selector picks the list in force, and the FTS query drops exactly that list', () => {
    expect(['current', 'v2']).toContain(STOPWORDS_VARIANT);
    expect([...STOPWORDS].sort()).toEqual([...STOPWORD_VARIANTS[STOPWORDS_VARIANT]].sort());
    const dropped = STOPWORDS.has('modules');
    expect(ftsMatch('nus modules on korean')).toBe(dropped ? '"korean"' : '"nus" OR "modules" OR "korean"');
  });

  it('intro and introductory are never stopwords (they ask for a level)', () => {
    for (const w of lists.notStopwords) {
      expect(STOPWORDS_CURRENT.has(w)).toBe(false);
      expect(STOPWORDS_V2.has(w)).toBe(false);
    }
  });
});
