// @ts-check
import { describe, expect, inject, it } from 'vitest';

const corpus = inject('corpus');

describe.skipIf(!corpus)('full pinned corpus', () => {
  const c = /** @type {FullCorpus} */ (corpus);

  it('is the pinned snapshot', () => {
    expect(c.moduleInfoSha256).toBe('2d138795d387d133237669a7f5a22c7c4d30b4a26bf82dad0a982636e80857b1');
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
