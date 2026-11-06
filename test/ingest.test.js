// @ts-check
// scripts/ingest-core.mjs runIngest against the real Worker routes, local D1
// and the fake Vectorize: the guards that stop a run before any write, the
// write budget and resuming through the hash skip, deletes only after a clean
// upsert phase, the Vectorize mutation wait, and the data version.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, REQUIRED_SCHEMA, runIngest } from '../scripts/ingest-core.mjs';
import { dataVersion, ftsHash, rowHash, sha256Hex } from '../src/rowhash.js';
import { createFakes, hashEmbed } from './fakes.js';
import { adminCall, fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

/** scripts/lib.mjs EMBEDDING_TEXT_VERSION (lib.mjs needs node:crypto, which workerd lacks here). */
const EMBEDDING_TEXT_VERSION = 2;

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
 * @param {{ pending?: import('../scripts/ingest-core.mjs').PendingMutationStore, db?: unknown }} [extra]
 */
const ingest = (modules, options = {}, extra = {}) => runIngest({
  modules, facetsBody, api: adminApi(() => fakes, extra.db ? { DB: extra.db } : {}), options: { embeddingModel: MODEL, ...options },
  sleep, now, ...(extra.pending ? { pending: extra.pending } : {}),
});

/** An in-memory stand-in for the CLI's .data/ingest-state.json. */
const memoryPending = () => {
  /** @type {import('../scripts/ingest-core.mjs').PendingMutation | null} */
  let p = null;
  return { read: async () => p, write: async (/** @type {import('../scripts/ingest-core.mjs').PendingMutation | null} */ next) => { p = next; } };
};

/** env.DB whose DELETE statements throw, everything else passed through. */
const deleteFailsDb = () => ({
  prepare: (/** @type {string} */ sql) => (/^\s*DELETE\b/i.test(sql)
    ? { bind: () => ({ all: async () => { throw new Error('d1: DELETE failed'); } }) }
    : env.DB.prepare(sql)),
  batch: (/** @type {D1PreparedStatement[]} */ stmts) => env.DB.batch(stmts),
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

  it('[PR13 #1a] refuses when the deletes exceed 5% of D1, even when the corpus is as large as D1', async () => {
    // Same size, entirely different codes: the count check alone passes this.
    const renamed = fixture.modules.map((m) => ({ ...m, code: `Q${m.code}` }));
    const refused = await ingest(renamed);
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain(`would delete ${fixture.modules.length} of the ${fixture.modules.length} modules D1 holds`);
    expect(refused.message).toMatch(/--allow-mass-delete/);
    expect(fakes.ai.calls).toEqual([]);
    expect(mutatingCalls()).toEqual([]);
    expect(await rowCount()).toBe(fixture.modules.length);
  });

  it('[PR13 #1b] refuses a corpus for another acad year than D1 holds unless allowYearChange; /admin/hashes reports the year', async () => {
    const hashes = await (await adminCall('/admin/hashes', fakes)).json();
    expect(/** @type {any} */ (hashes).acadYears).toEqual({ '2026-2027': fixture.modules.length });
    // 96% of the same codes: inside the mass-delete threshold.
    const otherYear = fixture.modules.slice(0, Math.ceil(fixture.modules.length * 0.96)).map((m) => ({ ...m, acadYear: '2019-2020' }));
    const refused = await ingest(otherYear);
    expect(refused.status).toBe('refused');
    expect(refused.message).toContain('2019-2020');
    expect(refused.message).toContain('2026-2027');
    expect(refused.message).toMatch(/--allow-year-change/);
    expect(fakes.ai.calls).toEqual([]);
    expect(mutatingCalls()).toEqual([]);

    const allowed = await ingest(otherYear, { allowYearChange: true });
    expect(allowed.status).toBe('done');
    const { results } = await env.DB.prepare('SELECT DISTINCT acad_year AS y FROM modules').all();
    expect(results).toEqual([{ y: '2019-2020' }]);
  });

  it('[PR13 #1b] the year D1 holds is its majority year: a corpus for it still cleans up a stray row of another year', async () => {
    const [x] = fixture.modules;
    await adminCall('/admin/ingest', fakes, { modules: [{ ...x, acadYear: '2019-2020' }] });
    expect(await ingest(fixture.modules)).toMatchObject({ status: 'done', plan: { rowOnly: 1 } });
    // ...but a corpus for the minority year is a year change.
    await adminCall('/admin/ingest', fakes, { modules: [{ ...x, acadYear: '2019-2020' }] });
    const otherYear = fixture.modules.map((m) => ({ ...m, acadYear: '2019-2020' }));
    expect((await ingest(otherYear)).message).toMatch(/2026-2027 \(399 rows\), 2019-2020 \(1 rows\).*--allow-year-change/);
  });

  it('[PR13 #1b] an empty database has no acad year, so any year loads', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    fakes = createFakes();
    const result = await ingest(fixture.modules.slice(0, 20).map((m) => ({ ...m, acadYear: '2019-2020' })));
    expect(result.status).toBe('done');
  });

  for (const trigger of ['modules_fts_insert', 'modules_fts_delete', 'modules_fts_update', 'modules_rowid_immutable']) {
    it(`[PR13 #4] refuses a database missing the 0006 trigger ${trigger}`, async () => {
      await env.DB.prepare(`DROP TRIGGER ${trigger}`).run();
      const result = await ingest(fixture.modules.map((m) => ({ ...m, credits: 99 })));
      expect(result.status).toBe('refused');
      expect(result.message).toContain(trigger);
      expect(mutatingCalls()).toEqual([]);
    });
  }

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

describe('[PR13 #5] a delete that fails halfway', () => {
  it('leaves the module re-embedded when it comes back: hashes are cleared before Vectorize deletes', async () => {
    const [x] = fixture.modules;
    const without = fixture.modules.filter((m) => m !== x);
    const failed = await ingest(without, { maxAttempts: 1 }, { db: deleteFailsDb() });
    expect(failed.status).toBe('failed');
    // Vectorize deleted it; D1 still has the row.
    expect(fakes.vectorize.vectors.has(x.code)).toBe(false);
    expect(await rowCount()).toBe(fixture.modules.length);

    const back = await ingest(fixture.modules);
    expect(back).toMatchObject({ status: 'done', plan: { embed: 1 }, embedded: 1 });
    expect(fakes.vectorize.vectors.get(x.code)?.values).toEqual(hashEmbed(x.text));
  });

  it('counts the hash-clearing writes: the response meta includes them and the charge covers the delete estimate', async () => {
    const gone = fixture.modules.slice(0, 10);
    const result = await ingest(fixture.modules.slice(10));
    expect(result).toMatchObject({ status: 'done', deleted: 10 });
    // Local D1: the UPDATE (1 per row) plus the DELETE (row + primary key).
    expect(result.rowsWritten).toBeGreaterThanOrEqual(3 * gone.length);
    expect(result.rowsCharged).toBe(Math.max(result.rowsWritten, gone.length * DEFAULTS.writesPerDelete));
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

describe('[PR13 #2] row-only changes against a lagging Vectorize', () => {
  it('re-embed when the stored vector is not for this text_hash, so an old embedding never overwrites a new one', async () => {
    const [x] = fixture.modules;
    fakes.vectorize.deferApply = true;
    fakes.vectorize.processPerDescribe = 0;
    // Run 1 re-embeds X and times out before Vectorize applies it.
    const revised = { ...x, text: `${x.text} Revised with quantum widgets.`, textHash: 'revised-text-hash' };
    const first = await ingest(fixture.modules.map((m) => (m === x ? revised : m)), { waitTimeoutMs: 0 });
    expect(first).toMatchObject({ status: 'wait-timeout', plan: { embed: 1 } });
    // Run 2 changes only X's row; getByIds still returns the old vector.
    const second = await ingest(fixture.modules.map((m) => (m === x ? { ...revised, credits: 99 } : m)), { waitTimeoutMs: 0 });
    expect(second.plan).toMatchObject({ embed: 0, rowOnly: 1 });
    expect(second.embedded).toBe(1);
    // Vectorize applies both, in order.
    fakes.vectorize.applyAll();
    const v = fakes.vectorize.vectors.get(x.code);
    expect(v?.values).toEqual(hashEmbed(revised.text));
    expect(v?.metadata).toMatchObject({ textHash: 'revised-text-hash', credits: 99 });
  });

  it('a vector with no textHash in its metadata (written before it was stored) is re-embedded, not reused', async () => {
    const [x, y] = fixture.modules;
    const vx = /** @type {import('./fakes.js').StoredVector} */ (fakes.vectorize.vectors.get(x.code));
    const legacy = { .../** @type {Record<string, unknown>} */ (vx.metadata) };
    delete legacy.textHash;
    vx.metadata = legacy;
    const result = await ingest(fixture.modules.map((m) => (m === x || m === y ? { ...m, credits: 99 } : m)));
    expect(result).toMatchObject({ status: 'done', plan: { rowOnly: 2 }, embedded: 1 });
    expect(fakes.ai.calls.flatMap((c) => /** @type {any} */ (c.args[1]).text)).toEqual([x.text]);
    expect(fakes.vectorize.vectors.get(x.code)?.metadata?.textHash).toBe(x.textHash);
  });

  it('stores textHash in the vector metadata but never in a metadata index', async () => {
    const [x] = fixture.modules;
    expect(fakes.vectorize.vectors.get(x.code)?.metadata?.textHash).toBe(x.textHash);
    expect(fakes.vectorize.indexedProperties).not.toContain('textHash');
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

describe('[PR13 #6b] the write budget charges FTS writes local D1 does not report', () => {
  const insertCost = (/** @type {number} */ n) => Math.ceil(n * (DEFAULTS.writesPerInsert + DEFAULTS.ftsWritesPerInsert));

  it('a cold load charges each batch the larger of meta.rows_written and the estimate with FTS inserts', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    fakes = createFakes();
    const result = await ingest(fixture.modules.slice(0, 100), { batchSize: 50 });
    expect(result.status).toBe('done');
    expect(result.rowsWritten).toBeLessThan(insertCost(100));
    expect(result.rowsCharged).toBe(2 * insertCost(50));
  });

  it('stops a cold load that meta.rows_written alone would let through', async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    fakes = createFakes();
    const result = await ingest(fixture.modules.slice(0, 100), { batchSize: 50, writeBudget: insertCost(50) + 10 });
    expect(result).toMatchObject({ status: 'budget', upserted: 50 });
    expect(result.rowsCharged).toBeLessThanOrEqual(insertCost(50) + 10);
  });

  it('a title change charges the FTS update estimate; a forced re-ingest of unchanged text charges none', async () => {
    const retitled = fixture.modules.map((m, i) => (i < 50 ? { ...m, title: `${m.title} II`, text: `${m.text} II`, textHash: `t${i}` } : m));
    const text = await ingest(retitled, { batchSize: 50 });
    expect(text.rowsCharged).toBe(Math.max(text.rowsWritten, Math.ceil(50 * (DEFAULTS.writesPerUpdate + DEFAULTS.ftsWritesPerTextChange))));

    const forced = await ingest(retitled, { force: true, batchSize: 50 });
    expect(forced.status).toBe('done');
    expect(forced.rowsCharged).toBeGreaterThanOrEqual(forced.rowsWritten);
    expect(forced.rowsCharged).toBeLessThanOrEqual(8 * Math.ceil(50 * DEFAULTS.writesPerUpdate) + forced.rowsWritten);
    expect(forced.rowsCharged).toBeLessThan(fixture.modules.length * (DEFAULTS.writesPerUpdate + 1));
  });
});

describe('[PR13 #3] an unconfirmed mutation outlives the run that sent it', () => {
  it('a rerun that sends nothing waits for it, and reports done only once Vectorize has processed it', async () => {
    const pending = memoryPending();
    fakes.vectorize.processPerDescribe = 0;
    const changed = fixture.modules.map((m, i) => (i === 0 ? { ...m, credits: 42 } : m));
    const first = await ingest(changed, { waitTimeoutMs: 10_000 }, { pending });
    expect(first.status).toBe('wait-timeout');
    expect((await pending.read())?.id).toBe(first.lastMutationId);

    const second = await ingest(changed, { waitTimeoutMs: 10_000 }, { pending });
    expect(second).toMatchObject({ status: 'wait-timeout', upserted: 0, dataVersion: null, lastMutationId: first.lastMutationId });
    expect((await pending.read())?.id).toBe(first.lastMutationId);

    fakes.vectorize.processPerDescribe = Infinity;
    const third = await ingest(changed, {}, { pending });
    expect(third).toMatchObject({ status: 'done', upserted: 0 });
    expect(third.dataVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(await pending.read()).toBeNull();
  });

  it('is recorded as soon as it is sent, so a run stopped by the budget leaves it pending too', async () => {
    const pending = memoryPending();
    const next = fixture.modules.map((m) => ({ ...m, credits: (m.credits ?? 0) + 1 }));
    const first = await ingest(next, { writeBudget: 1000, batchSize: 25, concurrency: 1 }, { pending });
    expect(first.status).toBe('budget');
    expect((await pending.read())?.id).toBe(fakes.vectorize.mutations.at(-1));
  });
});

describe('[PR13b #1] the FTS charge follows the columns the 0006 FTS triggers watch', () => {
  it('/admin/hashes reports ftsHash of the stored code, title and description', async () => {
    const [x] = fixture.modules;
    const body = /** @type {any} */ (await (await adminCall('/admin/hashes', fakes)).json());
    expect(body.modules[x.code].ftsHash).toBe(await ftsHash(x));
    await env.DB.prepare('UPDATE modules SET description = ? WHERE code = ?').bind(`${x.description} More.`, x.code).run();
    const after = /** @type {any} */ (await (await adminCall('/admin/hashes', fakes)).json());
    expect(after.modules[x.code].ftsHash).toBe(await ftsHash({ ...x, description: `${x.description} More.` }));
  });

  it('a forced run against production-format text_hash (main\'s hashOf(text)) is charged the same-text rate, and writes no FTS row', async () => {
    // The fixture was built with main's text_hash (hashOf(text)), so the seeded
    // D1 holds what production does after 0006 (plus row_hash NULL); the corpus
    // carries this PR's text_hash, hash(model + text version + text).
    expect(fixture.modules[0].textHash).toBe((await sha256Hex(fixture.modules[0].text)).slice(0, 32));
    await env.DB.prepare('UPDATE modules SET row_hash = NULL').run();
    const corpus = await Promise.all(fixture.modules.map(async (m) =>
      ({ ...m, textHash: (await sha256Hex(JSON.stringify([MODEL, EMBEDDING_TEXT_VERSION, m.text]))).slice(0, 32) })));
    const ftsRows = async () => String(await env.DB.prepare(
      'SELECT (SELECT group_concat(id || hex(block)) FROM modules_fts_data) || (SELECT group_concat(id || hex(sz)) FROM modules_fts_docsize) AS s').first('s'));
    const before = await ftsRows();
    const result = await ingest(corpus, { force: true, batchSize: 50 });
    expect(result).toMatchObject({ status: 'done', upserted: fixture.modules.length });
    const n = fixture.modules.length;
    const sameText = Math.floor(n / 50) * Math.ceil(50 * DEFAULTS.writesPerUpdate) + (n % 50 ? Math.ceil((n % 50) * DEFAULTS.writesPerUpdate) : 0);
    expect(result.rowsCharged).toBeGreaterThanOrEqual(sameText);
    expect(result.rowsCharged).toBeLessThan(n * (DEFAULTS.writesPerUpdate + 1));
    // ...because the FTS update trigger did not fire: the shadow tables are byte-identical.
    expect(await ftsRows()).toBe(before);
  });
});

describe('[PR13b #2] a pending mutation Vectorize has moved past', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('ingest and delete responses carry the Worker\'s Date.now() at the Vectorize call', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T10:00:00.000Z'));
    const [x] = fixture.modules;
    const ing = /** @type {any} */ (await (await adminCall('/admin/ingest', fakes, { modules: [x] })).json());
    expect(ing.sentAt).toBe(Date.parse('2026-11-04T10:00:00.000Z'));
    const del = /** @type {any} */ (await (await adminCall('/admin/delete', fakes, { codes: [x.code] })).json());
    expect(del.sentAt).toBe(Date.parse('2026-11-04T10:00:00.000Z'));
  });

  it('a no-op rerun is satisfied once Vectorize has processed a later mutation sent another way, and writes the data version', async () => {
    let t = Date.parse('2026-11-04T10:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => t);
    const pending = memoryPending();
    fakes.vectorize.processPerDescribe = 0;
    const changed = fixture.modules.map((m, i) => (i === 0 ? { ...m, credits: 42 } : m));
    const first = await ingest(changed, { waitTimeoutMs: 0 }, { pending });
    expect(first.status).toBe('wait-timeout');
    expect(await pending.read()).toMatchObject({ id: first.lastMutationId, sentAt: t });

    // Another client (another --url to the same Worker and index) mutates later.
    t += 60_000;
    await adminCall('/admin/ingest', fakes, { modules: [fixture.modules[1]] });
    fakes.vectorize.processPerDescribe = Infinity;
    const second = await ingest(changed, { waitTimeoutMs: 10_000 }, { pending });
    expect(second).toMatchObject({ status: 'done', upserted: 0 });
    expect(second.dataVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(await pending.read()).toBeNull();
  });
});
