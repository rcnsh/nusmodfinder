// @ts-check
// Rebuild check: eval/groups.json is exactly what eval/groups.mjs builds from
// the full pinned corpus. Skipped when .data/ has no corpus; with
// FULL_CORPUS=1 (the full-corpus CI job) a missing corpus fails instead.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildPinnedGroups } from '../../eval/groups.mjs';
import { GROUPS_PATH } from '../../eval/lib/groups.mjs';
import { MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);

describe.skipIf(!available)('eval/groups.json', () => {
  it('is what the builder produces from the pinned corpus (npm run eval:groups)', async () => {
    const { file, text } = await buildPinnedGroups();
    expect(await readFile(GROUPS_PATH, 'utf8')).toBe(text);
    expect(file.counts).toEqual({ groups: 509, members: 1562, largest: 38 });
  }, 30_000); // builds the groups from the whole pinned corpus: past 5 s under the full suite
});
