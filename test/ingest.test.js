// @ts-check
// scripts/ingest-core.mjs runIngest against the real Worker routes, local D1
// and the fake Vectorize: the guards that stop a run before any write, the
// write budget and resuming through the hash skip, deletes only after a clean
// upsert phase, the Vectorize mutation wait, and the data version.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { REQUIRED_SCHEMA, runIngest } from '../scripts/ingest-core.mjs';
import { dataVersion, rowHash } from '../src/rowhash.js';
import { createFakes } from './fakes.js';
import { fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };
const MODEL = '@cf/baai/bge-small-en-v1.5';

/** @type {import('./fakes.js').Fakes} */
let fakes;
/** A fake clock the injected sleep advances, so waits cost no wall time. */
let clock = 0;
const sleep = async (/** @type {number} */ ms) => { clock += ms; };
const now = () => clock;

/**
 * @param {NormalisedModule[]} modules
 * @param {import('../scripts/ingest-core.mjs').IngestOptions} [options]
 */
const ingest = (modules, options = {}) => runIngest({
  modules, facetsBody, api: adminApi(() => fakes), options: { embeddingModel: MODEL, ...options }, sleep, now,
});

const rowCount = async () => Number(await env.DB.prepare('SELECT count(*) AS n FROM modules').first('n'));
const mutatingCalls = () => fakes.vectorize.calls.filter((c) => c.method === 'upsert' || c.method === 'deleteByIds');

beforeEach(async () => {
  clock = 0;
  fakes = await seed();
});

describe('guards: refuse before any write', () => {
  it('refuses a database without migration 0006, and /admin/hashes says what is missing', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => m.name < '0006'));
    fakes = createFakes();
    const result = await ingest(fixture.modules.slice(0, 10));
    expect(result.status).toBe('refused');
    expect(result.message).toMatch(/lacks migration 0006/);
    expect(result.message).toMatch(/46M rows/);
    expect(result.message).toContain("meta('schema') >= 6 (found none)");
    expect(result.message).toContain('external-content modules_fts');
    expect(result.message).toContain('FTS triggers keyed on rowid');
    expect(result.message).toContain('modules.row_hash');
    expect(fakes.ai.calls).toEqual([]);
    expect(fakes.vectorize.calls).toEqual([]);
    expect(await rowCount()).toBe(0);
  });

  it(`refuses when the schema marker is below ${REQUIRED_SCHEMA} even though the tables look right`, async () => {
    await env.DB.prepare("UPDATE meta SET value = '5' WHERE key = 'schema'").run();
    const result = await ingest(fixture.modules);
    expect(result).toMatchObject({ status: 'refused' });
    expect(result.message).toContain("meta('schema') >= 6 (found 5)");
    expect(mutatingCalls()).toEqual([]);
  });

  it('refuses a corpus below 95% of the D1 count unless allowMassDelete', async () => {
    const corpus = fixture.modules.slice(0, Math.floor(fixture.modules.length * 0.94));
    const refused = await ingest(corpus);
    expect(refused.status).toBe('refused');
    expect(refused.message).toMatch(/--allow-mass-delete/);
    expect(mutatingCalls()).toEqual([]);
    expect(await rowCount()).toBe(fixture.modules.length);

    const allowed = await ingest(corpus, { allowMassDelete: true });
    expect(allowed).toMatchObject({ status: 'done', deleted: fixture.modules.length - corpus.length });
    expect(await rowCount()).toBe(corpus.length);
    expect(fakes.vectorize.vectors.size).toBe(corpus.length);
  });

  it('allows exactly 95% without the flag', async () => {
    const corpus = fixture.modules.slice(0, Math.ceil(fixture.modules.length * 0.95));
    expect((await ingest(corpus)).status).toBe('done');
  });

  it('refuses a Worker embedding with another model than text_hash describes', async () => {
    const result = await runIngest({
      modules: fixture.modules, facetsBody, api: adminApi(() => fakes, { EMBEDDING_MODEL: '@cf/other/model' }),
      options: { embeddingModel: MODEL }, sleep, now,
    });
    expect(result.status).toBe('refused');
    expect(result.message).toContain('@cf/other/model');
    expect(mutatingCalls()).toEqual([]);
  });

  it('refuses a corpus that mixes acad years or repeats a code', async () => {
    const [a, b] = fixture.modules;
    expect((await ingest([...fixture.modules, { ...b, code: 'ZZ1000', acadYear: '2019-2020' }])).message).toMatch(/mixes acad years/);
    expect((await ingest([...fixture.modules, a])).message).toMatch(/Duplicate module codes.*/);
    expect(mutatingCalls()).toEqual([]);
  });
});

describe('deletes', () => {
  it('run only when no upsert batch failed', async () => {
    // A text change (new text_hash), so the batch needs Workers AI.
    const changed = fixture.modules
      .map((m, i) => (i === 0 ? { ...m, text: `${m.text} (revised)`, textHash: 'revised' } : m)).slice(0, -5);
    fakes.ai.throws('workers ai down');
    const result = await ingest(changed, { maxAttempts: 1 });
    expect(result).toMatchObject({ status: 'failed', failed: 1, deleted: 0, dataVersion: null });
    expect(fakes.vectorize.calls.filter((c) => c.method === 'deleteByIds')).toEqual([]);
    expect(await rowCount()).toBe(fixture.modules.length);

    fakes.ai.ok();
    const retry = await ingest(changed);
    expect(retry).toMatchObject({ status: 'done', upserted: 1, deleted: 5 });
  });
});

describe('row-only changes', () => {
  it('re-upsert the stored vector values with the new metadata; a missing vector is embedded after all', async () => {
    const [a, b] = fixture.modules;
    fakes.vectorize.vectors.delete(b.code);
    const result = await ingest(fixture.modules.map((m) => (m === a || m === b ? { ...m, credits: 99 } : m)));
    expect(result).toMatchObject({ status: 'done', plan: { embed: 0, rowOnly: 2 }, embedded: 1 });
    expect(fakes.ai.calls.flatMap((c) => /** @type {any} */ (c.args[1]).text)).toEqual([b.text]);
    expect(fakes.vectorize.vectors.get(a.code)?.metadata?.credits).toBe(99);
    expect(fakes.vectorize.vectors.get(b.code)?.metadata?.credits).toBe(99);
  });
});

describe('write budget', () => {
  it('stops cleanly before a batch would exceed it, never exceeds it, and a rerun resumes through the hash skip', async () => {
    // Every row changes (row-only), so the whole fixture must be rewritten.
    const next = fixture.modules.map((m) => ({ ...m, credits: (m.credits ?? 0) + 1 }));
    const budget = 1200;
    const first = await ingest(next, { writeBudget: budget, batchSize: 25, concurrency: 3 });
    expect(first.status).toBe('budget');
    expect(first.rowsWritten).toBeLessThanOrEqual(budget);
    expect(first.upserted).toBeGreaterThan(0);
    expect(first.upserted).toBeLessThan(next.length);
    expect(first.message).toMatch(/Stopped cleanly/);
    expect(first.message).toMatch(/rerun the same command/);
    expect(first.dataVersion).toBeNull();

    // Exactly the modules before resumeFrom were written.
    const done = next.filter((m) => m.code < /** @type {string} */ (first.resumeFrom));
    expect(done).toHaveLength(first.upserted);

    const second = await ingest(next);
    expect(second.status).toBe('done');
    expect(second.plan).toMatchObject({ rowOnly: next.length - first.upserted, unchanged: first.upserted });
    const { results } = await env.DB.prepare('SELECT code, credits FROM modules').all();
    const want = new Map(next.map((m) => [m.code, m.credits]));
    for (const r of results) expect(r.credits).toBe(want.get(String(r.code)));
  });

  it('a stopped forced run resumes with --from', async () => {
    const budget = 1000;
    const first = await ingest(fixture.modules, { force: true, writeBudget: budget, batchSize: 25 });
    expect(first.status).toBe('budget');
    expect(first.message).toContain(`--from ${first.resumeFrom}`);
    const second = await ingest(fixture.modules, { force: true, from: first.resumeFrom });
    expect(second.status).toBe('done');
    expect(first.upserted + second.upserted).toBe(fixture.modules.length);
  });
});

describe('Vectorize mutation wait', () => {
  it('reports done only once describe() has processed the last mutation, polling on that state', async () => {
    fakes.vectorize.processPerDescribe = 1;
    const corpus = fixture.modules.slice(0, -3).map((m, i) => (i < 120 ? { ...m, credits: 7 } : m));
    const result = await ingest(corpus, { batchSize: 50, waitIntervalMs: 2000 });
    expect(result.status).toBe('done');
    // The last mutation is the deletes (they run last), and the wait targeted it.
    expect(result.lastMutationId).toBe(fakes.vectorize.mutations.at(-1));
    expect(fakes.vectorize.calls.at(-1)?.method).toBe('describe');
    const describes = fakes.vectorize.calls.filter((c) => c.method === 'describe').length;
    expect(describes).toBe(fakes.vectorize.mutations.length);
    expect(clock).toBe((describes - 1) * 2000);
  });

  it('the last upsert batch runs alone, after the others, so the last mutation is well defined', async () => {
    const corpus = fixture.modules.map((m) => ({ ...m, credits: 99 }));
    const result = await ingest(corpus, { batchSize: 50, concurrency: 4 });
    const upserts = fakes.vectorize.calls.filter((c) => c.method === 'upsert');
    const last = /** @type {any[]} */ (upserts.at(-1)?.args[0]);
    const sorted = corpus.map((m) => m.code).sort();
    expect(last.map((v) => v.id)).toEqual(sorted.slice(-(sorted.length % 50 || 50)));
    expect(result.lastMutationId).toBe(fakes.vectorize.mutations.at(-1));
  });

  it('times out after a bounded number of polls, without writing the data version', async () => {
    fakes.vectorize.processPerDescribe = 0;
    const result = await ingest(fixture.modules.map((m) => ({ ...m, credits: 7 })), { waitTimeoutMs: 30_000, waitIntervalMs: 5_000 });
    expect(result).toMatchObject({ status: 'wait-timeout', dataVersion: null });
    // Polls at t = 0, 5, …, 30 s, then gives up rather than sleep past the deadline.
    expect(fakes.vectorize.calls.filter((c) => c.method === 'describe')).toHaveLength(7);
    expect(clock).toBeLessThanOrEqual(30_000);
  });

  it('does not wait when nothing was mutated', async () => {
    const result = await ingest(fixture.modules);
    expect(result).toMatchObject({ status: 'done', upserted: 0, lastMutationId: null });
    expect(fakes.vectorize.calls).toEqual([]);
  });
});

describe('data version', () => {
  it('is a hash of every ingested code and row hash: stable for the same data, new when a field changes', async () => {
    const same = await ingest(fixture.modules);
    const expected = await dataVersion(await Promise.all(fixture.modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
    expect(same.dataVersion).toBe(expected);
    expect(same.dataVersion).toMatch(/^[0-9a-f]{12}$/);
    const changed = await ingest(fixture.modules.map((m, i) => (i === 0 ? { ...m, semesters: [4] } : m)));
    expect(changed.dataVersion).not.toBe(same.dataVersion);
  });
});
