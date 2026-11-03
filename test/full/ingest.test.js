// @ts-check
// Phase 1C over the full pinned corpus (6,771 modules): what ingest costs in
// D1 rows, measured on local D1 through the real routes and
// scripts/ingest-core.mjs (fake Workers AI and Vectorize). Every D1 statement
// any admin route runs is metered (meta.rows_read / rows_written), including
// /admin/hashes and the facets rebuild, which the ingest script's own budget
// does not see. Logs one `[1C] {...}` line; docs/evidence/phase1/ingest-cost.md
// quotes it.
//
// SC6: a forced full re-ingest stays under 10% of the daily D1 read limit
// (500,000 rows), and within the default write budget (40,000, ADR 0002).
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { runIngest } from '../../scripts/ingest-core.mjs';
import { runVerify } from '../../scripts/verify-core.mjs';
import { createFakes } from '../fakes.js';
import { adminApi } from '../ingest-support.js';

const corpus = inject('corpus');
const SC6_READ_LIMIT = 500_000;
const facetsBody = { ngList: { updatedAsAt: null, source: null, count: 0 } };

/** @typedef {{ read: number, written: number, statements: number }} Meter */

/**
 * env.DB with every statement's D1 meta added to `meter`. `first()` runs as
 * `all()` because only `all()`/`run()`/`batch()` return meta.
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

describe.skipIf(!corpus)('ingest cost over the full pinned corpus (Phase 1C, SC6)', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const fakes = createFakes();
  /** @type {Record<string, unknown>} */
  const report = { modules: c.modules.length };

  /**
   * One metered run.
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
      // What the script's budget sums (ingest + delete responses only)...
      budgetRowsWritten: result.rowsWritten,
      // ...and every D1 statement of the run, /admin/hashes and facets included.
      rowsRead: meter.read, rowsWritten: meter.written, statements: meter.statements,
    };
    return { result, meter };
  };

  beforeAll(async () => {
    await reset();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it('cold ingest, forced full re-ingest (SC6), no-op rerun, field-only change, 10 deletes, verify', async () => {
    // Cold: an empty 0006 database. An INSERT writes the row, its primary-key
    // index entry and every filter index (~7.1 rows/module), more than the
    // 40,000 default budget (sized for the forced re-ingest of existing rows,
    // ADR 0002), so the default stops it cleanly; it loads with a higher one.
    const stopped = await measured('coldDefaultBudget', c.modules);
    expect(stopped.result.status).toBe('budget');
    expect(stopped.result.rowsWritten).toBeLessThanOrEqual(40_000);
    const cold = await measured('coldResume', c.modules);
    expect(cold.result.status).toBe('done');
    expect(stopped.result.upserted + cold.result.upserted).toBe(c.modules.length);

    // SC6: forced full re-ingest.
    const forced = await measured('forced', c.modules, { force: true });
    expect(forced.result.status).toBe('done');
    expect(forced.result.plan.embed).toBe(c.modules.length);
    expect(forced.meter.read).toBeLessThan(SC6_READ_LIMIT);
    expect(forced.result.rowsWritten).toBeLessThanOrEqual(40_000);

    // Nothing changed.
    const noop = await measured('noop', c.modules);
    expect(noop.result.plan).toMatchObject({ embed: 0, rowOnly: 0, deletes: 0 });
    expect(noop.result.upserted).toBe(0);

    // Field-only changes on 25 modules: semesters, credits, prerequisite, NG flags.
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

    // 10 modules leave the corpus.
    const gone = changedCorpus.filter((_, i) => i % 677 === 5).slice(0, 10);
    expect(gone).toHaveLength(10);
    const goneCodes = new Set(gone.map((m) => m.code));
    const smaller = changedCorpus.filter((m) => !goneCodes.has(m.code));
    const del = await measured('delete10', smaller);
    expect(del.result).toMatchObject({ status: 'done', deleted: 10 });
    expect(Number(await env.DB.prepare('SELECT count(*) AS n FROM modules').first('n'))).toBe(smaller.length);
    for (const code of goneCodes) expect(fakes.vectorize.vectors.has(code)).toBe(false);
    await env.DB.prepare("INSERT INTO modules_fts(modules_fts, rank) VALUES('integrity-check', 1)").run();

    // And the stores agree.
    /** @type {Meter} */
    const vmeter = { read: 0, written: 0, statements: 0 };
    const verify = await runVerify({
      api: adminApi(() => fakes, { DB: meteredDb(vmeter) }), listVectorIds: async () => [...fakes.vectorize.vectors.keys()],
    });
    expect(verify.ok).toBe(true);
    report.verify = { rowsRead: vmeter.read, rowsWritten: vmeter.written, sample: verify.sampleChecked };

    console.log(`[1C] ${JSON.stringify(report)}`);
  }, 900_000);
});
