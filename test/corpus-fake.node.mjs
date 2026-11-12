// @ts-check
// A `current` corpus for tests of the scripts that read one (Phase 7 7D): a corpus manifest
// (data/corpus.json's shape) and its restored file, in a temp dir. Nothing is downloaded.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CORPUS_SCHEMA } from '../scripts/corpus-manifest.mjs';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';

/**
 * Writes `<dir>/corpus.json` naming `records` as current, and `<dir>/prod/<sha256>.json`.
 * @param {string} dir
 * @param {unknown[]} records
 * @returns {Promise<{ manifestPath: string, corpusDir: string, sha256: string }>}
 */
export async function writeCurrentCorpus(dir, records) {
  const body = JSON.stringify(records);
  const sha256 = createHash('sha256').update(body).digest('hex');
  const corpusDir = join(dir, 'prod');
  await mkdir(corpusDir, { recursive: true });
  await writeFile(join(corpusDir, `${sha256}.json`), body);
  const release = 'prod-test';
  const manifestPath = join(dir, 'corpus.json');
  await writeFile(manifestPath, JSON.stringify({
    schema: CORPUS_SCHEMA, current: release,
    corpora: { [release]: { year: DEFAULT_ACAD_YEAR, release, asset: `${DEFAULT_ACAD_YEAR}-moduleInfo.json.gz`, sha256, bytes: body.length, fetchedAt: new Date(0).toISOString() } },
  }));
  return { manifestPath, corpusDir, sha256 };
}
