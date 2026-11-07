// @ts-check
// src/vocabulary.js (3C): the corpus vocabulary, surface tokens by the FTS
// tokenisation (queryTokens) with document frequency, plus the FTS index terms
// those tokens make, so a prefix term's fate is decided without a D1 query.
// Also the vocabulary files: the committed fixture vocabulary is current, and
// the committed production vocabulary is versioned with the production bundle.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build, OUTPUTS } from '../scripts/build-vocabulary.mjs';
import {
  VOCABULARY_SCHEMA, buildVocabulary, dfOf, nearestTerm, osaDistance, parseVocabulary, prefixMatches, serializeVocabulary,
} from '../src/vocabulary.js';
import { ftsIndex, typoVariants } from './sqlite-fts.node.mjs';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const fixture = JSON.parse(read('test/fixtures/corpus.json'));

const TINY = [
  { title: 'Psychology of Learning', description: 'Learning and memory. Learning!' },
  { title: 'Psyche and Myth', description: null },
  { title: 'Organic Chemistry', description: 'Reactions, naïve models.' },
];

describe('buildVocabulary', () => {
  const file = buildVocabulary(TINY, { corpus: 'fixture', dataVersion: 'abc123abc123' });
  const v = parseVocabulary(file);

  it('holds each surface token once, sorted, with the number of documents that contain it', () => {
    expect(file.schema).toBe(VOCABULARY_SCHEMA);
    expect(file.documents).toBe(3);
    expect(v.terms).toEqual([...v.terms].sort());
    expect(dfOf(v, 'learning')).toBe(1);
    expect(dfOf(v, 'psychology')).toBe(1);
    expect(dfOf(v, 'and')).toBe(2);
    expect(dfOf(v, 'naïve')).toBe(1);
    expect(dfOf(v, 'missing')).toBe(0);
    expect(file.count).toBe(v.terms.length);
    expect(v.df).toHaveLength(v.terms.length);
  });

  it('holds the FTS index terms its tokens make (porter unicode61), as SQLite indexes them', () => {
    const fts = ftsIndex(TINY);
    expect(v.stems).toEqual(fts.terms());
    fts.close();
  });

  it('round-trips through its serialised form', () => {
    expect(parseVocabulary(JSON.parse(serializeVocabulary(file)))).toEqual(v);
  });
});

describe('prefixMatches is FTS5 deciding a prefix term `"tok"*`', () => {
  const v = parseVocabulary(buildVocabulary(fixture.modules, { corpus: 'fixture', dataVersion: 'x' }));
  const fts = ftsIndex(fixture.modules);

  it('stems the prefix as FTS5 does: "learnin"* matches nothing, "psychologies"* matches', () => {
    const probe = ftsIndex(TINY);
    const small = parseVocabulary(buildVocabulary(TINY, { corpus: 'fixture', dataVersion: 'x' }));
    for (const tok of ['learnin', 'learn', 'psych', 'psychologies', 'psycholgy', 'organ', 'chemistr', 'naiv']) {
      expect(prefixMatches(small, tok), tok).toBe(probe.matches(`"${tok}"*`) > 0);
    }
    expect(prefixMatches(small, 'learnin')).toBe(false);
    expect(prefixMatches(small, 'psychologies')).toBe(true);
    probe.close();
  });

  it('agrees with SQLite on every typo-shaped variant of the fixture terms', () => {
    const variants = typoVariants(v.terms, 7);
    expect(variants.length).toBeGreaterThan(5000);
    const wrong = variants.filter((tok) => prefixMatches(v, tok) !== (fts.matches(`"${tok}"*`) > 0));
    expect(wrong).toEqual([]);
  });
});

describe('osaDistance (C2-5)', () => {
  it('counts a transposition of adjacent letters as 1', () => {
    expect(osaDistance('desgin', 'design')).toBe(1);
    expect(osaDistance('fiannce', 'finance')).toBe(1);
    expect(osaDistance('orgainc', 'organic')).toBe(1);
  });

  it('is the optimal string alignment distance, not unrestricted Damerau', () => {
    expect(osaDistance('ca', 'abc')).toBe(3);
    expect(osaDistance('kitten', 'sitting')).toBe(3);
    expect(osaDistance('', 'abc')).toBe(3);
    expect(osaDistance('abc', 'abc')).toBe(0);
  });

  it('stops early above a bound, reporting bound + 1', () => {
    expect(osaDistance('abcdefgh', 'zzzzzzzz', 2)).toBe(3);
    expect(osaDistance('desgin', 'design', 1)).toBe(1);
  });
});

describe('nearestTerm (C19)', () => {
  const v = parseVocabulary(buildVocabulary([
    { title: 'marketing marketing', description: 'markets' },
    { title: 'marketing', description: 'bases cases' },
    { title: 'bases', description: 'cases vases' },
    { title: 'vases', description: '' },
  ], { corpus: 'fixture', dataVersion: 'x' }));

  it('takes the smallest distance first', () => {
    expect(nearestTerm(v, 'marketting', 2)).toBe('marketing');
  });

  it('breaks a distance tie by the higher df, then the lexicographically smaller term', () => {
    // `xases` is 1 from bases (df 2), cases (df 2) and vases (df 2): smallest wins.
    expect(nearestTerm(v, 'xases', 1)).toBe('bases');
    // `basess` is 1 from bases only.
    expect(nearestTerm(v, 'basess', 1)).toBe('bases');
  });

  it('prefers the higher df over the smaller term', () => {
    const w = parseVocabulary(buildVocabulary([
      { title: 'zeta', description: '' }, { title: 'zeta', description: '' }, { title: 'beta', description: '' },
    ], { corpus: 'fixture', dataVersion: 'x' }));
    expect(nearestTerm(w, 'xeta', 1)).toBe('zeta');
  });

  it('returns null when nothing is within the bound', () => {
    expect(nearestTerm(v, 'qqqqqq', 1)).toBeNull();
  });
});

describe('the vocabulary files', () => {
  it('the committed fixture vocabulary is what scripts/build-vocabulary.mjs builds from the fixture corpus', async () => {
    expect(read(OUTPUTS.fixture)).toBe(await build('fixture'));
  });

  it('the committed production vocabulary is versioned with the production bundle (data version, row count)', () => {
    const vocab = JSON.parse(read(OUTPUTS.production));
    const manifest = JSON.parse(read('data/vectors.json')).bundles.production;
    const dataVersion = JSON.parse(read('src/data-version.json')).version;
    expect(vocab.schema).toBe(VOCABULARY_SCHEMA);
    expect(vocab.corpus).toBe('production');
    expect(vocab.dataVersion).toBe(manifest.dataVersion);
    expect(vocab.dataVersion).toBe(dataVersion);
    expect(vocab.documents).toBe(manifest.count);
    const v = parseVocabulary(vocab);
    expect(v.terms.length).toBe(vocab.count);
    expect(v.terms).toEqual([...v.terms].sort());
  });

  it('is small: under 400 KB', () => {
    expect(Buffer.byteLength(read(OUTPUTS.production))).toBeLessThan(400_000);
  });
});
