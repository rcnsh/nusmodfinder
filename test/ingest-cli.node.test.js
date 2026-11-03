// @ts-check
// scripts/ingest.mjs, the CLI around scripts/ingest-core.mjs: flags and their
// defaults, exit codes, and src/data-version.json written only after a run
// that finished. The Worker is a stub fetch; the corpus is three records in a
// temporary cache directory, so nothing reaches api.nusmods.com or Cloudflare.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DATA_VERSION_PATH, dataVersionFile, main, parseDuration, parseIngestArgs } from '../scripts/ingest.mjs';
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
          embeddingModel: '@cf/baai/bge-small-en-v1.5', modules: schemaOk ? {} : null });
      case '/admin/ingest':
        mutation++;
        return ok({ upserted: body.modules.length, embedded: body.modules.length, mutationId: `m${mutation}`,
          meta: { rows_read: body.modules.length, rows_written: writesPerModule * body.modules.length } });
      case '/admin/facets': return ok({ faculties: 1, levels: 1, ng: 0, ngListUpdatedAsAt: null });
      case '/admin/vectorize': return ok({ vectorCount: 3, processedUpToMutation: `m${mutation}` });
      default: return new Response('{}', { status: 404 });
    }
  };
  return { fetchImpl, paths };
}

/** @type {string} */
let dir;
/** @type {URL} */
let cacheDir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vnm-ingest-'));
  cacheDir = new URL(`file://${dir}/`);
  await writeFile(join(dir, `${Y}-moduleInfo.json`), JSON.stringify(records));
  await writeFile(join(dir, `${Y}-moduleInfo.json.cache.json`), JSON.stringify({ url: 'x', etag: null, lastModified: null, fetchedAt: new Date().toISOString() }));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** @param {string[]} argv @param {ReturnType<typeof stubWorker>} worker */
const run = async (argv, worker) => {
  /** @type {string[]} */
  const lines = [];
  const dataVersionPath = join(dir, 'data-version.json');
  const code = await main(['--year', Y, '--url', 'http://worker.test', ...argv], {
    fetchImpl: worker.fetchImpl, log: (l) => lines.push(l), dataVersionPath, cacheDir, envVars: { INGEST_SECRET: 's' },
  });
  const written = await readFile(dataVersionPath, 'utf8').catch(() => null);
  return { code, lines, written };
};

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
    const { code, written, lines } = await run(['--write-budget', '15', '--batch', '1', '--concurrency', '1'], stubWorker({ writesPerModule: 6 }));
    expect(code).toBe(2);
    expect(written).toBeNull();
    expect(lines.join('\n')).toMatch(/Stopped cleanly: 2 of 3 modules upserted/);
  });
});
