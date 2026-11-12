// @ts-check
// SC1's assertions that are facts of the pinned corpus, not invariants
// (Phase 7 7D, docs/plans/phase7.md "Corpus-specific assertions stay in
// full-corpus"). test/sc1 runs over production's corpus and asserts only what
// holds for any corpus; these two hold for the pinned corpus and bundle (the
// eval's) and are asserted here:
// - the standby's recall@50 against the bundle, mean over the queries, per
//   (sem, study) combination, is at or above STANDBY_RECALL_FLOOR;
// - 3G (docs/plans/phase4.md §4 gate 2): no dev query outside the no-answer
//   tag is pushed into no-signal under the bit, until Jacob rules on it.
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import devQueries from '../../eval/dev/queries.json';
import studyMap from '../../eval/study-map.json';
import { denseBundle } from '../../src/dense.js';
import { storedVectorMetadata } from '../../src/rowhash.js';
import { createFakes } from '../fakes.js';
import { callJson, seed } from '../helpers.js';
import { CacheAI, COMBOS, QUERIES, ngDevRequests, shownCodes } from '../sc1/shared.js';

const corpus = inject('corpus');
const bundleKind = inject('vectorsBundle');

/**
 * Standby recall@50 against the bundle, mean over the queries, per
 * combination. Phase 4 plan §2's simulation over the 98 dev queries at depth
 * 100: 0.998 for a level-cut bit, 0.892 for a ug1-like bit (worst query 0.04).
 * The floor sits below the simulation's worst mean.
 */
const STANDBY_RECALL_FLOOR = 0.85;

describe.skipIf(!corpus || bundleKind !== 'pinned')('SC1 over the pinned corpus: its corpus-specific assertions', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  // The standby's queries embed with the default fake, as in test/sc1/paths.test.js:
  // the bundle and the standby rank the same query vector.
  const standbyFakes = createFakes();
  // The dev queries embed from the committed caches, as in test/sc1/identity.test.js.
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

  it('3G: no dev query outside the no-answer tag is pushed into no-signal under the bit', async () => {
    /** @type {string[]} */
    const noSignal = [];
    let answered = 0;
    for (const { q, path } of ngDevRequests(devQueries.queries, studyMap)) {
      const page = await callJson(path, { fakes: devFakes });
      if (page.status !== 200) continue;
      answered++;
      if (page.body.noMatch?.reason === 'no-signal') noSignal.push(`${q.id} [${q.shapes.join(',')}]`);
    }
    console.info(`3G over the pinned corpus: ${answered} ng dev queries answered; no-signal: ${noSignal.join('; ') || 'none'}`);
    expect(answered).toBeGreaterThan(80);
    expect(noSignal.filter((s) => !s.includes('noanswer'))).toEqual([]);
  }, 600_000);
});
