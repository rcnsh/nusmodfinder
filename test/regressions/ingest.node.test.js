// @ts-check
// B2 and S3, Node side: what scripts/lib.mjs hashes and embeds, and how its
// download cache behaves. Runs in Node (vitest project "node").
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_DIR, embeddingText, fetchAcadYearFile, offeredModules } from '../../scripts/lib.mjs';

/** A NUSMods v2 moduleInfo record. */
const record = {
  moduleCode: 'CS1010S', title: 'Programming Methodology', department: 'Computer Science', faculty: 'Computing',
  description: 'This course introduces the fundamental concepts of problem solving by computing.',
  moduleCredit: '4', semesterData: [{ semester: 1 }, { semester: 2 }],
  workload: [2, 1, 1, 3, 3], prerequisite: 'None', preclusion: 'CS1010',
};
const ng = (/** @type {Record<string, number[]>} */ bySem) =>
  ({ available: true, bySem: new Map(Object.entries(bySem)), updatedAsAt: '01 Sep 2026', total: Object.keys(bySem).length });

describe('B2', () => {
  it('[B2 known-bug] textHash ignores semesters, credits, workload, prerequisite, preclusion and NG flags', () => {
    const [before] = offeredModules([record], '2026-2027', ng({})).modules;
    const [after] = offeredModules([{
      ...record, moduleCredit: '2', semesterData: [{ semester: 2 }, { semester: 3 }],
      workload: [0, 0, 0, 5, 5], prerequisite: 'CS1231', preclusion: 'None',
    }], '2026-2027', ng({ CS1010S: [2] })).modules;
    expect(after).toMatchObject({ credits: 2, semesters: [2, 3], ng: true, ngSemesters: [2], prerequisite: 'CS1231' });
    expect(after.textHash).toBe(before.textHash);
  });

  it('[B2 known-bug] scripts/ingest.mjs skips a module whenever its textHash is unchanged', async () => {
    const src = await readFile(fileURLToPath(new URL('../../scripts/ingest.mjs', import.meta.url)), 'utf8');
    expect(src).toContain('const todo = modules.filter((m) => force || existing[m.code] !== m.textHash);');
    // Nothing in the pipeline deletes a module that left the corpus.
    expect(src).not.toMatch(/delete/i);
  });

  it('[B2 known-bug] the .data/ download cache is used however old it is', async () => {
    const file = 'findings-test.json';
    const path = new URL(`1999-2000-${file}`, CACHE_DIR);
    // Never let this test reach api.nusmods.com.
    const fetchSpy = vi.fn(() => { throw new Error('network is banned in tests'); });
    vi.stubGlobal('fetch', fetchSpy);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path, '{"stale":true}');
    const longAgo = new Date('2000-01-01T00:00:00Z');
    await utimes(path, longAgo, longAgo);
    try {
      const got = await fetchAcadYearFile('1999-2000', file);
      expect(got).toMatchObject({ cached: true, data: { stale: true } });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await rm(path, { force: true });
    }
  });

  afterEach(() => { vi.unstubAllGlobals(); });
});

describe('S3', () => {
  it('[S3 known-bug] the embedded text has no module code or level and puts department/faculty before the description', () => {
    const text = embeddingText(record);
    expect(text).toBe(
      'Programming Methodology. Computer Science. Computing. This course introduces the fundamental concepts of problem solving by computing.');
    expect(text).not.toContain('CS1010S');
    expect(text).not.toMatch(/level|1000/i);
  });
});
