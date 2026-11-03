// @ts-check
// Phase 1A over the full pinned corpus (6,771 modules, loaded through
// /admin/ingest): migration 0006 applied on top of a populated 0001–0005
// database, as it will be remotely, then
// - ranking neutrality: unfiltered lexical top-50 unchanged by 0006 for every
//   query in test/fixtures/lexical-queries.json (only exact-bm25 tie groups may
//   reorder);
// - filtered lexical (B1) equals brute force for every query x filter;
// - worst-case D1 rows read per filtered search <= 8,000;
// - re-ingest and per-row update costs under the new triggers (B3).
// Each measured block logs one `[1A] {...}` JSON line; docs/evidence/phase1/
// quotes them.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { ftsMatch, lexicalSearch } from '../../src/lexical.js';
import { Trace } from '../../src/timing.js';
import { createFakes } from '../fakes.js';
import { call, TEST_INGEST_SECRET } from '../helpers.js';
import queryFixture from '../fixtures/lexical-queries.json';

const corpus = inject('corpus');

/** docs/plans/phase1.md Final #1. */
const ROWS_READ_GATE = 8000;
/** MAX_TOPK: the deepest list either retriever is ever asked for. */
const DEPTH = 50;
const QUERIES = [...new Set(/** @type {string[]} */ (queryFixture.queries))];

/** @typedef {{ r: number, code: string, semesters: string | null, level: number | null, faculty: string | null, credits: number | null, ng: number }} Row */
/** @typedef {import('../../src/search.js').FilterEcho} FilterEcho */

/**
 * Wraps env.DB so the D1 meta of every batch the Worker runs is summed.
 * @param {{ read: number, written: number, statements: number }} sum
 * @returns {D1Database}
 */
function meteredDb(sum) {
  return /** @type {any} */ ({
    prepare: (/** @type {string} */ sql) => env.DB.prepare(sql),
    batch: async (/** @type {D1PreparedStatement[]} */ stmts) => {
      const res = await env.DB.batch(stmts);
      for (const r of res) { sum.read += r.meta.rows_read; sum.written += r.meta.rows_written; sum.statements++; }
      return res;
    },
  });
}

/**
 * Posts modules to /admin/ingest in batches.
 * @param {NormalisedModule[]} modules
 * @param {number} size
 * @param {D1Database} [db]
 */
async function ingest(modules, size, db) {
  const fakes = createFakes();
  for (let i = 0; i < modules.length; i += size) {
    const res = await call('/admin/ingest', {
      fakes,
      env: { INGEST_SECRET: TEST_INGEST_SECRET, ...(db ? { DB: db } : {}) },
      init: {
        method: 'POST',
        headers: { authorization: `Bearer ${TEST_INGEST_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ modules: modules.slice(i, i + size) }),
      },
    });
    if (res.status !== 200) throw new Error(`ingest batch ${i / size}: HTTP ${res.status} ${await res.text()}`);
  }
}

/**
 * Unfiltered lexical top-DEPTH for every query, with each code's bm25 rank.
 * @returns {Promise<Map<string, { codes: string[], rank: Map<string, number> }>>}
 */
async function unfilteredTopN() {
  const out = new Map();
  for (const q of QUERIES) {
    const match = ftsMatch(q);
    if (!match) continue;
    const codes = await lexicalSearch(env.DB, q, {}, DEPTH, new Trace());
    const { results } = /** @type {D1Result<{ code: string, rank: number }>} */ (await env.DB.prepare(
      'SELECT modules_fts.code AS code, rank FROM modules_fts WHERE modules_fts MATCH ? ORDER BY rank LIMIT ?',
    ).bind(match, DEPTH * 4).all());
    out.set(q, { codes, rank: new Map(results.map((r) => [r.code, r.rank])) });
  }
  return out;
}

/**
 * Filter oracle that does not use the generated columns: semesters straight
 * from the JSON, like the Worker did before 0006.
 * @param {Row} row
 * @param {FilterEcho} echo
 */
function passes(row, echo) {
  if (echo.sem !== undefined && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.level !== undefined && row.level !== echo.level) return false;
  if (echo.credits !== undefined && row.credits !== echo.credits) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  if (echo.ng === true && row.ng !== 1) return false;
  return true;
}

/** @param {number[]} xs sorted ascending @param {number} p */
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];

describe.skipIf(!corpus)('lexical search over the full pinned corpus (Phase 1A)', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  /** @type {Map<string, { codes: string[], rank: Map<string, number> }>} */
  let before;

  beforeAll(async () => {
    await reset();
    const migrations = env.TEST_MIGRATIONS;
    const pre = migrations.filter((m) => m.name < '0006');
    const rest = migrations.filter((m) => m.name >= '0006');
    expect(pre.map((m) => m.name)).toEqual(['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql']);
    expect(rest.map((m) => m.name)[0]).toBe('0006_fts_external.sql');
    await applyD1Migrations(env.DB, pre);
    await ingest(c.modules, 100);
    before = await unfilteredTopN();
    await applyD1Migrations(env.DB, rest);
  }, 600_000);

  it('0006 leaves unfiltered lexical top-50 unchanged for every query (ties may reorder)', async () => {
    const after = await unfilteredTopN();
    expect(after.size).toBe(before.size);
    let identical = 0, tieOnly = 0, rankValueChanges = 0;
    /** @type {string[]} */
    const other = [];
    for (const [q, b] of before) {
      const a = /** @type {{ codes: string[], rank: Map<string, number> }} */ (after.get(q));
      for (const code of b.codes) if (a.rank.has(code) && a.rank.get(code) !== b.rank.get(code)) rankValueChanges++;
      if (a.codes.join() === b.codes.join()) { identical++; continue; }
      // Allowed: the same rank sequence, and the same set of codes at every
      // rank value except the last (a tie group cut by the depth limit).
      const ranksB = b.codes.map((x) => b.rank.get(x));
      const ranksA = a.codes.map((x) => a.rank.get(x));
      const last = ranksB.at(-1);
      const group = (/** @type {string[]} */ codes, /** @type {Map<string, number>} */ rank) =>
        codes.filter((x) => rank.get(x) !== last).sort().join();
      if (ranksA.join() === ranksB.join() && group(a.codes, a.rank) === group(b.codes, b.rank)) tieOnly++;
      else other.push(q);
    }
    console.log(`[1A] ${JSON.stringify({ neutrality: { queries: before.size, identical, tieOnly, other: other.length, rankValueChanges } })}`);
    expect(other).toEqual([]);
    expect(rankValueChanges).toBe(0);
  }, 600_000);

  it('filtered lexical equals brute force for every query x filter, and costs <= 8,000 rows read', async () => {
    const { results: rows } = /** @type {D1Result<Row>} */ (await env.DB.prepare(
      'SELECT rowid AS r, code, semesters, level, faculty, credits, ng FROM modules').all());
    const byRowid = new Map(rows.map((r) => [r.r, r]));
    const faculty = /** @type {string} */ (await env.DB.prepare(
      'SELECT faculty FROM modules GROUP BY faculty ORDER BY count(*) DESC LIMIT 1').first('faculty'));
    /** @type {Record<string, FilterEcho>} */
    const FILTERS = {
      sem1: { sem: 1 }, sem2: { sem: 2 }, sem3: { sem: 3 }, sem4: { sem: 4 },
      ng: { ng: true }, 'ng+sem1': { ng: true, sem: 1 }, 'ng+sem2': { ng: true, sem: 2 },
      level1: { level: 1 }, level3: { level: 3 }, level5: { level: 5 }, level8: { level: 8 },
      faculty: { faculty }, credits8: { credits: 8 },
    };
    // Shallower depths (topK 1 and 5) for the selective filters, where the
    // cap/fallback boundary moves.
    const SHALLOW = ['sem3', 'sem4', 'level8', 'credits8', 'ng+sem2'];

    /** @type {number[]} */
    const cost = [];
    /** @type {Record<string, number>} */
    const worstByFilter = {};
    let worst = { rows: 0, q: '', filter: '', matches: 0 };
    let pairs = 0, fallback = 0, bigQueries = 0;
    /** @type {string[]} */
    const mismatches = [];
    for (const q of QUERIES) {
      const match = ftsMatch(q);
      if (!match) continue;
      const { results: hits } = /** @type {D1Result<{ r: number, rank: number }>} */ (await env.DB.prepare(
        'SELECT rowid AS r, rank FROM modules_fts WHERE modules_fts MATCH ?').bind(match).all());
      hits.sort((x, y) => x.rank - y.rank || x.r - y.r);
      if (hits.length > 2000) bigQueries++;
      for (const [name, echo] of Object.entries(FILTERS)) {
        for (const limit of SHALLOW.includes(name) ? [DEPTH, 3, 15] : [DEPTH]) {
          const trace = new Trace();
          const got = await lexicalSearch(env.DB, q, echo, limit, trace);
          const want = hits.filter((h) => passes(/** @type {Row} */ (byRowid.get(h.r)), echo))
            .slice(0, limit).map((h) => /** @type {Row} */ (byRowid.get(h.r)).code);
          if (got.join() !== want.join()) mismatches.push(`${JSON.stringify(q)} ${name} limit=${limit}: got ${got.length}, want ${want.length}`);
          if (limit !== DEPTH) continue;
          pairs++;
          if (trace.d1.queries > 1) fallback++;
          const rows = trace.d1.rowsRead;
          cost.push(rows);
          worstByFilter[name] = Math.max(worstByFilter[name] ?? 0, rows);
          if (rows > worst.rows) worst = { rows, q, filter: name, matches: hits.length };
        }
      }
    }
    cost.sort((x, y) => x - y);
    const summary = {
      queries: QUERIES.length, queriesOver2000Matches: bigQueries, pairs, secondStatement: fallback,
      rowsRead: {
        mean: Math.round(cost.reduce((x, y) => x + y, 0) / cost.length),
        p50: pct(cost, 0.5), p90: pct(cost, 0.9), p99: pct(cost, 0.99), max: cost.at(-1),
        over4000: cost.filter((x) => x > 4000).length,
      },
      worst, worstByFilter,
    };
    console.log(`[1A] ${JSON.stringify({ filteredCost: summary })}`);
    expect(mismatches).toEqual([]);
    expect(pairs).toBeGreaterThan(5000);
    expect(cost.at(-1)).toBeLessThanOrEqual(ROWS_READ_GATE);
  }, 900_000);

  it('[B3] a forced full re-ingest writes nothing to the FTS index; one title change reads a handful of rows', async () => {
    const ftsState = async () => {
      const [data, docsize] = await env.DB.batch([
        env.DB.prepare('SELECT id, hex(block) AS h FROM modules_fts_data ORDER BY id'),
        env.DB.prepare('SELECT id, hex(sz) AS h FROM modules_fts_docsize ORDER BY id'),
      ]);
      return { data: data.results, docsize: docsize.results };
    };
    const stateBefore = await ftsState();
    const full = { read: 0, written: 0, statements: 0 };
    await ingest(c.modules, 50, meteredDb(full));
    expect(full.statements).toBe(c.modules.length);
    expect(await ftsState()).toEqual(stateBefore);

    // One changed row through the same route.
    const m = /** @type {NormalisedModule} */ (c.modules.find((x) => x.code === 'CS1010S'));
    const one = { read: 0, written: 0, statements: 0 };
    await ingest([{ ...m, title: `${m.title} (revised)` }], 50, meteredDb(one));
    expect(await ftsState()).not.toEqual(stateBefore);
    await env.DB.prepare("INSERT INTO modules_fts(modules_fts, rank) VALUES('integrity-check', 1)").run();

    // A direct title update: constant cost, not a scan of 6,771 FTS rows.
    const update = await env.DB.prepare("UPDATE modules SET title = title || ' x' WHERE code = 'CS1010S'").run();
    const reingestCost = {
      forcedReingest: { modules: c.modules.length, batchSize: 50, rowsRead: full.read, rowsWritten: full.written },
      changedRowUpsert: { rowsRead: one.read, rowsWritten: one.written },
      titleUpdate: { rowsRead: update.meta.rows_read, rowsWritten: update.meta.rows_written },
    };
    console.log(`[1A] ${JSON.stringify(reingestCost)}`);
    expect(update.meta.rows_read).toBeLessThan(10);
    expect(full.read).toBeLessThan(3 * c.modules.length);
  }, 600_000);
});
