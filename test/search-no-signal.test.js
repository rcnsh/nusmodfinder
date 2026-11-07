// @ts-check
// 3G in /search (docs/plans/phase3.md 3G): a query with no signal (no route,
// no vocabulary match before correction: parsed.noSignal) whose top exact
// cosine, for the query as typed, is below τ answers `count: 0` with
// `noMatch: { reason: "no-signal" }`, before hydration. The fixture's fake
// embedder has its own cosine scale, so these tests set τ through
// NO_SIGNAL_TAU; the τ in force is src/no-signal.js's.
import { beforeAll, describe, expect, it } from 'vitest';
import { createFakes } from './fakes.js';
import { callJson, seed } from './helpers.js';
import { recordingDb } from './findings/support.js';

const ALWAYS = { NO_SIGNAL_TAU: '1.01' };
const NEVER = { NO_SIGNAL_TAU: '-1.01' };
const GIBBERISH = '/search?q=xqzvbnm%20flurble';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => { fakes = await seed(); });

describe('no-signal', () => {
  it('a signal-less query below τ answers count 0 with noMatch no-signal, in hybrid and vector mode and on the standby', async () => {
    for (const [extra, env] of /** @type {const} */ ([['', {}], ['&mode=vector', {}], ['', { DENSE_BACKEND: 'vectorize' }]])) {
      const { status, body } = await callJson(`${GIBBERISH}${extra}`, { fakes, env: { ...ALWAYS, ...env } });
      expect(status).toBe(200);
      expect(body, `${extra} ${JSON.stringify(env)}`).toMatchObject({ count: 0, results: [], noMatch: { reason: 'no-signal' } });
    }
  });

  it('at or above τ the query searches as before', async () => {
    const { body } = await callJson(GIBBERISH, { fakes, env: NEVER });
    expect(body.count).toBe(20);
    expect(body.noMatch).toBeUndefined();
  });

  it('a query with a signal never fires, whatever τ', async () => {
    for (const q of ['machine%20learning', 'cs1010s', 'cs1', 'psych']) {
      const { body } = await callJson(`/search?q=${q}`, { fakes, env: ALWAYS });
      expect(body.noMatch, q).toBeUndefined();
      expect(body.count, q).toBeGreaterThan(0);
    }
  });

  it('needs the dense half: lexical mode and a degraded search never fire', async () => {
    const lexical = await callJson(`${GIBBERISH}&mode=lexical`, { fakes, env: ALWAYS });
    expect(lexical.body.noMatch).toBeUndefined();
    const failing = createFakes();
    failing.ai.throws('down');
    const degraded = await callJson(GIBBERISH, { fakes: failing, env: ALWAYS });
    expect(degraded.body.degraded).toMatchObject({ source: 'workers-ai' });
    expect(degraded.body.noMatch).toBeUndefined();
  });

  it('answers before hydration: no module rows are read', async () => {
    /** @type {import('./findings/support.js').DbCall[]} */
    const log = [];
    const { body } = await callJson(`${GIBBERISH}%20hydrate`, { fakes, env: { ...ALWAYS, DB: recordingDb(log) } });
    expect(body.noMatch).toMatchObject({ reason: 'no-signal' });
    expect(log.filter((c) => c.sql.includes('WHERE code IN'))).toEqual([]);
  });
});
