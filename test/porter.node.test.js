// @ts-check
// src/porter.js is SQLite FTS5's porter stemmer (3C, docs/plans/phase3.md
// "3C Typos and prefixes"): the corrector decides whether a prefix term
// `"psych"*` matches anything from the vocabulary alone, and FTS5 stems a
// prefix query's token before it looks it up, so the decision is exact only if
// the Worker stems exactly as SQLite does. Checked here against node:sqlite's
// FTS5 over every term of the fixture corpus, typo-shaped variants of them and
// Porter's own examples; test/full/porter.node.test.js does the pinned corpus.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { queryTokens } from '../src/fts-query.js';
import { ftsTerm, porterStem } from '../src/porter.js';
import { sqliteTerms, typoVariants } from './sqlite-fts.node.mjs';

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/corpus.json', import.meta.url)), 'utf8'));
/** @type {string[]} */
const fixtureTerms = [...new Set(fixture.modules.flatMap((/** @type {any} */ m) => queryTokens(`${m.title} ${m.description ?? ''}`)))];

/** Porter's paper and the SQLite step tables, rule by rule, with the edge lengths. */
const EXAMPLES = [
  'caresses', 'ponies', 'ties', 'caress', 'cats', 'feed', 'agreed', 'plastered', 'bled', 'motoring', 'sing',
  'conflated', 'troubled', 'sized', 'hopping', 'tanned', 'falling', 'hissing', 'fizzed', 'failing', 'filing',
  'happy', 'sky', 'relational', 'conditional', 'rational', 'valenci', 'hesitanci', 'digitizer', 'conformabli',
  'radicalli', 'differentli', 'vileli', 'analogousli', 'vietnamization', 'predication', 'operator', 'feudalism',
  'decisiveness', 'hopefulness', 'callousness', 'formaliti', 'sensitiviti', 'sensibiliti', 'triplicate',
  'formative', 'formalize', 'electriciti', 'electrical', 'hopeful', 'goodness', 'revival', 'allowance',
  'inference', 'airliner', 'gyroscopic', 'adjustable', 'defensible', 'irritant', 'replacement', 'adjustment',
  'dependent', 'adoption', 'homologou', 'communism', 'activate', 'angulariti', 'homologous', 'effective',
  'bowdlerize', 'probate', 'rate', 'cease', 'controll', 'roll', 'generalizations', 'oscillators', 'biology',
  'psychology', 'psychologies', 'learnin', 'learning', 'machin', 'statistc', 'aed', 'eing', 'ied', 'yed', 'ses',
  'sss', 'ion', 'sion', 'tion', 'eed', 'ed', 'a', 'ab', 'abc', 'yyy', 'syzygy', 'archaeology', 'logi', 'bli',
  `${'a'.repeat(63)}s`, `${'a'.repeat(64)}s`, `${'b'.repeat(70)}ing`,
];

describe('porterStem is SQLite FTS5 porter', () => {
  it('on Porter\'s examples and the edge lengths', () => {
    expect(EXAMPLES.map(porterStem)).toEqual(sqliteTerms(EXAMPLES));
  });

  it('on every term of the fixture corpus (diacritics folded as unicode61 folds them)', () => {
    expect(fixtureTerms.length).toBeGreaterThan(3000);
    expect(fixtureTerms.map(ftsTerm)).toEqual(sqliteTerms(fixtureTerms));
  });

  it('on typo-shaped variants of the fixture terms (deletion, transposition, doubling, truncation)', () => {
    const variants = typoVariants(fixtureTerms, 20261107);
    expect(variants.length).toBeGreaterThan(5000);
    expect(variants.map(porterStem)).toEqual(sqliteTerms(variants));
  });

  it('ftsTerm folds diacritics before stemming, as unicode61 does', () => {
    expect(ftsTerm('naïve')).toBe(sqliteTerms(['naïve'])[0]);
    expect(ftsTerm('cafés')).toBe(sqliteTerms(['cafés'])[0]);
    expect(ftsTerm('learning')).toBe('learn');
  });
});
