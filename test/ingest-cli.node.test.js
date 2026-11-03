// @ts-check
// scripts/ingest.mjs, the CLI around scripts/ingest-core.mjs: flags and their
// defaults, exit codes, and src/data-version.json written only after a run
// that finished. The Worker is a stub fetch; the corpus is three records in a
// temporary cache directory, so nothing reaches api.nusmods.com or Cloudflare.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { DATA_VERSION_PATH, acquireRunLock, dataVersionFile, fileStateStore, main, parseDuration, parseIngestArgs, releaseOnSignal } from '../scripts/ingest.mjs';
import { DEFAULTS } from '../scripts/ingest-core.mjs';
import { offeredModules } from '../scripts/lib.mjs';
import { dataVersion, rowHash } from '../src/rowhash.js';

const Y = '2026-2027';
const records = ['AA1001', 'AA1002', 'AA1003'].map((code, i) => ({
  moduleCode: code, title: `Title ${i}`, description: `Description ${i}.`, moduleCredit: '4',
  department: 'D', faculty: 'F', semesterData: [{ semester: 1 }],
}));

/**
 * A stub Worker: an empty 0006 database (or one without 0006), whose
 * /admin/ingest reports `writesPerModule` rows written per module.
 * @param {{ schemaOk?: boolean, writesPerModule?: number }} [o]
 */
function stubWorker({ schemaOk = true, writesPerModule = 5 } = {}) {
  /** @type {string[]} */
  const paths = [];
  let mutation = 0;
  /** Whether describe() reports the latest mutation processed (false: Vectorize lags). */
  const vectorize = { processed: true };
  /** What the stub's D1 holds, from what /admin/ingest was sent: code -> hashes. */
  /** @type {Map<string, { textHash: string, rowHash: string }>} */
  const stored = new Map();
  /** @type {typeof fetch} */
  const fetchImpl = async (input, init) => {
    const url = new URL(String(input));
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.hostname === 'api.nusmods.com') throw new Error('network is banned in tests');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    /** @param {unknown} b */
    const ok = (b) => new Response(JSON.stringify(b), { status: 200 });
    switch (url.pathname) {
      case '/admin/hashes':
        return ok({ schema: { version: schemaOk ? 6 : null, ftsExternal: schemaOk, rowidTriggers: schemaOk, rowHashColumn: schemaOk, ok: schemaOk },
          embeddingModel: '@cf/baai/bge-small-en-v1.5', modules: schemaOk ? Object.fromEntries(stored) : null,
          acadYears: stored.size ? { [Y]: stored.size } : {} });
      case '/admin/ingest':
        mutation++;
        for (const m of body.modules) stored.set(m.code, { textHash: m.textHash, rowHash: m.rowHash });
        return ok({ upserted: body.modules.length, embedded: body.modules.length, mutationId: `m${mutation}`, sentAt: Date.now(),
          meta: { rows_read: body.modules.length, rows_written: writesPerModule * body.modules.length } });
      case '/admin/facets': return ok({ faculties: 1, levels: 1, ng: 0, ngListUpdatedAsAt: null });
      case '/admin/vectorize': return ok({ vectorCount: 3, processedUpToMutation: vectorize.processed ? `m${mutation}` : null, processedUpToDatetime: null });
      default: return new Response('{}', { status: 404 });
    }
  };
  return { fetchImpl, paths, vectorize };
}

/** @type {string} */
let dir;
/** @type {URL} */
let cacheDir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vnm-ingest-'));
  cacheDir = new URL(`file://${dir}/`);
  const body = JSON.stringify(records);
  await writeFile(join(dir, `${Y}-moduleInfo.json`), body);
  await writeFile(join(dir, `${Y}-moduleInfo.json.cache.json`), JSON.stringify({
    url: 'x', etag: null, lastModified: null, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex'),
  }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** @param {string[]} argv @param {ReturnType<typeof stubWorker>} worker @param {{ statePath?: string }} [o] */
const run = async (argv, worker, o = {}) => {
  /** @type {string[]} */
  const lines = [];
  const dataVersionPath = join(dir, 'data-version.json');
  const code = await main(['--year', Y, '--url', 'http://worker.test', ...argv], {
    fetchImpl: worker.fetchImpl, log: (l) => lines.push(l), dataVersionPath, cacheDir, envVars: { INGEST_SECRET: 's' },
    statePath: o.statePath ?? join(dir, 'ingest-state.json'),
  });
  const written = await readFile(dataVersionPath, 'utf8').catch(() => null);
  return { code, lines, written };
};
const state = async () => JSON.parse(await readFile(join(dir, 'ingest-state.json'), 'utf8').catch(() => '{}'));

describe('scripts/ingest.mjs', () => {
  it('defaults: write budget 40,000 (ADR 0002), cache max age 24 h, batches of 50', () => {
    const a = parseIngestArgs([], {});
    expect(a.options).toMatchObject({ writeBudget: 40_000, batchSize: 50, concurrency: 4, force: false, allowMassDelete: false });
    expect(a.maxAgeMs).toBe(24 * 3_600_000);
    expect(a.offline).toBe(false);
    expect(parseIngestArgs(['--offline', '--max-age', '30m', '--write-budget', '500', '--allow-mass-delete'], {}))
      .toMatchObject({ offline: true, maxAgeMs: 1_800_000, options: { writeBudget: 500, allowMassDelete: true } });
    expect(parseDuration('2d')).toBe(172_800_000);
    expect(parseDuration('12')).toBe(43_200_000);
    expect(() => parseIngestArgs(['--batch', '101'], {})).toThrow(/at most 100/);
    expect(() => parseIngestArgs(['--wat'], {})).toThrow();
  });

  it('[PR13 #1b] --allow-year-change is off unless passed', () => {
    expect(parseIngestArgs([], {}).options.allowYearChange).toBe(false);
    expect(parseIngestArgs(['--allow-year-change'], {}).options.allowYearChange).toBe(true);
  });

  it('[PR13 #3] keeps an unconfirmed mutation id in the state file; a rerun that sends nothing waits for it before writing data-version.json', async () => {
    const worker = stubWorker();
    worker.vectorize.processed = false;
    const first = await run(['--wait-timeout', '0s'], worker);
    expect(first.code).toBe(3);
    expect(first.written).toBeNull();
    expect(await state()).toEqual({ 'http://worker.test': { pendingMutationId: 'm1', sentAt: expect.any(Number), earlier: [] } });

    // The rerun has nothing to send (the stub's D1 now holds every hash), but m1 is still unconfirmed.
    const second = await run(['--wait-timeout', '0s'], worker);
    expect(second.code).toBe(3);
    expect(second.written).toBeNull();
    expect(second.lines.join('\n')).toMatch(/0 to embed, 0 row-only, 3 unchanged/);

    worker.vectorize.processed = true;
    const third = await run([], worker);
    expect(third.code).toBe(0);
    expect(third.written).not.toBeNull();
    expect(await state()).toEqual({});
  });

  it('writes src/data-version.json (the default target) only after a finished run, from the ingested rows', async () => {
    expect(DATA_VERSION_PATH).toMatch(/src\/data-version\.json$/);
    const worker = stubWorker();
    const { code, written, lines } = await run([], worker);
    expect(code).toBe(0);
    const modules = offeredModules(records, Y, null).modules;
    // offeredModules(…, null) has no NG list; the CLI loads data/ng-courses, which lists none of these codes.
    const expected = await dataVersion(await Promise.all(modules.map(async (m) => ({ code: m.code, rowHash: await rowHash(m) }))));
    expect(written).toBe(dataVersionFile(expected));
    expect(lines.join('\n')).toMatch(/commit src\/data-version\.json, then npm run deploy/);
    // Revalidation was not needed: the cache entry is fresh.
    expect(worker.paths.some((p) => p.includes('nusmods'))).toBe(false);
  });

  it('refuses a database without 0006 with exit 1 and a clear message, writing nothing', async () => {
    const worker = stubWorker({ schemaOk: false });
    const { code, written, lines } = await run([], worker);
    expect(code).toBe(1);
    expect(written).toBeNull();
    expect(lines.join('\n')).toMatch(/Refusing to ingest: the target database lacks migration 0006/);
    expect(worker.paths).toEqual(['GET /admin/hashes']);
  });

  it('exits 2 when the write budget stops the run, and says how to resume', async () => {
    // Each cold insert is charged its estimate, 8 + 14 FTS = 22 rows, not the 6 the stub's D1 reports.
    const perInsert = DEFAULTS.writesPerInsert + DEFAULTS.ftsWritesPerInsert;
    const budget = String(2 * perInsert + 5);
    const { code, written, lines } = await run(['--write-budget', budget, '--batch', '1', '--concurrency', '1'], stubWorker({ writesPerModule: 6 }));
    expect(code).toBe(2);
    expect(written).toBeNull();
    expect(lines.join('\n')).toMatch(/Stopped cleanly: 2 of 3 modules upserted/);
    expect(lines.join('\n')).toContain(`rows written       12 reported by D1; ${2 * perInsert} charged to the budget`);
  });

  it('[PR13b #3] state writes from two stores at once never fail on a shared tmp file, and leave none behind', async () => {
    const path = join(dir, 'ingest-state.json');
    const stores = ['http://a.test', 'http://b.test'].map((base) => fileStateStore(path, base));
    // Concurrent read-modify-writes may still overwrite each other (the run lock
    // keeps two ingests apart); what must not happen is a write failing.
    await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % 2].write({ id: `m${i}`, sentAt: i })));
    expect(Object.keys(await state()).length).toBeGreaterThan(0);
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    await stores[0].write({ id: 'a', sentAt: 1 });
    await stores[1].write({ id: 'b', sentAt: null });
    expect(await stores[0].read()).toEqual({ id: 'a', sentAt: 1, earlier: [] });
    expect(await stores[1].read()).toEqual({ id: 'b', sentAt: null, earlier: [] });
    await stores[0].write({ id: 'c', sentAt: 2, earlier: ['a'] });
    expect(await stores[0].read()).toEqual({ id: 'c', sentAt: 2, earlier: ['a'] });
  });

  it('[PR13b #3] refuses to start while another ingest holds the run lock, naming the lock file and how to clear a stale one', async () => {
    const lock = join(dir, 'ingest-state.json.lock');
    await writeFile(lock, JSON.stringify({ pid: 999999, startedAt: '2026-11-04T10:00:00.000Z' }));
    const worker = stubWorker();
    const { code, written, lines } = await run([], worker);
    expect(code).toBe(1);
    expect(written).toBeNull();
    expect(worker.paths).toEqual([]);
    const out = lines.join('\n');
    expect(out).toContain(lock);
    expect(out).toContain('pid 999999');
    expect(out).toMatch(/no ingest is running.*delete/i);
    // The lock is the other run's: left alone.
    expect(await readFile(lock, 'utf8')).toContain('999999');
  });

  it('[PR13b #3] of two ingests started at once, one runs and the other is refused; the lock is released after', async () => {
    const [a, b] = await Promise.all([run([], stubWorker()), run([], stubWorker())]);
    expect([a.code, b.code].sort()).toEqual([0, 1]);
    expect([a, b].find((r) => r.code === 1)?.lines.join('\n')).toMatch(/Another ingest holds/);
    expect((await readdir(dir)).filter((f) => f.endsWith('.lock'))).toEqual([]);
    expect((await run([], stubWorker())).code).toBe(0);
  });

  it('[PR13c #2] release removes only this run\'s lock, not one another run took after it was deleted by hand', async () => {
    const statePath = join(dir, 'ingest-state.json');
    const lock = await acquireRunLock(statePath, 'http://a.test');
    if (!('release' in lock)) throw new Error('not acquired');
    await writeFile(`${statePath}.lock`, JSON.stringify({ pid: 4242, nonce: 'someone-else' }));
    await lock.release();
    expect(await readFile(`${statePath}.lock`, 'utf8')).toContain('someone-else');
  });

  it('[PR13c #2] SIGINT or SIGTERM releases the lock and exits 130 or 143, so the next run is not refused', async () => {
    for (const [signal, want] of /** @type {const} */ ([['SIGINT', 130], ['SIGTERM', 143]])) {
      const statePath = join(dir, `state-${signal}.json`);
      const lock = await acquireRunLock(statePath, 'http://a.test');
      if (!('release' in lock)) throw new Error('not acquired');
      /** @type {number[]} */
      const exits = [];
      const proc = Object.assign(new EventEmitter(), { exit: (/** @type {number} */ c) => { exits.push(c); } });
      const off = releaseOnSignal(lock, /** @type {any} */ (proc));
      proc.emit(signal);
      expect(exits).toEqual([want]);
      expect((await readdir(dir)).filter((f) => f === `state-${signal}.json.lock`)).toEqual([]);
      off();
      expect(proc.listenerCount('SIGINT') + proc.listenerCount('SIGTERM')).toBe(0);
    }
  });

  it('[PR13b #3] a state file that cannot be written does not crash the run: exit 1, no data version, the unrecorded ids named', async () => {
    const statePath = join(dir, 'state-is-a-directory');
    await mkdir(statePath);
    const worker = stubWorker();
    const { code, written, lines } = await run([], worker, { statePath });
    expect(code).toBe(1);
    expect(written).toBeNull();
    expect(worker.paths).toContain('POST /admin/ingest');
    expect(worker.paths).toContain('POST /admin/facets');
    expect(lines.join('\n')).toMatch(/could not record.*m1/i);
    expect((await readdir(dir)).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });
});
