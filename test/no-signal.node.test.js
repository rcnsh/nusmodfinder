// @ts-check
// The no-signal check's vocabulary half: `parsed.noSignal`
// is true iff no code, prefix or GE route fired, and no pre-correction token
// has df > 0 or, at 4+ letters, an FTS prefix match. The dense half (the top
// exact cosine below τ) is /search's (test/search-no-signal.test.js).
import { describe, expect, it } from 'vitest';
import { buildIntentContext, parseQuery } from '../src/query-intent.js';
import { buildVocabulary, parseVocabulary } from '../src/vocabulary.js';
import { NO_SIGNAL_TAU, NO_SIGNAL_VARIANT, NO_SIGNAL_VARIANTS, noSignalCandidates } from '../src/no-signal.js';

const MODULES = [
  { title: 'Psychology of Learning and Memory', description: 'How memory works. Psychology and learning.' },
  { title: 'Environmental Policy', description: 'Sustainability and environmental law.' },
  { title: 'Organic Chemistry', description: 'Reactions of organic compounds.' },
  { title: 'Marketing Strategy', description: 'Marketing for startup firms.' },
  { title: 'Data Science', description: 'Statistics with data.' },
];
const vocabulary = parseVocabulary(buildVocabulary(MODULES, { corpus: 'fixture', dataVersion: 'x' }));
const base = {
  prefixes: ['CS', 'MA', 'GEA'], catalogueCodes: ['CS1101'], collision: ['MA'],
  ge: { prefixes: ['GEA'], genericPhrases: [], pillars: [{ name: 'data literacy', prefixes: ['GEA'] }] },
  stopwords: [], isOffered: (/** @type {string} */ c) => c === 'CS1010S',
};
const ctx = buildIntentContext({ ...base, vocabulary });
const noSignal = (/** @type {string} */ q) => parseQuery(q, ctx).noSignal;

describe('parsed.noSignal', () => {
  it('holds for keyboard mash and invented words', () => {
    expect(noSignal('qwertyuiop')).toBe(true);
    expect(noSignal('xqzvbnm flurble')).toBe(true);
    expect(noSignal('jkl jkl jkl')).toBe(true);
  });

  it('a token with df > 0 is a signal', () => {
    expect(noSignal('psychology')).toBe(false);
    expect(noSignal('flurble memory')).toBe(false);
  });

  it('a 4+ letter token with an FTS prefix match is a signal; a shorter one is not', () => {
    expect(noSignal('psych')).toBe(false);
    expect(noSignal('envi')).toBe(false);
    // `psy` prefixes psychology but has 3 letters.
    expect(noSignal('psy')).toBe(true);
  });

  it('reads the pre-correction tokens: a correction cannot rescue gibberish', () => {
    const p = parseQuery('chemistyr', ctx);
    expect(p.corrected).not.toBeNull();
    expect(p.noSignal).toBe(true);
  });

  it('never holds when a code, prefix or GE route fired, or on a no-match', () => {
    expect(noSignal('cs')).toBe(false);
    expect(noSignal('cs9')).toBe(false);
    expect(noSignal('cs1010s flurble')).toBe(false);
    expect(noSignal('data literacy')).toBe(false);
    expect(parseQuery('cs1101', ctx)).toMatchObject({ kind: 'no-match', noSignal: false });
  });

  it('never holds without a vocabulary', () => {
    expect(parseQuery('qwertyuiop', buildIntentContext(base)).noSignal).toBe(false);
  });
});

describe('the τ candidates', () => {
  it('are the 90th and 95th nearest-rank percentiles and the maximum, each + 1e-6, distinct, ascending', () => {
    const xs = Array.from({ length: 20 }, (_, i) => 0.5 + i / 100);
    // n = 20: ⌈0.9·20⌉ = 18th smallest, ⌈0.95·20⌉ = 19th, max = 20th.
    expect(noSignalCandidates([...xs].reverse())).toEqual([xs[17], xs[18], xs[19]].map((x) => x + 1e-6));
    expect(noSignalCandidates([0.4, 0.4, 0.4])).toEqual([0.4 + 1e-6]);
  });

  it('the variant in force names its τ', () => {
    expect(Object.keys(NO_SIGNAL_VARIANTS)).toContain(NO_SIGNAL_VARIANT);
    expect(NO_SIGNAL_TAU).toBe(NO_SIGNAL_VARIANTS[NO_SIGNAL_VARIANT]);
  });
});
