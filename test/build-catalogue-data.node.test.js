// @ts-check
// Phase 7 7D: the catalogue codes, the prefixes and catalogue-only.json follow
// the corpus. scripts/build-3b-data.mjs builds them from `current` (data/) and
// from the pinned corpus (data/pinned/), and `--check` fails on a committed
// file that is not what the build writes. Fake records in a temp dir: no corpus
// needed. test/full/build-3b-data.node.test.js checks the committed pinned
// files against the real pinned corpus.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CORPUS_OUTPUTS, corpusFiles, staleFiles } from '../scripts/build-3b-data.mjs';
import { offeredModules } from '../scripts/lib.mjs';

/** @param {string} code @param {number[]} sems */
const record = (code, sems) => ({
  moduleCode: code, title: `Title ${code}`, description: `About ${code}.`, moduleCredit: '4', department: 'D', faculty: 'F',
  semesterData: sems.map((semester) => ({ semester })),
});
const RECORDS = [record('AA1001', [1]), record('AB2002', [2]), record('AB2003', [1, 2]), record('AA0999', []), record('ZZ0998', [])];
const SOURCE = { release: 'prod-test', acadYear: '2026-2027', moduleInfoSha256: 'f'.repeat(64) };

/** @type {string} */
let root;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'vnm-3b-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

/** @param {Record<string, string>} files rel -> bytes */
async function writeAll(files) {
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), bytes);
  }
}

describe('the per-corpus 3B files', () => {
  const { modules } = offeredModules(RECORDS, SOURCE.acadYear);

  it('are the offered prefixes, the catalogue-only codes and their rows, for production under data/ and pinned under data/pinned/', () => {
    expect(CORPUS_OUTPUTS.production).toEqual({ prefixes: 'data/prefixes.json', catalogueCodes: 'data/catalogue-codes.json', catalogueOnly: 'data/catalogue-only.json' });
    expect(CORPUS_OUTPUTS.pinned).toMatchObject({ prefixes: 'data/pinned/prefixes.json', catalogueCodes: 'data/pinned/catalogue-codes.json' });
    const out = corpusFiles({ records: RECORDS, modules, source: SOURCE });
    expect(JSON.parse(out.prefixes).prefixes).toEqual({ AA: 1, AB: 2 });
    expect(JSON.parse(out.catalogueCodes)).toMatchObject({ source: SOURCE, count: 2, codes: ['AA0999', 'ZZ0998'] });
    expect(JSON.parse(out.catalogueOnly).rows.map((/** @type {string[]} */ r) => r[0])).toEqual(['AA0999', 'ZZ0998']);
  });

  it('--check passes committed files equal to the build, and names a stale or missing one', async () => {
    const out = corpusFiles({ records: RECORDS, modules, source: SOURCE });
    const byPath = Object.fromEntries(Object.entries(CORPUS_OUTPUTS.production).map(([k, rel]) => [rel, out[/** @type {keyof typeof out} */ (k)]]));
    await writeAll(byPath);
    expect(await staleFiles(byPath, root)).toEqual([]);
    // A catalogue built from an older corpus: one code fewer.
    const older = corpusFiles({ records: RECORDS.filter((r) => r.moduleCode !== 'ZZ0998'), modules, source: SOURCE });
    await writeFile(join(root, 'data/catalogue-codes.json'), older.catalogueCodes);
    await rm(join(root, 'data/prefixes.json'));
    expect(await staleFiles(byPath, root)).toEqual(['data/prefixes.json', 'data/catalogue-codes.json']);
  });
});
