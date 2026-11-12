// @ts-check
// The exchange-eligibility oracle's assertions that are facts of the pinned
// corpus, not invariants, so they stay in test/full. test/oracle runs over production's corpus and asserts only what
// holds for any corpus; these two hold for the pinned corpus and bundle (the
// eval's) and are asserted here:
// - the standby's recall@50 against the bundle, mean over the queries, per
//   (sem, study) combination, is at or above STANDBY_RECALL_FLOOR;
// - the no-signal check: no dev query outside the no-answer tag is pushed
//   into no-signal under the bit.
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import devQueries from '../../eval/dev/queries.json';
import studyMap from '../../eval/study-map.json';
import { denseBundle } from '../../src/dense.js';
import { storedVectorMetadata } from '../../src/rowhash.js';
import { createFakes } from '../fakes.js';
import { callJson, seed } from '../helpers.js';
import { CacheAI, COMBOS, QUERIES, ngDevRequests, shownCodes } from '../oracle/shared.js';

const corpus = inject('corpus');
const bundleKind = inject('vectorsBundle');

/**
 * Standby recall@50 against the bundle, mean over the queries, per
 * combination. A simulation over the 98 dev queries at depth 100 gives
 * 0.998 for a level-cut bit, 0.892 for a ug1-like bit (worst query 0.04).
 * The floor sits below the simulation's worst mean.
 */
const STANDBY_RECALL_FLOOR = 0.85;

describe.skipIf(!corpus || bundleKind !== 'pinned')('the oracle over the pinned corpus: its corpus-specific assertions', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  // The standby's queries embed with the default fake, as in test/oracle/paths.test.js:
  // the bundle and the standby rank the same query vector.
  const standbyFakes = createFakes();
  // The dev queries embed from the committed caches, as in test/oracle/identity.test.js.
  const devFakes = createFakes();
  devFakes.ai = /** @type {any} */ (new CacheAI());

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed({ modules: c.modules, fakes: standbyFakes });
    const b = denseBundle();
    standbyFakes.vectorize.vectors = new Map(b.codes.map((code, i) => [code, {
      id: code, values: Array.from(b.vectors.subarray(i * b.dims, (i + 1) * b.dims)),
      metadata: storedVectorMetadata(/** @type {NormalisedModule} */ (moduleOf.get(code))),
    }]));
    // No catalogue_only rows: neither check reads them. No-signal is the parse and the top cosine
    // (src/search.js), and a not-offered code answers not-offered with or without its row. Loading
    // ~14k rows here (a 6.6 MB module) also took the workerd pool down in CI.
  }, 600_000);

  it(`the standby keeps recall@50 against the bundle at or above ${STANDBY_RECALL_FLOOR} in every combination`, async () => {
    /** @type {string[]} */
    const recalls = [];
    for (const k of COMBOS) {
      let sum = 0;
      for (const q of QUERIES) {
        const path = `/search?q=${encodeURIComponent(q)}&${k.qs}&mode=vector&topK=50`;
        const bundle = await callJson(path, { fakes: standbyFakes, env: { COLLAPSE_GROUPS: 'off' } });
        const standby = await callJson(path, { fakes: standbyFakes, env: { DENSE_BACKEND: 'vectorize', COLLAPSE_GROUPS: 'off' } });
        const want = new Set(shownCodes(bundle.body));
        sum += want.size ? shownCodes(standby.body).filter((x) => want.has(x)).length / want.size : 1;
      }
      const mean = sum / QUERIES.length;
      recalls.push(`${k.qs} ${mean.toFixed(3)}`);
      expect(mean, k.qs).toBeGreaterThanOrEqual(STANDBY_RECALL_FLOOR);
    }
    console.info(`pinned standby recall@50 by combination:\n  ${recalls.join('\n  ')}`);
  }, 600_000);

  it('the no-signal check: no dev query outside the no-answer tag is pushed into no-signal under the bit', async () => {
    /** @type {string[]} */
    const noSignal = [];
    let answered = 0;
    for (const { q, path } of ngDevRequests(devQueries.queries, studyMap)) {
      const page = await callJson(path, { fakes: devFakes });
      if (page.status !== 200) continue;
      answered++;
      if (page.body.noMatch?.reason === 'no-signal') noSignal.push(`${q.id} [${q.shapes.join(',')}]`);
    }
    console.info(`no-signal check over the pinned corpus: ${answered} ng dev queries answered; no-signal: ${noSignal.join('; ') || 'none'}`);
    expect(answered).toBeGreaterThan(80);
    expect(noSignal.filter((s) => !s.includes('noanswer'))).toEqual([]);
  }, 600_000);
});
