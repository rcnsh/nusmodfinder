// @ts-check
// scripts/ingest-core.mjs runIngest against a stub admin API, at the size of
// the production corpus (6,771 modules): the write budget's FTS charge for the
// production starting state, the Vectorize mutation wait once Vectorize has
// moved past the pending mutation, and a pending-store write that fails
// mid-run. Plain Node, no Worker, nothing remote.
import { describe, expect, it } from 'vitest';
import { DEFAULTS, runIngest, waitForMutation } from '../scripts/ingest-core.mjs';
import { hashOf, offeredModules } from '../scripts/lib.mjs';
import { ftsHash } from '../src/rowhash.js';

const Y = '2026-2027';
/** The production corpus size (release data-2026-2027-20260904). */
const N = 6771;
const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };

/** @param {number} n */
const corpus = (n) => offeredModules(Array.from({ length: n }, (_, i) => ({
  moduleCode: `AA${String(1000 + i).padStart(4, '0')}`, title: `Title ${i}`,
  description: `Description of module ${i}, long enough to look like one.`, moduleCredit: '4',
  department: 'D', faculty: 'F', semesterData: [{ semester: 1 }],
})), Y, null).modules;

/**
 * A stub Worker over `stored` (code -> hashes as /admin/hashes reports them),
 * whose D1 reports `rowsPerModule` rows written per upserted module.
 * @param {Record<string, { textHash: string, rowHash: string | null, ftsHash?: string }>} stored
 * @param {{ rowsPerModule?: number }} [o]
 * @returns {import('../scripts/ingest-core.mjs').AdminApi & { mutations: string[] }}
 */
function stubApi(stored, { rowsPerModule = 5.08 } = {}) {
  /** @type {string[]} */
  const mutations = [];
  let t = 1_000_000;
  return {
    mutations,
    get: async (path) => {
      if (path === '/admin/hashes') {
        return { status: 200, body: {
          schema: { version: 6, ftsExternal: true, rowidTriggers: true, missingTriggers: [], rowHashColumn: true, ok: true },
          embeddingModel: '@cf/baai/bge-small-en-v1.5', acadYears: { [Y]: Object.keys(stored).length }, modules: stored,
        } };
      }
      if (path === '/admin/vectorize') {
        return { status: 200, body: { vectorCount: N, processedUpToMutation: mutations.at(-1) ?? null, processedUpToDatetime: null } };
      }
      return { status: 404, body: {} };
    },
    post: async (path, body) => {
      const b = /** @type {any} */ (body);
      if (path === '/admin/ingest') {
        mutations.push(`m${mutations.length + 1}`);
        return { status: 200, body: { upserted: b.modules.length, embedded: b.modules.length, mutationId: mutations.at(-1), sentAt: t++,
          meta: { rows_read: b.modules.length, rows_written: Math.round(rowsPerModule * b.modules.length) } } };
      }
      if (path === '/admin/facets') return { status: 200, body: { faculties: 1, levels: 1, ng: 0, ngListUpdatedAsAt: null } };
      return { status: 404, body: {} };
    },
  };
}

/**
 * What production D1 holds after migration 0006: main's text_hash
 * (`hashOf(text)`, before the model and text version were hashed in), no
 * row_hash, and the stored title/description the corpus still has.
 * @param {NormalisedModule[]} modules
 */
const productionHashes = async (modules) => Object.fromEntries(await Promise.all(modules.map(async (m) =>
  [m.code, { textHash: hashOf(m.text), rowHash: null, ftsHash: await ftsHash(m) }])));

describe('[PR13b #1] the FTS write charge follows what the 0006 FTS triggers watch', () => {
  it('a forced run from the production starting state (main\'s text_hash, unchanged title/description) finishes in one run under the 40k default', async () => {
    const modules = corpus(N);
    const stored = await productionHashes(modules);
    expect(modules[0].textHash).not.toBe(stored[modules[0].code].textHash);
    const api = stubApi(stored);
    const result = await runIngest({ modules, facetsBody, api, options: { force: true }, sleep: async () => {} });
    expect(result).toMatchObject({ status: 'done', upserted: N, resumeFrom: null });
    // Every row is a same-FTS-text rewrite: 5.5 per module, charged per batch of 50.
    const full = Math.floor(N / 50);
    expect(result.rowsCharged).toBe(full * Math.ceil(50 * DEFAULTS.writesPerUpdate) + Math.ceil((N % 50) * DEFAULTS.writesPerUpdate));
    expect(result.rowsCharged).toBeLessThanOrEqual(DEFAULTS.writeBudget);
  });

  it('the unforced run from the same state re-embeds everything (text_hash differs) at the same charge', async () => {
    const modules = corpus(N);
    const result = await runIngest({ modules, facetsBody, api: stubApi(await productionHashes(modules)), sleep: async () => {} });
    expect(result).toMatchObject({ status: 'done', upserted: N, plan: { embed: N } });
    expect(result.rowsCharged).toBeLessThanOrEqual(DEFAULTS.writeBudget);
  });

  it('a changed title or description is still charged the FTS update; a Worker without ftsHash falls back to text_hash', async () => {
    const modules = corpus(100);
    const stored = await productionHashes(modules);
    stored[modules[0].code].ftsHash = 'something else';
    const text = DEFAULTS.writesPerUpdate + DEFAULTS.ftsWritesPerTextChange;
    const one = await runIngest({ modules, facetsBody, api: stubApi(stored), options: { force: true, batchSize: 100 }, sleep: async () => {} });
    expect(one.rowsCharged).toBe(Math.ceil(99 * DEFAULTS.writesPerUpdate + text));

    const old = Object.fromEntries(Object.entries(stored).map(([c, { textHash, rowHash }]) => [c, { textHash, rowHash }]));
    const fallback = await runIngest({ modules, facetsBody, api: stubApi(old), options: { force: true, batchSize: 100 }, sleep: async () => {} });
    expect(fallback.rowsCharged).toBe(Math.ceil(100 * text));
  });
});

describe('[PR13b #2] the mutation wait once Vectorize has processed a later mutation', () => {
  /** @param {{ processedUpToMutation: unknown, processedUpToDatetime: unknown }} info */
  const api = (info) => /** @type {import('../scripts/ingest-core.mjs').AdminApi} */ ({
    get: async () => ({ status: 200, body: { vectorCount: 1, ...info } }), post: async () => ({ status: 404, body: {} }),
  });
  /** A fake clock the sleep advances, so a wait that is never satisfied times out. */
  const opts = () => {
    let t = 0;
    return { timeoutMs: 10_000, intervalMs: 5_000, sleep: async (/** @type {number} */ ms) => { t += ms; }, now: () => t, log: () => {} };
  };
  const sentAt = Date.parse('2026-11-04T10:00:00.000Z');

  it('is satisfied by processedUpToDatetime past sentAt, as an ISO string or a number', async () => {
    expect(await waitForMutation(api({ processedUpToMutation: 'later', processedUpToDatetime: '2026-11-04T10:00:00.001Z' }), { id: 'mine', sentAt }, opts())).toBe(true);
    expect(await waitForMutation(api({ processedUpToMutation: 'later', processedUpToDatetime: sentAt + 1 }), { id: 'mine', sentAt }, opts())).toBe(true);
  });

  it('is not satisfied by an older mutation, nor one stamped in the same millisecond as sentAt', async () => {
    expect(await waitForMutation(api({ processedUpToMutation: 'older', processedUpToDatetime: '2026-11-04T09:59:59.000Z' }), { id: 'mine', sentAt }, opts())).toBe(false);
    expect(await waitForMutation(api({ processedUpToMutation: 'older', processedUpToDatetime: '2026-11-04T10:00:00.000Z' }), { id: 'mine', sentAt }, opts())).toBe(false);
    expect(await waitForMutation(api({ processedUpToMutation: 'older', processedUpToDatetime: null }), { id: 'mine', sentAt }, opts())).toBe(false);
  });

  it('without a sentAt (a Worker older than this script) only the exact id satisfies it', async () => {
    expect(await waitForMutation(api({ processedUpToMutation: 'later', processedUpToDatetime: sentAt + 1 }), { id: 'mine', sentAt: null }, opts())).toBe(false);
    expect(await waitForMutation(api({ processedUpToMutation: 'mine', processedUpToDatetime: null }), { id: 'mine', sentAt: null }, opts())).toBe(true);
  });
});

describe('[PR13c #1] the time check never counts a mutation of this run, or of the pending one, as later', () => {
  /** @param {{ processedUpToMutation: unknown, processedUpToDatetime: unknown }} info */
  const api = (info) => /** @type {import('../scripts/ingest-core.mjs').AdminApi} */ ({
    get: async () => ({ status: 200, body: { vectorCount: 1, ...info } }), post: async () => ({ status: 404, body: {} }),
  });
  const opts = () => {
    let t = 0;
    return { timeoutMs: 10_000, intervalMs: 5_000, sleep: async (/** @type {number} */ ms) => { t += ms; }, now: () => t, log: () => {} };
  };
  const sentAt = Date.parse('2026-11-04T10:00:00.400Z');

  it('an earlier mutation of the same run stamped after sentAt is not proof; a foreign one is', async () => {
    const target = { id: 'B', sentAt, earlier: ['A'] };
    expect(await waitForMutation(api({ processedUpToMutation: 'A', processedUpToDatetime: sentAt + 50 }), target, opts())).toBe(false);
    expect(await waitForMutation(api({ processedUpToMutation: 'X', processedUpToDatetime: sentAt + 50 }), target, opts())).toBe(true);
    expect(await waitForMutation(api({ processedUpToMutation: 'B', processedUpToDatetime: null }), target, opts())).toBe(true);
  });

  it('a run whose last batch is still queued behind its first ends wait-timeout, not done', async () => {
    const modules = corpus(100);
    const base = stubApi(await productionHashes(modules));
    /** @type {number[]} */
    const stamps = [];
    const api = {
      ...base,
      post: async (/** @type {string} */ path, /** @type {unknown} */ body) => {
        const res = await base.post(path, body);
        if (path === '/admin/ingest') stamps.push(/** @type {any} */ (res.body).sentAt);
        return res;
      },
      get: async (/** @type {string} */ path) => (path === '/admin/vectorize'
        ? { status: 200, body: { vectorCount: N, processedUpToMutation: 'm1', processedUpToDatetime: /** @type {number} */ (stamps.at(-1)) + 50 } }
        : base.get(path)),
    };
    let t = 0;
    const result = await runIngest({ modules, facetsBody, api, options: { batchSize: 50, concurrency: 1, waitTimeoutMs: 10_000, waitIntervalMs: 5_000 },
      sleep: async (ms) => { t += ms; }, now: () => t });
    expect(base.mutations).toEqual(['m1', 'm2']);
    expect(result).toMatchObject({ status: 'wait-timeout', lastMutationId: 'm2', dataVersion: null });
  });

  it('the pending store records the earlier ids of the run, carrying over those of a pending mutation left by an earlier run', async () => {
    const modules = corpus(100);
    /** @type {(import('../scripts/ingest-core.mjs').PendingMutation | null)[]} */
    const writes = [];
    const pending = {
      read: async () => ({ id: 'old2', sentAt: 5, earlier: ['old1'] }),
      write: async (/** @type {any} */ p) => { writes.push(p); },
    };
    await runIngest({ modules, facetsBody, api: stubApi(await productionHashes(modules)), pending,
      options: { batchSize: 50, concurrency: 1 }, sleep: async () => {} });
    const recorded = writes.filter(Boolean);
    expect(recorded.map((p) => p?.id)).toEqual(['m1', 'm2']);
    expect(recorded[0]?.earlier).toEqual(['old1', 'old2']);
    expect(recorded[1]?.earlier).toEqual(['old1', 'old2', 'm1']);
  });
});

describe('[PR13b #3] a pending-store write that fails mid-run', () => {
  it('does not kill the run: every batch is still sent, and it ends failed, naming the unrecorded mutation ids', async () => {
    const modules = corpus(200);
    const api = stubApi(await productionHashes(modules));
    let writes = 0;
    /** @type {import('../scripts/ingest-core.mjs').PendingMutationStore} */
    const pending = {
      read: async () => null,
      write: async (p) => { writes++; if (p && p.id !== 'm1') throw new Error('EACCES: permission denied, open state.json'); },
    };
    const result = await runIngest({ modules, facetsBody, api, pending, options: { batchSize: 50, concurrency: 1 }, sleep: async () => {} });
    expect(api.mutations).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(result).toMatchObject({ status: 'failed', upserted: 200, dataVersion: null });
    expect(result.message).toContain('m2, m3, m4');
    expect(result.message).toContain('EACCES');
    expect(writes).toBe(4);
  });
});
