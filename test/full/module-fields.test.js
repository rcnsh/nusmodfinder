// @ts-check
// Phase 6 6A over the pinned corpus (docs/plans/phase6.md §3 "6A"):
// `/module/:code`'s otherCodes from the pinned groups, and the pinned
// NG-listed codes with no classes, built in memory as the pinned groups are
// (vitest.config.mjs). Skipped without the corpus; with FULL_CORPUS=1 a missing
// one fails in vitest.config.mjs before any test runs.
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { unscheduled } from '../../src/ng-unscheduled.js';
import { callJson, seed } from '../helpers.js';

const corpus = inject('corpus');

describe.skipIf(!corpus)('/module/:code over the pinned corpus (6A)', () => {
  const c = /** @type {FullCorpus} */ (corpus);

  beforeAll(async () => {
    await seed({ modules: c.modules.filter((m) => m.code.startsWith('ACC1701')) });
  }, 120_000);

  it('ACC1701XB\'s other codes are the pinned group\'s: ACC1701A-E, XA, XC and XD', async () => {
    const { status, body } = await callJson('/module/ACC1701XB');
    expect(status).toBe(200);
    expect(body.otherCodes).toEqual(['ACC1701A', 'ACC1701B', 'ACC1701C', 'ACC1701D', 'ACC1701E', 'ACC1701XA', 'ACC1701XC', 'ACC1701XD']);
  });

  it('the pinned NG-listed codes with no classes are the 32 the pinned corpus offers no row for, PL3265 among them', async () => {
    const offered = new Set(c.offeredCodes);
    const ng = new Set(Object.values(c.ng.semesters).flat());
    const want = [...ng].filter((code) => !offered.has(code)).sort();
    expect(want).toHaveLength(32);
    expect([...unscheduled().keys()]).toEqual(want);
    const { status, body } = await callJson('/module/PL3265');
    expect(status).toBe(404);
    expect(body).toMatchObject({ kind: 'ng-listed', code: 'PL3265', acadYear: c.acadYear });
  });
});
