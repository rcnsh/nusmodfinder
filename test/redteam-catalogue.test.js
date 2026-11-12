// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), finding L-1: ingest refuses to delete more than
// 5% of D1's modules without --allow-mass-delete, but catalogue_only (step 4b, scripts/ingest-core.mjs)
// has no such guard. A corpus whose catalogue-only records are missing (a hostile or broken NUSMods
// answer, published with `corpus publish --new-data-version` as the corpus-only runbook says) passes
// `corpus check` (the bundled catalogue file is rebuilt from the same corpus) and the deploy guard
// (catalogueKey of D1 equals the file's), and the ingest deletes every catalogue_only row unasked.
//
// runIngest against the real Worker routes and local D1, as test/ingest.test.js drives it.
// `it.fails`: asserts the guard the modules already have.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { runIngest } from '../scripts/ingest-core.mjs';
import { fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };
const MODEL = '@cf/baai/bge-small-en-v1.5';
/** @type {import('./fakes.js').Fakes} */
let fakes;
let clock = 0;

/** @param {{ code: string, title: string, description: string | null }[]} catalogue @param {Record<string, unknown>} [options] */
const ingest = (catalogue, options = {}) => runIngest({
  modules: fixture.modules, facetsBody, api: adminApi(() => fakes), options: { embeddingModel: MODEL, ...options },
  sleep: async (ms) => { clock += ms; }, now: () => clock, catalogue,
});
const catalogueCount = async () => Number(await env.DB.prepare('SELECT count(*) AS n FROM catalogue_only').first('n'));

beforeEach(async () => { clock = 0; fakes = await seed(); });

describe('red team L-1: catalogue_only has no mass-delete guard', () => {
  it.fails('a corpus with 1 of 200 catalogue-only codes is refused without allowMassDelete, as a module drop is', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({ code: `ZZ${String(1000 + i)}`, title: `Old course ${i}`, description: null }));
    expect((await ingest(full)).status).toBe('done');
    expect(await catalogueCount()).toBe(200);

    const r = await ingest(full.slice(0, 1));
    // Observed: status 'done', catalogue { upserted: 0, deleted: 199 }, 1 row left.
    expect({ status: r.status, left: await catalogueCount() }).toEqual({ status: 'refused', left: 200 });
  });
});
