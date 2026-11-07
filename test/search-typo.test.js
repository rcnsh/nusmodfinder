// @ts-check
// 3C in /search (docs/plans/phase3.md "3C Typos and prefixes") on the fixture
// corpus, the fixture bundle and the fixture vocabulary: a typo's lexical half
// finds what the corrected query finds, `interpreted` echoes no correction,
// and the dense half follows the variant selector: 3C-1 embeds the query as
// typed; 3C-2 also embeds the corrected text, a second single-text call in
// parallel, and takes each module's better cosine of the two.
import { beforeAll, describe, expect, it } from 'vitest';
import vocabFile from './fixtures/vocabulary.json';
import { intentContext } from '../src/intent-data.js';
import { denseTexts, mergeDense } from '../src/search.js';
import { EMBED_CORRECTED, correctQuery } from '../src/typo.js';
import { dfOf, parseVocabulary } from '../src/vocabulary.js';
import { createFakes } from './fakes.js';
import { callJson, fixture, seed } from './helpers.js';

const vocab = parseVocabulary(/** @type {import('../src/vocabulary.js').VocabularyFile} */ (/** @type {unknown} */ (vocabFile)));
/** @returns {string[]} */
const codes = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);

/**
 * A fixture title word of 8+ letters and its typo (one letter dropped) that
 * the corrector turns back into the word: df 0, no prefix match, nearest term
 * the word itself.
 */
function typoPair() {
  for (const m of fixture.modules) {
    for (const word of m.title.toLowerCase().split(/[^a-z]+/)) {
      if (word.length < 8 || dfOf(vocab, word) < 3) continue;
      for (let i = 2; i < word.length - 2; i++) {
        const typo = word.slice(0, i) + word.slice(i + 1);
        const c = correctQuery(typo, vocab);
        if (c.corrections.length === 1 && c.corrections[0].to === word) return { word, typo };
      }
    }
  }
  throw new Error('no fixture word has a typo the corrector restores');
}
const { word, typo } = typoPair();

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('the Worker corrects against the vocabulary of the corpus it searches', () => {
  it('under test, the fixture vocabulary', () => {
    expect(intentContext(() => false).vocabulary?.corpus).toBe('fixture');
    expect(vocab.documents).toBe(fixture.modules.length);
  });
});

describe('a typo in /search', () => {
  it('lexical half: the typo finds what the corrected word finds, in the same order', async () => {
    const t = await callJson(`/search?q=${typo}&mode=lexical`, { fakes });
    const w = await callJson(`/search?q=${word}&mode=lexical`, { fakes });
    expect(t.status).toBe(200);
    expect(codes(t.body).length).toBeGreaterThan(0);
    expect(codes(t.body)).toEqual(codes(w.body));
  });

  it('echoes no correction in interpreted', async () => {
    const { body } = await callJson(`/search?q=${typo}`, { fakes });
    expect(Object.values(body.interpreted).every((v) => v === null)).toBe(true);
    expect(body.query).toBe(typo);
  });

  it(`dense half (${EMBED_CORRECTED ? '3C-2' : '3C-1'}): embeds ${EMBED_CORRECTED ? 'the typed and the corrected text, one call each' : 'the query as typed, once'}`, async () => {
    const f = createFakes();
    await callJson(`/search?q=${typo}%20design`, { fakes: f });
    const texts = f.ai.calls.filter((c) => c.method === 'run').map((c) => /** @type {any} */ (c.args[1]).text);
    expect(texts).toEqual(EMBED_CORRECTED ? [[`${typo} design`], [`${word} design`]] : [[`${typo} design`]]);
    // A query with nothing to correct embeds once under either variant.
    const g = createFakes();
    await callJson(`/search?q=${word}%20design`, { fakes: g });
    expect(g.ai.calls.filter((c) => c.method === 'run')).toHaveLength(1);
  });
});

describe('denseTexts', () => {
  const parsed = /** @type {any} */ ({ dense: 'machne learning', corrected: 'machine learning' });
  it('is the typed text under 3C-1, and also the corrected text under 3C-2 when there is one', () => {
    expect(denseTexts(parsed, false)).toEqual(['machne learning']);
    expect(denseTexts(parsed, true)).toEqual(['machne learning', 'machine learning']);
    expect(denseTexts({ ...parsed, corrected: null }, true)).toEqual(['machne learning']);
  });
});

describe('mergeDense', () => {
  it('keeps each code\'s best score across the lists, best first, at most `depth`', () => {
    const a = [{ code: 'A', score: 0.9 }, { code: 'B', score: 0.5 }, { code: 'C', score: 0.4 }];
    const b = [{ code: 'C', score: 0.95 }, { code: 'D', score: 0.6 }, { code: 'A', score: 0.1 }];
    expect(mergeDense([a, b], 3)).toEqual([{ code: 'C', score: 0.95 }, { code: 'A', score: 0.9 }, { code: 'D', score: 0.6 }]);
  });

  it('is the identity on one list, ties kept in order', () => {
    const a = [{ code: 'A', score: 0.5 }, { code: 'B', score: 0.5 }, { code: 'C', score: 0.2 }];
    expect(mergeDense([a], 50)).toEqual(a);
  });
});
