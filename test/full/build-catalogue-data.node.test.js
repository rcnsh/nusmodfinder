// @ts-check
// 3B-0 (docs/evidence/phase3/3b-0.md): the committed pinned files (data/pinned/), the
// shared data/ files and the counts are what scripts/build-3b-data.mjs builds from the pinned
// corpus (Phase 7 7D: data/'s per-corpus files follow `current`, checked by `corpus check`). Skipped without
// .data/; with FULL_CORPUS=1 a missing corpus fails instead.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, staleFiles } from '../../scripts/build-3b-data.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);

describe.skipIf(!available)('3B-0 data from the pinned corpus', () => {
  it('every committed file is what the build script writes', { timeout: 120_000 }, async () => {
    expect(await staleFiles(await build('pinned'))).toEqual([]);
  });
});
