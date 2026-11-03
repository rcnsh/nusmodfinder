// @ts-check
// The eval run, inside workerd. Not part of `npm test`: vitest.eval.config.mjs
// runs it from a workspace (.eval-work/) holding the ranker under test (src/,
// migrations/ from a git ref or the working tree) next to this runner, so the
// relative imports below resolve to that ranker. Started by eval/runner/run.mjs,
// which provides `evalPayload`.
//
// Seeds local D1 + the fake Vectorize through the Worker's own /admin/ingest
// with real corpus embeddings, then sends one /search per query with
// production defaults and the query's filters. One test per query, named by
// its opaque id; the result travels to the Node-side reporter in task.meta.
import { beforeAll, describe, inject, it } from 'vitest';
import { call, seed } from './harness.js';
import { createFakes } from '../../test/fakes.js';
import { LookupAI } from './lookup-ai.js';

const payload = /** @type {EvalPayload} */ (inject('evalPayload'));
if (!payload) throw new Error('evalPayload not provided; run through `npm run eval`, not vitest directly');

const fakes = createFakes();
const ai = new LookupAI(payload.lookup);
// The Worker only calls `run`.
fakes.ai = /** @type {any} */ (ai);

beforeAll(async () => {
  await seed(payload.corpus, fakes);
  if (ai.missing.length) throw new Error(`seeding left ${ai.missing.length} corpus texts unembedded`);
}, payload.seedTimeoutMs);

describe('eval', () => {
  for (const q of payload.queries) {
    it(q.id, async ({ task }) => {
      ai.missing.length = 0;
      const res = await call(`/search?${new URLSearchParams(q.params)}`, fakes);
      const text = await res.text();
      /** @type {any} */
      let body = null;
      try { body = JSON.parse(text); } catch { /* recorded as an error below */ }
      const results = res.status === 200 && Array.isArray(body?.results) ? body.results : [];
      /** @type {EvalQueryResult} */
      const out = {
        status: res.status,
        codes: results.map((/** @type {any} */ r) => String(r.code)),
        docs: Object.fromEntries(results.map((/** @type {any} */ r) => [r.code, {
          level: r.level ?? null,
          semesters: r.semesters ?? [],
          ng: r.ng === true,
          ngSemesters: r.ngSemesters ?? [],
          credits: r.credits ?? null,
          faculty: r.faculty ?? null,
        }])),
        ...(res.status === 200 ? {} : { error: body ? `${body.error}: ${body.message}` : `non-JSON HTTP ${res.status}` }),
        missing: [...ai.missing],
      };
      task.meta.vnmEval = out;
      if (ai.missing.length) {
        throw new Error(`${ai.missing.length} text(s) have no precomputed embedding; run \`npm run eval:embed\` locally`);
      }
      // A degraded response skipped the dense half (an embedding error, or the
      // breaker opened by earlier ones): it measures a different ranker.
      if (body?.degraded) {
        throw new Error(`degraded response (${body.degraded.source}: ${body.degraded.reason}); the dense half did not run`);
      }
    });
  }
});
