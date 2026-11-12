// @ts-check
// Phase 7 7C: no default URL. ingest, verify and `vectors standby` refuse to
// run without --url or WORKER_URL, and refuse ports 8787 and 8799 (another
// project's on the dev Mac), before any request. Each writer that does run
// leaves one run record on success and one on failure. The Worker is a stub
// fetch; records go to a temp dir.
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main as ingestMain } from '../scripts/ingest.mjs';
import { workerUrl } from '../scripts/remote-session.mjs';
import { main as vectorsMain } from '../scripts/vectors.mjs';
import { main as verifyMain } from '../scripts/verify.mjs';

/** @type {string} */
let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vnm-url-')); seen = new Set(); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** A fetch that fails the test if it is ever called. */
const noFetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (/** @type {string} */ url) => { throw new Error(`no request may be sent, got ${url}`); }));
/** Files already returned, so records come back in the order they were written, not by name. @type {Set<string>} */
let seen = new Set();
/** The records written since the last call, in that order (one run each, so at most one per call here). */
const fresh = async () => {
  const files = (await readdir(join(dir, 'runs')).catch(() => /** @type {string[]} */ ([]))).filter((f) => !seen.has(f));
  for (const f of files) seen.add(f);
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, 'runs', f), 'utf8'))));
};
/** Every record so far. */
const records = async () => {
  const files = await readdir(join(dir, 'runs')).catch(() => /** @type {string[]} */ ([]));
  return Promise.all(files.map(async (f) => JSON.parse(await readFile(join(dir, 'runs', f), 'utf8'))));
};

describe('workerUrl', () => {
  it('takes --url, else WORKER_URL, strips a trailing slash, and has no default', () => {
    expect(workerUrl('http://127.0.0.1:51234/', {})).toEqual({ base: 'http://127.0.0.1:51234' });
    expect(workerUrl(undefined, { WORKER_URL: 'http://127.0.0.1:51235' })).toEqual({ base: 'http://127.0.0.1:51235' });
    expect(workerUrl(undefined, {})).toEqual({ error: expect.stringMatching(/no --url and no WORKER_URL.*npm run remote/) });
  });

  it('refuses ports 8787 and 8799, and a URL that does not parse', () => {
    for (const url of ['http://localhost:8787', 'http://127.0.0.1:8799/', 'http://[::1]:8787']) {
      expect(workerUrl(url, {})).toEqual({ error: expect.stringMatching(/port 87(87|99) is reserved/) });
    }
    expect(workerUrl(undefined, { WORKER_URL: 'http://localhost:8787' })).toEqual({ error: expect.stringMatching(/reserved/) });
    expect(workerUrl('not a url', {})).toEqual({ error: expect.stringMatching(/not a URL/) });
  });
});

describe('ingest, verify and standby with no URL or a reserved port', () => {
  const env = { INGEST_SECRET: 's' };
  for (const [name, argv, envVars] of /** @type {const} */ ([
    ['no URL', [], env], ['--url :8787', ['--url', 'http://localhost:8787'], env], ['WORKER_URL :8799', [], { ...env, WORKER_URL: 'http://127.0.0.1:8799' }],
  ])) {
    it(`ingest refuses ${name}, sends nothing and writes no record`, async () => {
      /** @type {string[]} */
      const lines = [];
      const code = await ingestMain([...argv], { fetchImpl: noFetch, log: (l) => lines.push(l), envVars: { ...envVars }, statePath: join(dir, 'state.json'), runsDir: join(dir, 'runs') });
      expect(code).toBe(1);
      expect(lines.join('\n')).toMatch(/no --url and no WORKER_URL|reserved/);
      expect(await records()).toEqual([]);
    });

    it(`verify refuses ${name}, sends nothing and writes no record`, async () => {
      /** @type {string[]} */
      const lines = [];
      const code = await verifyMain([...argv], { fetchImpl: noFetch, log: (l) => lines.push(l), envVars: { ...envVars }, runsDir: join(dir, 'runs') });
      expect(code).toBe(2);
      expect(lines.join('\n')).toMatch(/no --url and no WORKER_URL|reserved/);
      expect(await records()).toEqual([]);
    });

    it(`vectors standby refuses ${name}, sends nothing and writes no record`, async () => {
      /** @type {string[]} */
      const lines = [];
      const code = await vectorsMain(['standby', ...argv], (l) => lines.push(l), { fetchImpl: noFetch, envVars: { ...envVars }, runsDir: join(dir, 'runs') });
      expect(code).toBe(2);
      expect(lines.join('\n')).toMatch(/no --url and no WORKER_URL|reserved/);
      expect(await records()).toEqual([]);
    });
  }
});

describe('each writer leaves one record on success and one on failure', () => {
  const URL_ = 'http://127.0.0.1:51999';
  const Y = '2026-2027';

  it('ingest: a refused run and a finished one', async () => {
    const records_ = [{ moduleCode: 'AA1001', title: 'T', description: 'D.', moduleCredit: '4', department: 'D', faculty: 'F', semesterData: [{ semester: 1 }] }];
    const body = JSON.stringify(records_);
    await writeFile(join(dir, `${Y}-moduleInfo.json`), body);
    await writeFile(join(dir, `${Y}-moduleInfo.json.cache.json`), JSON.stringify({ url: 'x', etag: null, lastModified: null, fetchedAt: new Date().toISOString(), sha256: createHash('sha256').update(body).digest('hex') }));
    /** @param {boolean} schemaOk */
    const worker = (schemaOk) => /** @type {typeof fetch} */ (async (input, init) => {
      const path = new URL(String(input)).pathname;
      const req = init?.body ? JSON.parse(String(init.body)) : null;
      const ok = (/** @type {unknown} */ b) => new Response(JSON.stringify(b));
      if (path === '/admin/hashes') {
        return ok({ schema: { version: schemaOk ? 6 : null, ftsExternal: schemaOk, rowidTriggers: schemaOk, rowHashColumn: schemaOk, missingColumns: [], ok: schemaOk },
          embeddingModel: '@cf/baai/bge-small-en-v1.5', modules: schemaOk ? {} : null, acadYears: {} });
      }
      if (path === '/admin/ingest') return ok({ upserted: req.modules.length, embedded: req.modules.length, mutationId: 'm1', sentAt: Date.now(), meta: { rows_read: 1, rows_written: 5 } });
      if (path === '/admin/catalogue') return ok(req ? { upserted: 0, deleted: 0, meta: { rows_read: 0, rows_written: 0 } } : { ok: true, rows: {} });
      if (path === '/admin/facets') return ok({});
      if (path === '/admin/vectorize') return ok({ processedUpToMutation: 'm1' });
      return new Response('{}', { status: 404 });
    });
    const run = (/** @type {boolean} */ schemaOk) => ingestMain(['--year', Y, '--url', URL_], {
      fetchImpl: worker(schemaOk), log: () => {}, envVars: { INGEST_SECRET: 's' }, cacheDir: new URL(`file://${dir}/`),
      statePath: join(dir, 'state.json'), dataVersionPath: join(dir, 'dv.json'), runsDir: join(dir, 'runs'),
    });
    expect(await run(false)).toBe(1);
    const [refused, ...more] = await fresh();
    expect(await run(true)).toBe(0);
    const [done, ...more2] = await fresh();
    expect([...more, ...more2]).toEqual([]);
    expect(refused).toMatchObject({ script: 'ingest', target: URL_, outcome: 'refused', exitCode: 1, requests: { '/admin/hashes': 1 } });
    expect(done).toMatchObject({ script: 'ingest', target: URL_, outcome: 'ok', exitCode: 0, versions: { dataVersion: expect.stringMatching(/^[0-9a-f]{12}$/) } });
    expect(done.requests['/admin/ingest']).toBe(1);
    expect(done.written).toEqual([expect.objectContaining({ what: expect.stringMatching(/D1 rows/), actual: expect.any(Number) })]);
  });

  it('verify: drift, and agreement', async () => {
    const report = (/** @type {boolean} */ agree) => /** @type {typeof fetch} */ (async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === '/admin/verify') {
        return new Response(JSON.stringify({
          codes: ['AA1001'], rowHash: { drift: [], missing: [] }, meta: { rows_read: 1 },
          sample: { checked: 1, missingVectors: [], metadataDrift: agree ? [] : [{ code: 'AA1001' }] },
        }));
      }
      return new Response('{}', { status: 404 });
    });
    const exec = /** @type {import('../scripts/deploy.mjs').Exec} */ (async () => ({ code: 0, stdout: JSON.stringify({ vectors: [{ id: 'AA1001' }], isTruncated: false }) }));
    const codes = [];
    const all = [];
    for (const agree of [false, true]) {
      codes.push(await verifyMain(['--url', URL_, '--sample', '0'], { fetchImpl: report(agree), exec, log: () => {}, envVars: { INGEST_SECRET: 's' }, runsDir: join(dir, 'runs') }));
      all.push(...await fresh());
    }
    expect(all).toHaveLength(2);
    expect(codes).toEqual([1, 0]);
    expect(all.map((r) => [r.script, r.target, r.outcome, r.exitCode])).toEqual([['verify', URL_, 'failed', 1], ['verify', URL_, 'ok', 0]]);
    expect(all.every((r) => r.requests['/admin/verify'] >= 1)).toBe(true);
  });

  it('vectors standby: a refused run and a done one', async () => {
    const bundle = /** @type {any} */ ({ count: 1 });
    /** @param {'refused' | 'done'} status */
    const deps = (status) => ({
      fetchImpl: noFetch, envVars: { INGEST_SECRET: 's' }, runsDir: join(dir, 'runs'),
      loadBundle: async () => ({ entry: { asset: 'vec.bin' }, bundle }),
      listIds: async () => ['AA1001'],
      runStandby: async (/** @type {any} */ o) => { o.api.get('/admin/hashes'); return { status, message: status, upserted: 1, deleted: 0, mutations: ['m1'], lastMutationId: 'm1' }; },
      runVerify: async () => /** @type {import('../scripts/verify-core.mjs').VerifyReport} */ (/** @type {unknown} */ ({ ok: true, rowsRead: 1 })),
      formatReport: () => ['ok'],
    });
    expect(await vectorsMain(['standby', '--url', URL_], () => {}, deps('refused'))).toBe(1);
    const [refused] = await fresh();
    expect(await vectorsMain(['standby', '--url', URL_], () => {}, deps('done'))).toBe(0);
    const [done] = await fresh();
    expect(await records()).toHaveLength(2);
    expect(refused).toMatchObject({ script: 'vectors standby', target: URL_, outcome: 'refused', exitCode: 1 });
    expect(done).toMatchObject({ script: 'vectors standby', target: URL_, outcome: 'ok', exitCode: 0 });
  });
});
