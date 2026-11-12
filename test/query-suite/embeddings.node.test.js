// @ts-check
// The suite's and the gibberish set's new texts are embedded into
// test/query-suite/embeddings.json. test/query-suite/needs-embedding.txt lists every
// one of them; this file checks that list is exact, and holds the checks that
// need the vectors, skipped until test/query-suite/embeddings.json exists:
// - every listed text has a vector for each form the rankers embed;
// - no suite or gibberish text is a near-duplicate of a dev text by query
//   embedding (cosine ≥ 0.9, the leak-filter threshold of ADR 0003), except
//   the four dev texts the suite allows.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { base64ToF32, embeddingKey, MODEL, queryTextForms } from '../../eval/lib/embeddings.mjs';
import { REPO } from '../../eval/lib/sets.mjs';
import { ALLOWED_DEV, GIBBERISH_PATH, NEEDS_EMBEDDING_PATH, SUITE_EMBEDDINGS_PATH, SUITE_PATH, devQueries, readJson, suiteTexts } from './suite-files.node.mjs';

const devCache = readJson(join(REPO, 'eval/dev/embeddings.json')).entries;
const items = readJson(SUITE_PATH).items;
const gibberish = readJson(GIBBERISH_PATH).strings;

/** Every suite and gibberish text, in file order: suite texts, then the gibberish set. */
function allTexts() {
  const texts = [...suiteTexts(items).map((t) => t.text), ...gibberish.map((/** @type {any} */ g) => g.text)];
  return [...new Set(texts)];
}

/** @param {Record<string, string>} entries @param {string} text */
const embedded = (entries, text) => queryTextForms(text).every((f) => embeddingKey(MODEL, f) in entries);

/** The listed texts: every line that is not blank or a `#` comment. */
const listed = () => readFileSync(NEEDS_EMBEDDING_PATH, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));

const haveVectors = existsSync(SUITE_EMBEDDINGS_PATH);

describe('query embeddings for the suite and gibberish texts', () => {
  it('needs-embedding.txt lists exactly the texts with no committed embedding', () => {
    const want = allTexts().filter((t) => !embedded(devCache, t));
    expect(listed()).toEqual(want);
  });

  it('the four dev texts the suite allows already have committed embeddings', () => {
    const dev = devQueries();
    for (const id of Object.keys(ALLOWED_DEV)) {
      const d = /** @type {{ text: string }} */ (dev.find((q) => q.id === id));
      expect(embedded(devCache, d.text), id).toBe(true);
    }
  });

  it.skipIf(!haveVectors)('every listed text has a vector for each of its forms in test/query-suite/embeddings.json (skipped until embedded)', () => {
    const cache = readJson(SUITE_EMBEDDINGS_PATH);
    expect(cache.model).toBe(MODEL);
    const missing = listed().filter((t) => !embedded(cache.entries, t));
    expect(missing).toEqual([]);
  });

  it.skipIf(!haveVectors)('no suite or gibberish text has cosine ≥ 0.9 with a dev text other than the four the suite allows (skipped until embedded)', () => {
    const cache = readJson(SUITE_EMBEDDINGS_PATH).entries;
    /** @param {string} text */
    const vec = (text) => {
      const forms = queryTextForms(text);
      const key = embeddingKey(MODEL, forms[forms.length - 1]);
      const b64 = cache[key] ?? devCache[key];
      if (!b64) throw new Error(`no vector for ${JSON.stringify(text)}`);
      return base64ToF32(b64);
    };
    /** @param {Float32Array} a @param {Float32Array} b */
    const cos = (a, b) => {
      let d = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return d / Math.sqrt(na * nb);
    };
    const dev = devQueries().filter((q) => !(q.id in ALLOWED_DEV));
    const devVecs = dev.map((q) => ({ id: q.id, v: vec(q.text) }));
    /** @type {string[]} */
    const hits = [];
    for (const t of allTexts()) {
      if (Object.keys(ALLOWED_DEV).some((id) => devQueries().find((q) => q.id === id)?.text === t)) continue;
      const v = vec(t);
      for (const d of devVecs) if (cos(v, d.v) >= 0.9) hits.push(`${JSON.stringify(t)} ~ ${d.id}`);
    }
    expect(hits).toEqual([]);
  });
});
