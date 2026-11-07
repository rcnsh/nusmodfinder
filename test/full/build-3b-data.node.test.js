// @ts-check
// 3B-0 (docs/evidence/phase3/3b-0.md): the committed data/ files and counts are
// what scripts/build-3b-data.mjs builds from the pinned corpus. Skipped without
// .data/; with FULL_CORPUS=1 a missing corpus fails instead.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../eval/lib/sets.mjs';
import { build, OUTPUTS } from '../../scripts/build-3b-data.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);

describe.skipIf(!available)('3B-0 data from the pinned corpus', () => {
  it('every committed file is what the build script writes', { timeout: 120_000 }, async () => {
    const out = await build();
    for (const [key, rel] of Object.entries(OUTPUTS)) {
      expect(readFileSync(join(REPO, rel), 'utf8') === out[/** @type {keyof typeof OUTPUTS} */ (key)], rel).toBe(true);
    }
  });
});
