// @ts-check
// The stopword lists behind one selector (docs/plans/phase3-prereg.md §3
// "Stopwords"): `current` (27) and `stopwords-v2` (35), equal to
// eval/prereg/stopwords.json. Screened as separate rankers, so the selector
// is a single constant, like scripts/lib.mjs EMBEDDING_TEXT_VARIANT.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';
import { STOPWORDS, STOPWORDS_CURRENT, STOPWORDS_V2, STOPWORDS_VARIANT, STOPWORD_VARIANTS, ftsMatch } from '../src/fts-query.js';

const p6 = JSON.parse(readFileSync(join(REPO, 'eval/prereg/stopwords.json'), 'utf8'));

describe('stopword lists', () => {
  it('current and v2 are the P-6 lists', () => {
    expect([...STOPWORDS_CURRENT].sort()).toEqual([...p6.current].sort());
    expect([...STOPWORDS_V2].sort()).toEqual([...p6.v2].sort());
    expect(STOPWORD_VARIANTS).toEqual({ current: STOPWORDS_CURRENT, v2: STOPWORDS_V2 });
  });

  it('the selector picks the list in force, and the FTS query drops exactly that list', () => {
    expect(['current', 'v2']).toContain(STOPWORDS_VARIANT);
    expect([...STOPWORDS].sort()).toEqual([...STOPWORD_VARIANTS[STOPWORDS_VARIANT]].sort());
    const dropped = STOPWORDS.has('modules');
    expect(ftsMatch('nus modules about korean')).toBe(dropped ? '"korean"' : '"nus" OR "modules" OR "korean"');
  });

  it('intro and introductory are never stopwords (they go to 3D)', () => {
    for (const w of p6.notStopwords) {
      expect(STOPWORDS_CURRENT.has(w)).toBe(false);
      expect(STOPWORDS_V2.has(w)).toBe(false);
    }
  });
});
