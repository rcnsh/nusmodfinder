// @ts-check
// scripts/vectors.mjs and scripts/vectors-manifest.mjs (Phase 3 3-0, B-2,
// B-9, B2-5, A-N6): the committed fixture bundle is what the builder makes,
// the manifest checks catch a wrong file, vectors are keyed by text, and the
// `vectors-bundle` alias defaults to the fixture everywhere.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { embeddingKey, MODEL } from '../eval/lib/embeddings.mjs';
import { keyedVectors } from '../scripts/vectors.mjs';
import { FIXTURE_EMBEDDING, assetName, loadCheckedBundle, readVectorsManifest, shimPath } from '../scripts/vectors-manifest.mjs';
import { encodeBundle, rowsKey } from '../src/vector-bundle.js';
import { hashEmbed } from './fakes.js';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)));
const fixture = /** @type {{ modules: NormalisedModule[] }} */ (JSON.parse(read('test/fixtures/corpus.json').toString('utf8')));

describe('the fixture bundle (B-9)', () => {
  it('is what `node scripts/vectors.mjs build --corpus fixture` produces from test/fixtures/corpus.json and the fake embedder', async () => {
    const bytes = await encodeBundle({ corpus: 'fixture', embedding: FIXTURE_EMBEDDING, model: 'fake', modules: fixture.modules, vectorOf: (m) => hashEmbed(/** @type {NormalisedModule} */ (m).text) });
    const committed = read('test/fixtures/vectors.bin');
    expect(Buffer.from(bytes).equals(committed)).toBe(true);
    const entry = /** @type {import('../scripts/vectors-manifest.mjs').ManifestEntry} */ ((await readVectorsManifest()).bundles.fixture);
    expect(entry).toMatchObject({ corpus: 'fixture', count: fixture.modules.length, path: 'test/fixtures/vectors.bin', bytes: committed.length });
    expect(entry.sha256).toBe(createHash('sha256').update(committed).digest('hex'));
    expect(entry.rowsKey).toBe(await rowsKey(fixture.modules));
    // About 400 × 384 × 4 B, well under a megabyte.
    expect(committed.length).toBeLessThan(700_000);
  });

  it('is the default `vectors-bundle` alias in wrangler.jsonc, the test config and both Vitest configs', () => {
    expect(read('wrangler.jsonc').toString()).toContain('"alias": { "vectors-bundle": "./test/fixtures/vectors.js" }');
    expect(read('test/wrangler.test.jsonc').toString()).toContain('"alias": { "vectors-bundle": "./fixtures/vectors.js" }');
    expect(read('vitest.config.mjs').toString()).toContain("{ find: 'vectors-bundle', replacement: FIXTURE_BUNDLE }");
    expect(read('vitest.eval.config.mjs').toString()).toContain("'vectors-bundle': join(ws, 'test/fixtures/vectors.js')");
    expect(read('test/fixtures/vectors.js').toString()).toContain("import vectors from './vectors.bin';");
    expect(read('wrangler.jsonc').toString()).toContain('"vars": { "DENSE_BACKEND": "bundle" }');
  });
});

describe('manifest checks (B-2)', () => {
  it('loadCheckedBundle refuses a file whose sha256 or header disagrees with its entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vnm-vectors-'));
    try {
      const bytes = await encodeBundle({ corpus: 'production', embedding: 'e1', model: 'm', modules: fixture.modules.slice(0, 3), vectorOf: (m) => hashEmbed(/** @type {NormalisedModule} */ (m).text) });
      const path = join(dir, 'b.bin');
      await writeFile(path, bytes);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const { bundle } = await loadCheckedBundle({ corpus: 'production', embedding: 'e1', model: 'm', count: 3, dataVersion: '', rowsKey: '', sha256: sha, bytes: bytes.length }, path)
        .catch((err) => ({ bundle: null, err }));
      expect(bundle).toBeNull(); // header dataVersion/rowsKey differ from the (empty) entry
      const header = JSON.parse(Buffer.from(bytes.subarray(12, 12 + new DataView(bytes.buffer).getUint32(8, true))).toString('utf8'));
      const entry = { corpus: /** @type {const} */ ('production'), embedding: 'e1', model: 'm', count: 3, dataVersion: header.dataVersion, rowsKey: header.rowsKey, sha256: sha, bytes: bytes.length };
      expect((await loadCheckedBundle(entry, path)).bundle.count).toBe(3);
      await expect(loadCheckedBundle({ ...entry, sha256: '0'.repeat(64) }, path)).rejects.toThrow(/sha256/);
      await expect(loadCheckedBundle({ ...entry, corpus: 'pinned' }, path)).rejects.toThrow(/corpus/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names assets vec-<corpus>-<dataVersion>-<embedding>.bin, with the alias module beside them', () => {
    expect(assetName('pinned', 'c25f43ebfbdb', 'emb-bge-small-v0')).toBe('vec-pinned-c25f43ebfbdb-emb-bge-small-v0.bin');
    expect(shimPath('/x/.data/vectors/vec-pinned-a-b.bin')).toBe('/x/.data/vectors/vec-pinned-a-b.js');
  });
});

describe('keyed vectors (B2-5)', () => {
  it('looks each code up by embeddingKey(model, text), so codes sharing a text share one vector, and lists texts with none', () => {
    const [a, b] = fixture.modules;
    const c = /** @type {NormalisedModule} */ (fixture.modules.find((m) => m.text !== a.text));
    const shared = { ...b, code: 'ZZ1000', text: a.text };
    const v = Float32Array.from(hashEmbed(a.text));
    const { out, missing } = keyedVectors([a, shared, c], new Map([[embeddingKey(MODEL, a.text), v]]));
    expect(out.get(a.code)).toBe(v);
    expect(out.get('ZZ1000')).toBe(v);
    expect(out.has(c.code)).toBe(false);
    expect(missing).toEqual([c.text]);
  });
});
