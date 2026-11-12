// @ts-check
// 3C's corrector (src/typo.js) at parse step 3 (docs/plans/phase3-prereg.md §3
// and §4 "3C Typos and prefixes"), the parse after it (src/query-intent.js),
// and the FTS expression it yields (src/fts-query.js). Per pre-correction
// token with df 0: 4+ letters → a prefix term; only if that prefix term
// matches nothing, 5+ letters → the nearest vocabulary term by OSA distance
// (≤ 1 for 5–7 letters, ≤ 2 for 8+; ties to the higher df, then the smaller
// term); the original stays in the OR. Intents read the corrected text.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STOPWORDS_CURRENT, ftsMatch } from '../src/fts-query.js';
import { buildIntentContext, canonicalQuery, parseQuery } from '../src/query-intent.js';
import { EMBED_CORRECTED, TYPO_VARIANT, TYPO_VARIANTS, correctQuery } from '../src/typo.js';
import { buildVocabulary, parseVocabulary } from '../src/vocabulary.js';
import { ftsIndex } from './sqlite-fts.node.mjs';

const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8'));

const MODULES = [
  { title: 'Psychology of Learning and Memory', description: 'How memory works. Psychology and learning.' },
  { title: 'Psyche in Myth', description: 'Greek myth.' },
  { title: 'Environmental Policy', description: 'Sustainability and environmental law.' },
  { title: 'Organic Chemistry', description: 'Reactions of organic compounds.' },
  { title: 'Marketing Strategy', description: 'Marketing for startup firms.' },
  { title: 'General Education', description: 'A general education course on society.' },
  { title: 'Machine Design', description: 'Gears, bearings and shafts.' },
  { title: 'Data Science', description: 'Statistics with data.' },
];
const vocab = parseVocabulary(buildVocabulary(MODULES, { corpus: 'fixture', dataVersion: 'x' }));

describe('correctQuery (step 3)', () => {
  it('leaves a query whose tokens all have df > 0 alone', () => {
    const c = correctQuery('psychology of learning', vocab);
    expect(c).toEqual({ tokens: ['psychology', 'of', 'learning'], text: 'psychology of learning', prefixes: [], corrections: [] });
  });

  it('makes a df-0 token of 4+ letters a prefix term, and does not correct it when the prefix matches (psych is not psyche)', () => {
    // FTS5 stems the prefix: `marketting`* is `market`*, which matches marketing.
    expect(correctQuery('marketting', vocab)).toMatchObject({ prefixes: ['marketting'], corrections: [] });
    const c = correctQuery('psych memory', vocab);
    expect(c.prefixes).toEqual(['psych']);
    expect(c.corrections).toEqual([]);
    expect(c.text).toBe('psych memory');
  });

  it('corrects a df-0 token of 5+ letters whose prefix matches nothing, keeping it as a prefix term', () => {
    const c = correctQuery('psycholgy of learning and memory', vocab);
    expect(c.prefixes).toEqual(['psycholgy']);
    expect(c.corrections).toEqual([{ from: 'psycholgy', to: 'psychology' }]);
    expect(c.text).toBe('psychology of learning and memory');
    expect(c.tokens).toEqual(['psycholgy', 'of', 'learning', 'and', 'memory']);
  });

  it('allows distance 1 for 5–7 letters and 2 for 8+', () => {
    expect(correctQuery('orgainc chemistry', vocab).corrections).toEqual([{ from: 'orgainc', to: 'organic' }]);
    // 7 letters, 2 edits from `organic`: not corrected.
    expect(correctQuery('orgnaix', vocab).corrections).toEqual([]);
    // 10 letters, 2 edits (`enviromental` is 1; `envirnmentl` is 2).
    expect(correctQuery('envirnmentl policy', vocab).corrections).toEqual([{ from: 'envirnmentl', to: 'environmental' }]);
    expect(correctQuery('sustainabilty', vocab).corrections).toEqual([{ from: 'sustainabilty', to: 'sustainability' }]);
  });

  it('never corrects a token under 5 letters, and never touches one with digits or other characters', () => {
    const five = correctQuery('mmyth', vocab);
    expect(five.corrections).toEqual([{ from: 'mmyth', to: 'myth' }]);
    const c = correctQuery('mytx cs1010x d4ta', vocab);
    expect(c.prefixes).toEqual(['mytx']);
    expect(c.corrections).toEqual([]);
    expect(correctQuery('asdf lol idk', vocab).corrections).toEqual([]);
  });

  it('applies a correction to a token whose letters lower-case to ASCII only under full Unicode (KELVIN SIGN)', () => {
    const c = correctQuery('mar\u212Aetng strategy', vocab);
    expect(c.corrections).toEqual([{ from: 'marketng', to: 'marketing' }]);
    expect(c.text).toBe('marketing strategy');
  });

  it('replaces whole tokens only, every occurrence, and keeps the separators', () => {
    const c = correctQuery('marketng, (marketng) strategy', vocab);
    expect(c.text).toBe('marketing, (marketing) strategy');
  });
});

describe('the parse after correction', () => {
  const ctx = buildIntentContext({
    prefixes: Object.keys(read('data/pinned/prefixes.json').prefixes),
    catalogueCodes: read('data/pinned/catalogue-codes.json').codes,
    collision: read('data/collision-list.json').list,
    ge: read('data/ge-pillars.json'),
    stopwords: STOPWORDS_CURRENT,
    isOffered: () => false,
    vocabulary: vocab,
  });
  const parse = (/** @type {string} */ q) => parseQuery(canonicalQuery(q.trim()), ctx);

  it('reads intents on the corrected text (C2-4): `genral educaton` is the GE phrase', () => {
    const p = parse('genral educaton society');
    expect(p.interpreted.ge).not.toBeNull();
    expect(p.lexical).toBe('society');
  });

  it('exposes the pre-correction tokens (3G reads them) and the corrected text, and echoes no correction in interpreted', () => {
    const p = parse('psycholgy of learning');
    expect(p.tokens).toEqual(['psycholgy', 'of', 'learning']);
    expect(p.corrected).toBe('psychology of learning');
    expect(p.dense).toBe('psycholgy of learning');
    expect(p.lexical).toBe('psychology of learning');
    expect(Object.values(p.interpreted).every((x) => x === null)).toBe(true);
    expect(parse('psychology of learning').corrected).toBeNull();
  });

  it('gives the lexical half the corrected term with the original as a prefix term beside it', () => {
    const p = parse('psycholgy of learning');
    expect(p.fts).toEqual({ prefixes: ['psycholgy'], corrections: [{ from: 'psycholgy', to: 'psychology' }] });
    expect(ftsMatch(p.lexical, p.fts)).toBe('"psychology" OR "psycholgy"* OR "learning"');
  });

  it('without a vocabulary the parse is 3B\'s: no correction, no prefix term', () => {
    const plain = parseQuery('psycholgy of learning', { ...ctx, vocabulary: null });
    expect(plain.corrected).toBeNull();
    expect(plain.fts).toEqual({ prefixes: [], corrections: [] });
    expect(plain.tokens).toEqual(['psycholgy', 'of', 'learning']);
  });
});

describe('ftsMatch with 3C terms', () => {
  it('is unchanged without them, and for a query with no df-0 token', () => {
    expect(ftsMatch('machine design')).toBe('"machine" OR "design"');
    expect(ftsMatch('machine design', { prefixes: [], corrections: [] })).toBe('"machine" OR "design"');
  });

  it('writes a prefix term as "tok"* and keeps a correction\'s original even when the corrected term is a stopword', () => {
    expect(ftsMatch('psych memory', { prefixes: ['psych'], corrections: [] })).toBe('"psych"* OR "memory"');
    expect(ftsMatch('with gears', { prefixes: ['withh'], corrections: [{ from: 'withh', to: 'with' }] })).toBe('"gears" OR "withh"*');
  });

  it('is valid FTS5 and finds what the corrected query finds', () => {
    const fts = ftsIndex(MODULES);
    const typo = correctQuery('marketng strategy', vocab);
    expect(typo.corrections).toEqual([{ from: 'marketng', to: 'marketing' }]);
    const expr = /** @type {string} */ (ftsMatch(typo.text, typo));
    expect(fts.matches(expr)).toBe(fts.matches(/** @type {string} */ (ftsMatch('marketing strategy'))));
    expect(fts.matches(expr)).toBeGreaterThan(0);
    fts.close();
  });
});

describe('the variant selector', () => {
  it('is one constant naming 3C-1 (lexical half only) or 3C-2 (also embeds the corrected text)', () => {
    expect(Object.keys(TYPO_VARIANTS)).toEqual(['3c1', '3c2']);
    expect(TYPO_VARIANTS['3c1'].embedCorrected).toBe(false);
    expect(TYPO_VARIANTS['3c2'].embedCorrected).toBe(true);
    expect(EMBED_CORRECTED).toBe(TYPO_VARIANTS[TYPO_VARIANT].embedCorrected);
  });
});
