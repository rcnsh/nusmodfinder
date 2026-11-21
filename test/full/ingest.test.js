// @ts-check
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { runIngest } from '../../scripts/ingest-core.mjs';
import { runVerify } from '../../scripts/verify-core.mjs';
import { sha256Hex } from '../../src/rowhash.js';
import { createFakes } from '../fakes.js';
import { adminApi } from '../ingest-support.js';

const corpus = inject('corpus');
const FULL_REINGEST_READ_LIMIT = 500_000;
const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };

/** @typedef {{ read: number, written: number, statements: number }} Meter */

/**
 * @param {Meter} meter
 * @returns {D1Database}
 */
function meteredDb(meter) {
  /** @param {D1Result} r */
  const add = (r) => { meter.read += r.meta?.rows_read ?? 0; meter.written += r.meta?.rows_written ?? 0; meter.statements++; };
  /** @param {D1PreparedStatement} stmt @returns {any} */
  const wrap = (stmt) => ({
    inner: stmt,
    bind: (/** @type {unknown[]} */ ...args) => wrap(stmt.bind(...args)),
    all: async () => { const r = await stmt.all(); add(r); return r; },
    run: async () => { const r = await stmt.run(); add(r); return r; },
    first: async (/** @type {string | undefined} */ col) => {
      const r = await stmt.all();
      add(r);
      const row = /** @type {Record<string, unknown> | undefined} */ (r.results[0]);
      if (!row) return null;
      return col === undefined ? row : (row[col] ?? null);
    },
  });
  return /** @type {any} */ ({
    prepare: (/** @type {string} */ sql) => wrap(env.DB.prepare(sql)),
    batch: async (/** @type {any[]} */ stmts) => {
      const res = await env.DB.batch(stmts.map((s) => s.inner ?? s));
      res.forEach(add);
      return res;
    },
  });
}

describe.skipIf(!corpus)('ingest cost over the full pinned corpus', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const fakes = createFakes();
  /** @type {Record<string, unknown>} */
  const report = { modules: c.modules.length };

  /**
   * @param {string} name
   * @param {NormalisedModule[]} modules
   * @param {import('../../scripts/ingest-core.mjs').IngestOptions} [options]
   */
  const measured = async (name, modules, options = {}) => {
    /** @type {Meter} */
    const meter = { read: 0, written: 0, statements: 0 };
    const aiBefore = fakes.ai.calls.length;
    const result = await runIngest({
      modules, facetsBody, api: adminApi(() => fakes, { DB: meteredDb(meter) }), options, sleep: async () => {},
    });
    report[name] = {
      status: result.status, plan: result.plan, embedded: result.embedded, deleted: result.deleted,
      aiCalls: fakes.ai.calls.length - aiBefore,
      budgetRowsWritten: result.rowsWritten,
      budgetRowsCharged: result.rowsCharged,
      rowsRead: meter.read, rowsWritten: meter.written, statements: meter.statements,
    };
    return { result, meter };
  };

  beforeAll(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it('cold ingest, forced full re-ingest within the read budget, no-op rerun, field-only change, 10 deletes, verify', async () => {
    const stopped = await measured('coldDefaultBudget', c.modules);
    expect(stopped.result.status).toBe('budget');
    expect(stopped.result.rowsCharged).toBeLessThanOrEqual(40_000);
    const cold = await measured('coldResume', c.modules, { writeBudget: 200_000 });
    expect(cold.result.status).toBe('done');
    expect(stopped.result.upserted + cold.result.upserted).toBe(c.modules.length);

    const mainFormat = await Promise.all(c.modules.map(async (m) => env.DB
      .prepare('UPDATE modules SET text_hash = ?, row_hash = NULL WHERE code = ?').bind((await sha256Hex(m.text)).slice(0, 32), m.code)));
    for (let i = 0; i < mainFormat.length; i += 500) await env.DB.batch(mainFormat.slice(i, i + 500));
    const production = await measured('productionStart', c.modules);
    expect(production.result.status).toBe('done');
    expect(production.result.plan).toMatchObject({ embed: c.modules.length, rowOnly: 0, unchanged: 0, deletes: 0 });
    expect(production.result.rowsCharged).toBeLessThanOrEqual(40_000);

    const forced = await measured('forced', c.modules, { force: true });
    expect(forced.result.status).toBe('done');
    expect(forced.result.plan.embed).toBe(c.modules.length);
    expect(forced.meter.read).toBeLessThan(FULL_REINGEST_READ_LIMIT);
    expect(forced.result.rowsCharged).toBeLessThanOrEqual(40_000);
    expect(forced.result.rowsCharged).toBeGreaterThanOrEqual(forced.result.rowsWritten);

    const noop = await measured('noop', c.modules);
    expect(noop.result.plan).toMatchObject({ embed: 0, rowOnly: 0, deletes: 0 });
    expect(noop.result.upserted).toBe(0);

    const touched = new Map();
    c.modules.forEach((m, i) => {
      if (i % 271 !== 0 || touched.size >= 25) return;
      const k = touched.size;
      touched.set(m.code, k < 10 ? { ...m, semesters: m.semesters.includes(3) ? [1] : [...m.semesters, 3].sort() }
        : k < 15 ? { ...m, credits: (m.credits ?? 0) + 2 }
          : k < 20 ? { ...m, prerequisite: `${m.prerequisite ?? ''} (revised)` }
            : { ...m, ng: !m.ng, ngSemesters: m.ng ? [] : [1] });
    });
    expect(touched.size).toBe(25);
    const changedCorpus = c.modules.map((m) => touched.get(m.code) ?? m);
    const field = await measured('fieldOnly25', changedCorpus);
    expect(field.result.plan).toMatchObject({ embed: 0, rowOnly: 25, deletes: 0 });
    expect(report.fieldOnly25).toMatchObject({ aiCalls: 0 });
    for (const m of touched.values()) {
      const row = /** @type {any} */ (await env.DB.prepare('SELECT semesters, credits, prerequisite, ng FROM modules WHERE code = ?').bind(m.code).first());
      expect(row).toEqual({ semesters: JSON.stringify(m.semesters), credits: m.credits, prerequisite: m.prerequisite, ng: m.ng ? 1 : 0 });
    }

    const gone = changedCorpus.filter((_, i) => i % 677 === 5).slice(0, 10);
    expect(gone).toHaveLength(10);
    const goneCodes = new Set(gone.map((m) => m.code));
    const smaller = changedCorpus.filter((m) => !goneCodes.has(m.code));
    const del = await measured('delete10', smaller);
    expect(del.result).toMatchObject({ status: 'done', deleted: 10 });
    expect(Number(await env.DB.prepare('SELECT count(*) AS n FROM modules').first('n'))).toBe(smaller.length);
    for (const code of goneCodes) expect(fakes.vectorize.vectors.has(code)).toBe(false);
    await env.DB.prepare("INSERT INTO modules_fts(modules_fts, rank) VALUES('integrity-check', 1)").run();

    /** @type {Meter} */
    const vmeter = { read: 0, written: 0, statements: 0 };
    const verify = await runVerify({
      api: adminApi(() => fakes, { DB: meteredDb(vmeter) }), listVectorIds: async () => [...fakes.vectorize.vectors.keys()],
    });
    expect(verify.ok).toBe(true);
    report.verify = { rowsRead: vmeter.read, rowsWritten: vmeter.written, sample: verify.sampleChecked };

    console.log(`[ingest-cost] ${JSON.stringify(report)}`);
  }, 900_000);
});
