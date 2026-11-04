// Second fidelity check (fidelity-2.md): the analysis probe for a ranker at or
// after Phase 1 (src/search.js, src/lexical.js), inside workerd. probe.mjs
// copies it over the workspace's eval/runner/retrieval.eval.js (option
// `spec`), so it runs where the eval runner does: the ranker seeded through
// its own /admin/ingest with real corpus vectors, the HEAD harness and fakes.
// probe.eval.js is the eval-v0 counterpart; it replicates v0's SQL, which the
// Phase 1 ranker no longer runs.
//
// Differences from the eval runner, all analysis-only:
// - keeps the whole /search body;
// - deletes the request's canonical cache entry first. Since B7 the cache key
//   drops unknown parameters, so the `_p` tags that kept the v0 probe's noise
//   conditions apart no longer do; without the delete a condition would get
//   the base condition's cached body;
// - per request, an optional `override` lookup answers the query embedding
//   first (noise conditions), the base lookup otherwise;
// - with `lex`, returns the ranker's own lexical list at depth 50
//   (lexicalSearch, the call runSearch makes), and with `fts` the FTS5 `rank`
//   value of every match that passes the request's filters, so lexical tie
//   groups are known;
// - refuses a degraded answer or an open dense breaker: a degraded response
//   measures keyword-only retrieval, not the ranker.
import { beforeAll, describe, inject, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seed } from './harness.js';
import { createFakes } from '../../test/fakes.js';
import { LookupAI } from './lookup-ai.js';
import { ftsMatch, lexicalSearch } from '../../src/lexical.js';
import { parseSearch, searchCacheKey } from '../../src/search.js';
import { Trace } from '../../src/timing.js';
import { denseCircuit } from '../../src/upstream.js';

const BASE = 'https://vector-nusmods.test';
const DEPTH = 50;
// Larger than the corpus, so lexicalSearch returns every filtered match.
const ALL = 100_000;

const payload = /** @type {any} */ (inject('evalPayload'));
const fakes = createFakes();
const base = new LookupAI(payload.lookup);
/** @type {Record<string, LookupAI>} */
const overrides = Object.fromEntries(Object.entries(payload.overrides ?? {}).map(([k, l]) => [k, new LookupAI(/** @type {any} */ (l))]));

class SwitchAI {
  /** @type {LookupAI | null} */
  current = null;
  /** @param {string} model @param {{ text: string | string[] }} input */
  async run(model, input) {
    if (this.current) {
      const texts = Array.isArray(input.text) ? input.text : [input.text];
      const before = this.current.missing.length;
      try {
        return await this.current.run(model, input);
      } catch {
        this.current.missing.length = before;
        if (texts.length !== 1) throw new Error('probe: override lookups answer one text at a time');
      }
    }
    return base.run(model, input);
  }
}
const ai = new SwitchAI();
fakes.ai = /** @type {any} */ (ai);

beforeAll(async () => {
  ai.current = null;
  await seed(payload.corpus, fakes);
  if (base.missing.length) throw new Error(`seeding left ${base.missing.length} corpus texts unembedded`);
}, payload.seedTimeoutMs);

describe('probe', () => {
  for (const r of payload.requests) {
    it(r.id, async ({ task }) => {
      ai.current = r.override ? overrides[r.override] : null;
      if (r.override && !ai.current) throw new Error(`no override lookup ${r.override}`);
      const url = new URL(r.path, BASE);
      const key = searchCacheKey(url);
      if (key) await caches.default.delete(key);
      if (denseCircuit.open()) throw new Error('dense breaker open before the request');
      const missingBefore = base.missing.length;
      const res = await call(r.path, fakes);
      const text = await res.text();
      /** @type {any} */
      let body = null;
      try { body = JSON.parse(text); } catch { body = { nonJson: text.slice(0, 200) }; }
      if (body?.degraded) throw new Error(`degraded response (${body.degraded.source}: ${body.degraded.reason})`);
      if (base.missing.length !== missingBefore) throw new Error('a query text had no precomputed embedding');
      const parsed = parseSearch(url.searchParams);
      if (!parsed.query) throw new Error(`invalid request: ${parsed.error}`);
      const { q, echo } = parsed.query;
      /** @type {string[] | null} */
      let lex = null;
      if (r.lex) lex = await lexicalSearch(env.DB, q, echo, DEPTH, new Trace());
      /** @type {Record<string, number> | null} */
      let fts = null;
      if (r.fts) {
        const match = ftsMatch(q);
        fts = {};
        if (match) {
          const passing = new Set(await lexicalSearch(env.DB, q, echo, ALL, new Trace()));
          const { results } = await env.DB.prepare('SELECT code, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank').bind(match).all();
          for (const x of results) if (passing.has(String(x.code))) fts[String(x.code)] = Number(x.rank);
          if (Object.keys(fts).length !== passing.size) throw new Error('rank values do not cover every filtered match');
        }
      }
      /** @type {any} */ (task.meta).probe = { status: res.status, body, fts, lex, serverTiming: res.headers.get('server-timing') };
    });
  }
});
