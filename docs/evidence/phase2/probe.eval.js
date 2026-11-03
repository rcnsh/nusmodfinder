// Phase 2c analysis probe, inside workerd. probe.mjs copies this file over the
// workspace's eval/runner/retrieval.eval.js, so it runs exactly where the eval
// runner does: the ranker at a ref (eval-v0), seeded through its own
// /admin/ingest with real corpus vectors, the HEAD harness and fakes.
//
// Differences from the eval runner, all analysis-only:
// - keeps the whole /search body (RRF scores, `retrieval` counts), not just codes;
// - per request, an optional `override` lookup answers the query embedding
//   first (the alternative vectors of the noise experiments), the base lookup
//   otherwise;
// - with `fts`, returns FTS5 `rank` values of every match of the query's
//   tokens (v0's ftsTokens), so lexical tie groups are known.
import { beforeAll, describe, inject, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { call, seed } from './harness.js';
import { createFakes } from '../../test/fakes.js';
import { LookupAI } from './lookup-ai.js';

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

// eval-v0's ftsTokens (src/index.js at 7ac9841).
const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'for', 'from',
  'how', 'i', 'in', 'is', 'it', 'me', 'my', 'of', 'on', 'or', 'own', 'the', 'to', 'with', 'you', 'your']);
/** @param {string} query */
function ftsTokens(query) {
  const all = query.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const tokens = all.filter((t) => !STOPWORDS.has(t));
  return tokens.length ? tokens : all;
}

/**
 * eval-v0's lexical list (lexicalSearch + runFts at 7ac9841, depth 50 for the
 * default topK), pinned code included: the SQL and the JS semester filter
 * verbatim, so the order among FTS5 rank ties is the one v0 sees.
 * @param {URLSearchParams} params
 */
async function v0LexicalList(params) {
  const tokens = ftsTokens((params.get('q') ?? '').trim());
  if (!tokens.length) return [];
  const match = tokens.map((t) => `"${t}"`).join(' OR ');
  const where = ['modules_fts MATCH ?'];
  /** @type {(string | number)[]} */
  const binds = [match];
  const sem = params.get('sem') ? Number(params.get('sem')) : undefined;
  const level = params.get('level');
  const credits = params.get('credits');
  const faculty = params.get('faculty')?.trim();
  const ngRaw = params.get('ng');
  const ng = ngRaw !== null && ngRaw !== '' && ngRaw !== 'false' && ngRaw !== '0';
  if (level) { where.push('m.level = ?'); binds.push(Number(level)); }
  if (credits) { where.push('m.credits = ?'); binds.push(Number(credits)); }
  if (faculty) { where.push('m.faculty = ?'); binds.push(faculty); }
  if (ng) where.push('m.ng = 1');
  const needsJoin = where.length > 1 || sem !== undefined;
  const sql = needsJoin
    ? `SELECT m.code AS code, m.semesters AS semesters
         FROM modules_fts JOIN modules m ON m.code = modules_fts.code
        WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`
    : `SELECT modules_fts.code AS code, NULL AS semesters
         FROM modules_fts WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ?`;
  const depth = 50;
  const { results } = await env.DB.prepare(sql).bind(...binds, depth * 4).all();
  return results
    .filter((x) => sem === undefined || JSON.parse(String(x.semesters ?? '[]')).includes(sem))
    .slice(0, depth)
    .map((x) => String(x.code));
}

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
      const res = await call(r.path, fakes);
      const text = await res.text();
      /** @type {any} */
      let body = null;
      try { body = JSON.parse(text); } catch { body = { nonJson: text.slice(0, 200) }; }
      /** @type {Record<string, number> | null} */
      let fts = null;
      if (r.fts) {
        const q = new URL(r.path, 'https://x.test').searchParams.get('q') ?? '';
        const tokens = ftsTokens(q.trim());
        if (tokens.length) {
          const match = tokens.map((t) => `"${t}"`).join(' OR ');
          const { results } = await env.DB.prepare('SELECT code, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank LIMIT 2000').bind(match).all();
          fts = Object.fromEntries(results.map((x) => [String(x.code), Number(x.rank)]));
        } else fts = {};
      }
      /** @type {string[] | null} */
      let lex = null;
      if (r.lex) lex = await v0LexicalList(new URL(r.path, 'https://x.test').searchParams);
      /** @type {any} */ (task.meta).probe = { status: res.status, body, fts, lex };
    });
  }
});
