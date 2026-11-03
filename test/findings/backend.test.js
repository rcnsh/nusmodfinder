// @ts-check
// Backend findings B3-B8 and O4, characterised over the fixture corpus.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import worker from '../../src/index.js';
import { createFakes } from '../fakes.js';
import { BASE, call, callJson, fixture, seed } from '../helpers.js';
import { codes, ftsCalls, recordingDb, settlesWithin } from './support.js';

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('B3', () => {
  it('[B3 known-bug] the FTS update/delete triggers delete by the UNINDEXED code column, a full scan', async () => {
    const plan = await env.DB.prepare('EXPLAIN QUERY PLAN DELETE FROM modules_fts WHERE code = ?').bind('CS1010S').all();
    // FTS5 idxStr "0:" = no usable constraint, i.e. scan every row.
    expect(plan.results.map((r) => r.detail)).toEqual(['SCAN modules_fts VIRTUAL TABLE INDEX 0:']);
    // A rowid delete, for contrast, is a point lookup.
    const byRowid = await env.DB.prepare('EXPLAIN QUERY PLAN DELETE FROM modules_fts WHERE rowid = ?').bind(1).all();
    expect(byRowid.results.map((r) => r.detail)).toEqual(['SCAN modules_fts VIRTUAL TABLE INDEX 0:=']);

    // The trigger body is the one in migrations/0002_fts.sql.
    const trigger = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE name = 'modules_fts_update'").first('sql');
    expect(trigger).toContain('DELETE FROM modules_fts WHERE code = old.code');

    // Cost: one upsert of one row reads the whole FTS table.
    const res = await env.DB.prepare("UPDATE modules SET title = title WHERE code = 'CS1010S'").run();
    expect(res.meta.rows_read).toBeGreaterThanOrEqual(fixture.modules.length);
  });
});

describe('B4', () => {
  it('[B4 known-bug] the lexical query does not start until embedding has finished (fully serial)', async () => {
    const hanging = createFakes();
    hanging.vectorize.vectors = fakes.vectorize.vectors;
    hanging.ai.hangs();
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const pending = call('/search?q=machine%20learning%20serial', { fakes: hanging, env: { DB: recordingDb(log) } });
    expect(await settlesWithin(pending, 100)).toBe('pending');
    expect(hanging.ai.calls).toHaveLength(1);
    expect(ftsCalls(log)).toEqual([]);
  });

  it('[B4 known-bug] a hybrid search runs embed -> Vectorize -> FTS -> hydrate one after another', async () => {
    /** @type {string[]} */
    const order = [];
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    const run = f.ai.run.bind(f.ai), query = f.vectorize.query.bind(f.vectorize);
    f.ai.run = async (...a) => { order.push('ai:start'); const r = await run(...a); order.push('ai:end'); return r; };
    f.vectorize.query = async (...a) => { order.push('vec:start'); const r = await query(...a); order.push('vec:end'); return r; };
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const db = recordingDb(log);
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => { order.push(sql.includes('MATCH') ? 'fts' : sql.includes('IN (') ? 'hydrate' : 'd1'); return prepare(sql); };
    await call('/search?q=machine%20learning%20order', { fakes: f, env: { DB: db } });
    expect(order).toEqual(['ai:start', 'ai:end', 'vec:start', 'vec:end', 'fts', 'hydrate']);
  });

  it('[B4 known-bug] responses carry no Server-Timing header', async () => {
    const res = await call('/search?q=databases%20timing', { fakes });
    expect(res.status).toBe(200);
    expect(res.headers.get('server-timing')).toBeNull();
  });
});

// Behavioural, not structural: any upstream timeout shorter than HANG_MS makes the search
// settle and these tests fail, however the timer is armed (setTimeout, scheduler.wait,
// AbortSignal.timeout, a captured reference). Phase 1 plans 1.5 s; a timeout longer
// than HANG_MS would not be a usable search timeout.
const HANG_MS = 4000; // catches timeouts up to ~3.9 s (the harness arms its timer slightly earlier)

describe('B5', () => {
  it('[B5 known-bug] /module/%E0%A4%A throws a URIError out of fetch (workerd answers 500, error 1101)', async () => {
    await expect(call('/module/%E0%A4%A')).rejects.toThrow(URIError);
  });

  it('[B5 known-bug] a hanging Workers AI call hangs the search: there is no upstream timeout', async () => {
    const hanging = createFakes();
    hanging.ai.hangs();
    expect(await settlesWithin(call('/search?q=machine%20learning%20hang', { fakes: hanging }), HANG_MS)).toBe('pending');
  }, HANG_MS + 5000);

  it('[B5 known-bug] a hanging Vectorize query hangs the search too', async () => {
    const hanging = createFakes();
    hanging.vectorize.hangs();
    expect(await settlesWithin(call('/search?q=machine%20learning%20hang2', { fakes: hanging }), HANG_MS)).toBe('pending');
  }, HANG_MS + 5000);

  it('[B5 known-bug] an exception outside the per-call try/catch escapes fetch unhandled', async () => {
    // The rate limiter call in fetch() is not wrapped.
    const f = createFakes();
    f.limit.throws('limiter down');
    await expect(call('/search?q=limiter%20down', { fakes: f })).rejects.toThrow('limiter down');
  });
});

describe('B6', () => {
  it.each([
    ['ai', 'workers-ai'],
    ['vectorize', 'vectorize'],
  ])('[B6 known-bug] %s throwing fails the whole search with a 502 and no keyword fallback', async (which, source) => {
    const f = createFakes();
    f.vectorize.vectors = fakes.vectorize.vectors;
    (which === 'ai' ? f.ai : f.vectorize).throws('down');
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const { status, body } = await callJson('/search?q=programming%20methodology', { fakes: f, env: { DB: recordingDb(log) } });
    expect(status).toBe(502);
    expect(body).toEqual({ error: 'upstream_failure', source, message: 'down' });
    expect(ftsCalls(log)).toEqual([]);

    // The keyword half works on its own, so a fallback was possible.
    const lexical = await callJson('/search?q=programming%20methodology&mode=lexical', { fakes: f });
    expect(lexical.status).toBe(200);
    expect(codes(lexical.body.results)).toContain('CS1010S');
  });
});

describe('B7', () => {
  it('[B7 known-bug] the cache key is the raw URL: param order, case and junk params each miss', async () => {
    const urls = [
      '/search?q=data%20visualisation&sem=2&topK=7',
      '/search?topK=7&sem=2&q=data%20visualisation',
      '/search?q=Data%20Visualisation&sem=2&topK=7',
      '/search?q=data%20visualisation&sem=2&topK=7&_r=x1',
    ];
    for (const u of urls) await caches.default.delete(new Request(new URL(u, BASE).toString()));
    const before = fakes.ai.calls.length;
    /** @type {string[][]} */
    const lists = [];
    for (const u of urls) lists.push(codes((await (await call(u, { fakes, keepCache: true })).json()).results));
    // Four misses, four embeddings, for one logical query.
    expect(fakes.ai.calls.length - before).toBe(4);
    for (const u of urls) expect(await caches.default.match(new Request(new URL(u, BASE).toString()))).toBeDefined();
    // Order and junk do not change the answer; only the cache entry.
    expect(lists[1]).toEqual(lists[0]);
    expect(lists[3]).toEqual(lists[0]);

    // An identical repeat is a hit.
    await call(urls[0], { fakes, keepCache: true });
    expect(fakes.ai.calls.length - before).toBe(4);
  });
});

describe('B8', () => {
  it('[B8 known-bug] an empty topK= returns 1 result instead of the default 20', async () => {
    const { body } = await callJson('/search?q=machine%20learning&topK=', { fakes });
    expect(body.count).toBe(1);
    expect(body.results).toHaveLength(1);
  });

  it('[B8 known-bug] hydration reads every fused candidate and columns the response never uses', async () => {
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    const { body } = await callJson('/search?q=machine%20learning%20hydrate&topK=20', { fakes, env: { DB: recordingDb(log) } });
    const hydrate = log.filter((c) => c.sql.includes('WHERE code IN'));
    expect(hydrate).toHaveLength(1);
    expect(body.results).toHaveLength(20);
    expect(hydrate[0].binds.length).toBe(body.retrieval.fused);
    expect(hydrate[0].binds.length).toBeGreaterThan(20);
    for (const col of ['description', 'workload', 'prerequisite', 'preclusion', 'acad_year']) {
      expect(hydrate[0].sql).toContain(col);
      expect(Object.keys(body.results[0])).not.toContain(col);
    }
  });

  it('[B8 known-bug] Vectorize is asked for indexed metadata it never reads, which caps topK at 50', async () => {
    const before = fakes.vectorize.calls.length;
    const { body } = await callJson('/search?q=machine%20learning%20ceiling&topK=100', { fakes });
    const opts = /** @type {any} */ (fakes.vectorize.calls[before].args[1]);
    expect(opts).toMatchObject({ topK: 50, returnMetadata: 'indexed' });
    expect(body.count).toBe(50);
  });

  it('[B8 known-bug] the ASCII-only tokeniser splits "naïve" into "na" and "ve"', async () => {
    /** @type {import('./support.js').DbCall[]} */
    const log = [];
    await callJson('/search?q=na%C3%AFve%20bayes&mode=lexical', { fakes, env: { DB: recordingDb(log) } });
    expect(ftsCalls(log)[0].binds[0]).toBe('"na" OR "ve" OR "bayes"');
  });
});

describe('O4', () => {
  it('[O4 known-bug] the Worker has no scheduled handler, so nothing refreshes the data', () => {
    expect(Object.keys(worker)).toEqual(['fetch']);
  });
});
