// @ts-check
// Invariants over the full pinned corpus (.data/, release
// PINNED_RELEASE). Skipped when the corpus is absent; with
// FULL_CORPUS=1 an absent or mismatched corpus fails in vitest.config.mjs
// before any test runs.
import { describe, expect, inject, it } from 'vitest';

const corpus = inject('corpus');

describe.skipIf(!corpus)('full pinned corpus', () => {
  const c = /** @type {FullCorpus} */ (corpus);

  it('is the pinned snapshot', () => {
    expect(c.moduleInfoSha256).toBe('2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1');
    // docs/data.md: 6,771 of the 21,130 records are offered this year.
    expect(c.recordCount).toBe(21130);
    expect(c.modules).toHaveLength(6771);
    expect(c.skipped).toEqual([]);
  });

  it('marks every offered NG course as NG, with the NG list semesters', () => {
    const offered = new Set(c.offeredCodes);
    const byCode = new Map(c.modules.map((m) => [m.code, m]));
    /** @type {Map<string, number[]>} */
    const ngSemesters = new Map();
    for (const [sem, codes] of Object.entries(c.ng.semesters)) {
      for (const code of codes) ngSemesters.set(code, [...(ngSemesters.get(code) ?? []), Number(sem)]);
    }
    const offeredNg = [...ngSemesters.keys()].filter((code) => offered.has(code));
    // docs/exchange-mode.md: 1,175 of the 1,207 codes in the NG PDF are offered this year.
    expect(ngSemesters.size).toBe(1207);
    expect(offeredNg).toHaveLength(1175);

    const missing = offeredNg.filter((code) => byCode.get(code)?.ng !== true);
    expect(missing).toEqual([]);
    for (const code of offeredNg) {
      expect(byCode.get(code)?.ngSemesters, code).toEqual([...(ngSemesters.get(code) ?? [])].sort((a, b) => a - b));
    }
    expect(c.modules.filter((m) => m.ng)).toHaveLength(1175);
  });
});
