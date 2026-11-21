// @ts-check
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { build, staleFiles } from '../../scripts/build-catalogue-data.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);

describe.skipIf(!available)('catalogue data from the pinned corpus', () => {
  it('every committed file is what the build script writes', { timeout: 120_000 }, async () => {
    expect(await staleFiles(await build('pinned'))).toEqual([]);
  });
});
