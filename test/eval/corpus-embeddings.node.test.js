// @ts-check
// The eval runner's refusal of corpus vectors that embed another text than
// the ranker's (eval/lib/embeddings.mjs assertCorpusTextsEmbedded, called by
// eval/runner/run.mjs): a ranker runs only on a corpus embedding version
// embedded from its own embedding text (ref 3a2-vN with emb-bge-small-vN),
// never on another.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPinnedWith } from '../../eval/lib/corpus.mjs';
import { EMB_DIR, assertCorpusTextsEmbedded, embeddingKey, loadCorpusEmbeddings, MODEL } from '../../eval/lib/embeddings.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { EMBEDDING_TEXT_VARIANT, embeddingTextFor } from '../../scripts/lib.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

/** @type {import('../../scripts/lib.mjs').NusModsRecord[]} */
const records = [
  { moduleCode: 'CS3244', title: 'Machine Learning', department: 'Computer Science', faculty: 'Computing', description: 'Basic concepts and algorithms in machine learning.' },
  { moduleCode: 'PLS8001', title: 'Cultivating Collaboration', department: 'Psychology', faculty: 'Arts and Social Science', description: 'Soft skills on the interpersonal level.' },
];
/** The eval-v0 embedding text (title, department, faculty, description). @param {import('../../scripts/lib.mjs').NusModsRecord} r */
const v0Text = (r) => [r.title, r.department, r.faculty, r.description].join('. ');

/** A ranker's corpus under a text function. @param {(r: any) => string} text */
const corpusOf = (text) => records.map((r) => ({ code: /** @type {string} */ (r.moduleCode), text: text(r) }));
/** A corpus version embedded from a text function. @param {string} version @param {(r: any) => string} text */
const versionOf = (version, text) => ({ version, textRef: `ref-${version}`, keys: corpusOf(text).map((m) => embeddingKey(MODEL, m.text)) });

const v0 = versionOf('emb-bge-small-v0', v0Text);
const v1 = versionOf('emb-bge-small-v1', (r) => embeddingTextFor(r, 'v1'));
const v3 = versionOf('emb-bge-small-v3', (r) => embeddingTextFor(r, 'v3'));

describe('assertCorpusTextsEmbedded', () => {
  it('passes a ranker on the corpus version embedded from its own text', () => {
    expect(() => assertCorpusTextsEmbedded(corpusOf(v0Text), v0, 'eval-v0')).not.toThrow();
    expect(() => assertCorpusTextsEmbedded(corpusOf((r) => embeddingTextFor(r, 'v1')), v1, 'embedding-text-v1')).not.toThrow();
  });

  it('refuses a v1 ranker on v0 vectors, naming the version, its text ref and the fix', () => {
    expect(() => assertCorpusTextsEmbedded(corpusOf((r) => embeddingTextFor(r, 'v1')), v0, 'embedding-text-v1')).toThrow(
      '2 of 2 corpus texts of ranker embedding-text-v1 have no vector in corpus embedding emb-bge-small-v0 (embedded from ref-emb-bge-small-v0; first: CS3244)');
    expect(() => assertCorpusTextsEmbedded(corpusOf((r) => embeddingTextFor(r, 'v1')), v0, 'embedding-text-v1')).toThrow(
      'npm run eval:embed -- --corpus --ref embedding-text-v1 --version <new>');
  });

  it('refuses a v0 ranker on v1 vectors, and one variant\'s ranker on another\'s', () => {
    expect(() => assertCorpusTextsEmbedded(corpusOf(v0Text), v1, 'eval-v0')).toThrow(/2 of 2 corpus texts of ranker eval-v0 have no vector in corpus embedding emb-bge-small-v1/);
    expect(() => assertCorpusTextsEmbedded(corpusOf((r) => embeddingTextFor(r, 'v1')), v3, 'embedding-text-v1')).toThrow(/emb-bge-small-v3/);
  });

  it('refuses even one module whose text is not in the version (the rest being there is not enough)', () => {
    const mixed = corpusOf(v0Text);
    mixed[1] = { ...mixed[1], text: embeddingTextFor(records[1], 'v1') };
    expect(() => assertCorpusTextsEmbedded(mixed, v0, 'x')).toThrow(/^1 of 2 corpus texts of ranker x .*first: PLS8001/);
  });

  // The pinned corpus and the v0 asset, if this checkout has them (never downloaded here).
  const local = existsSync(MODULE_INFO_PATH) && existsSync(join(EMB_DIR, 'emb-bge-small-v0', 'corpus.index.json'));
  it.skipIf(!local)('on real data: the v0 asset refuses this checkout\'s ranker, every module of it', async () => {
    expect(EMBEDDING_TEXT_VARIANT).toMatch(/^v[123]$/);
    const corpus = await loadPinnedWith(REPO);
    const emb = await loadCorpusEmbeddings('emb-bge-small-v0');
    expect(() => assertCorpusTextsEmbedded(corpus.modules, emb, 'WORKTREE'))
      .toThrow(/^6771 of 6771 corpus texts of ranker WORKTREE have no vector in corpus embedding emb-bge-small-v0 \(embedded from eval-v0;/);
  });
});
