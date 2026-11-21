// @ts-check
import { beforeAll, describe, inject, it } from 'vitest';
import { call, seed } from './harness.js';
import { createFakes } from '../../test/fakes.js';
import { LookupAI } from './lookup-ai.js';

const payload = /** @type {EvalPayload} */ (inject('evalPayload'));
if (!payload) throw new Error('evalPayload not provided; run through `npm run eval`, not vitest directly');

const fakes = createFakes();
const ai = new LookupAI(payload.lookup);
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
      try { body = JSON.parse(text); } catch {}
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
        interpreted: res.status === 200 && body?.interpreted && typeof body.interpreted === 'object'
          ? Object.fromEntries(['exam', 'su', 'hoursBelow', 'prereq'].map((k) => [k, body.interpreted[k] ?? null]))
          : null,
        missing: [...ai.missing],
      };
      task.meta.vnmEval = out;
      if (ai.missing.length) {
        throw new Error(`${ai.missing.length} text(s) have no precomputed embedding; run \`npm run eval:embed\` locally`);
      }
      if (body?.degraded) {
        throw new Error(`degraded response (${body.degraded.source}: ${body.degraded.reason}); the dense half did not run`);
      }
    });
  }
});
