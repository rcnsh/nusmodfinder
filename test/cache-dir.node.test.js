// @ts-check
// The ingest download cache must never share a path with the pinned snapshot
// the eval and the full-corpus tests read: a fresh NUSMods fetch overwrote
// the pinned snapshot in .data/ (PINNED_ACAD_YEAR) during Phase 1.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR } from '../scripts/lib.mjs';
import { MODULE_INFO_PATH, PINNED_ACAD_YEAR } from '../scripts/pinned-corpus.mjs';

describe('ingest download cache', () => {
  it('writes moduleInfo.json somewhere other than the pinned snapshot', () => {
    const cached = fileURLToPath(new URL(`${PINNED_ACAD_YEAR}-moduleInfo.json`, CACHE_DIR));
    expect(cached).not.toBe(MODULE_INFO_PATH);
  });

  it('stays under the git-ignored .data/', () => {
    expect(fileURLToPath(CACHE_DIR)).toMatch(/\/\.data\/.+\/$/);
  });
});
