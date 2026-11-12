// @ts-check
// Lexical search over the full pinned corpus (6,771 modules, loaded through
// /admin/ingest): migration 0006 applied on top of a populated 0001–0005
// database, as it was remotely, then
// - ranking neutrality: unfiltered lexical top-50 unchanged by 0006 for every
//   query in test/fixtures/lexical-queries.json (only exact-bm25 tie groups may
//   reorder);
// - filtered lexical (filters in SQL, before the depth cut) equals brute force for every query x single filter
//   value, every two-filter combination and a sample of 3-5-filter ones on
//   broad queries, with and without the facets counts that pick the driver;
// - worst-case D1 rows read per filtered search <= 8,000 (with counts);
// - the counts are read once per isolate, only on the filter-driven path;
// - re-ingest and per-row update costs under the rowid-keyed FTS triggers.
// Each measured block logs one `[lexical-cost] {...}` JSON line.
import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, inject, it } from 'vitest';
import { ftsMatch, lexicalSearch, resetFilterCounts } from '../../src/lexical.js';
import { bitOf } from '../../src/ng-bit.js';
import { Trace } from '../../src/timing.js';
import { createFakes } from '../fakes.js';
import { call, TEST_INGEST_SECRET } from '../helpers.js';
import queryFixture from '../fixtures/lexical-queries.json';

const corpus = inject('corpus');
const SAMPLED = inject('lexicalGrid') === 'sample';

/** The most D1 rows a filtered search may read. */
const ROWS_READ_GATE = 8000;
/** MAX_TOPK: the deepest list either retriever is ever asked for. */
const DEPTH = 50;
const QUERIES = [...new Set(/** @type {string[]} */ (queryFixture.queries))];

/** @typedef {{ r: number, code: string, semesters: string | null, level: number | null, faculty: string | null, credits: number | null, ng: number, ng_allow: number }} Row */
/** @typedef {import('../../src/search.js').FilterEcho} FilterEcho */
/** @typedef {import('../../src/lexical.js').FilterKey} FilterKey */

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
 * Loads modules into a pre-0006 database the way production's rows were
 * written: the column list from before row_hash, no row_hash. (/admin/ingest now
 * writes row_hash, which exists only from 0006 on, so it fails on this schema
 * by design; see scripts/ingest-core.mjs's schema guard.)
 * @param {NormalisedModule[]} modules
 */
async function legacyLoad(modules) {
  const stmt = env.DB.prepare(
    `INSERT INTO modules (code, title, description, credits, department, faculty, level, semesters, workload,
                          prerequisite, preclusion, acad_year, text_hash, ng, ng_semesters)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < modules.length; i += 100) {
    await env.DB.batch(modules.slice(i, i + 100).map((m) => stmt.bind(
      m.code, m.title, m.description, m.credits, m.department, m.faculty, m.level, JSON.stringify(m.semesters),
      m.workload, m.prerequisite, m.preclusion, m.acadYear, m.textHash, m.ng ? 1 : 0, JSON.stringify(m.ngSemesters ?? []))));
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
  // Under ng, sem picks the allow-mask bit instead of testing the semesters.
  if (echo.sem !== undefined && echo.ng !== true && !JSON.parse(row.semesters ?? '[]').includes(echo.sem)) return false;
  if (echo.ng === true && (row.ng_allow & bitOf(echo.sem === 1 || echo.sem === 2 ? echo.sem : 'any', /** @type {any} */ (echo.study))) === 0) return false;
  if (echo.level !== undefined && row.level !== echo.level) return false;
  if (echo.credits !== undefined && row.credits !== echo.credits) return false;
  if (echo.faculty !== undefined && row.faculty !== echo.faculty) return false;
  if (echo.ng === true && row.ng !== 1) return false;
  return true;
}

/** @param {number[]} xs sorted ascending @param {number} p */
const pct = (xs, p) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];

describe.skipIf(!corpus)('lexical search over the full pinned corpus', () => {
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
    await legacyLoad(c.modules);
    before = await unfilteredTopN();
    await applyD1Migrations(env.DB, rest);
    // The allow mask (0009), as ingest computes it, for the ng filter.
    const set = env.DB.prepare('UPDATE modules SET ng_allow = ? WHERE code = ?');
    for (let i = 0; i < c.modules.length; i += 100) await env.DB.batch(c.modules.slice(i, i + 100).map((m) => set.bind(m.ngAllow, m.code)));
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
    console.log(`[lexical-cost] ${JSON.stringify({ neutrality: { queries: before.size, identical, tieOnly, other: other.length, rankValueChanges } })}`);
    expect(other).toEqual([]);
    expect(rankValueChanges).toBe(0);
  }, 600_000);

  /**
   * Runs every case through lexicalSearch and compares it with brute force:
   * every match of the MATCH expression sorted by (rank, rowid), filtered in
   * JS from the JSON semesters and the plain columns, cut to the depth.
   * @param {{ q: string, echo: FilterEcho, limits: number[] }[]} all
   */
  async function grid(all) {
    // A fixed 1-in-10 sample under LEXICAL_GRID=sample: every 10th case, in grid order.
    const cases = SAMPLED ? all.filter((_, i) => i % 10 === 0) : all;
    const { results: rows } = /** @type {D1Result<Row>} */ (await env.DB.prepare(
      'SELECT rowid AS r, code, semesters, level, faculty, credits, ng, ng_allow FROM modules').all());
    const byRowid = new Map(rows.map((r) => [r.r, r]));
    /** @type {Map<string, Row[]>} */
    const hitsByQuery = new Map();
    /** @type {number[]} */
    const cost = [];
    /** @type {Record<string, number>} */
    const worstByShape = {};
    let worst = { rows: 0, q: '', echo: /** @type {FilterEcho} */ ({}), matches: 0 };
    let searches = 0, fallback = 0;
    /** @type {string[]} */
    const mismatches = [];
    for (const { q, echo, limits } of cases) {
      let hits = hitsByQuery.get(q);
      if (!hits) {
        const { results } = /** @type {D1Result<{ r: number, rank: number }>} */ (await env.DB.prepare(
          'SELECT rowid AS r, rank FROM modules_fts WHERE modules_fts MATCH ?').bind(/** @type {string} */ (ftsMatch(q))).all());
        results.sort((x, y) => x.rank - y.rank || x.r - y.r);
        hits = results.map((h) => /** @type {Row} */ (byRowid.get(h.r)));
        hitsByQuery.set(q, hits);
      }
      const filtered = hits.filter((row) => passes(row, echo));
      for (const limit of limits) {
        const trace = new Trace();
        const got = await lexicalSearch(env.DB, q, echo, limit, trace);
        const want = filtered.slice(0, limit).map((row) => row.code);
        if (got.join() !== want.join()) mismatches.push(`${JSON.stringify(q)} ${JSON.stringify(echo)} limit=${limit}: got ${got.length}, want ${want.length}`);
        if (limit !== DEPTH) continue;
        searches++;
        if (trace.d1.queries > 1) fallback++;
        const rowsRead = trace.d1.rowsRead;
        cost.push(rowsRead);
        const shape = Object.keys(echo).sort().join('+');
        worstByShape[shape] = Math.max(worstByShape[shape] ?? 0, rowsRead);
        if (rowsRead > worst.rows) worst = { rows: rowsRead, q, echo, matches: hits.length };
      }
    }
    cost.sort((x, y) => x - y);
    return {
      mismatches,
      max: /** @type {number} */ (cost.at(-1)),
      summary: {
        searches, secondStatement: fallback,
        rowsRead: {
          mean: Math.round(cost.reduce((x, y) => x + y, 0) / cost.length),
          p50: pct(cost, 0.5), p90: pct(cost, 0.9), p99: pct(cost, 0.99), max: cost.at(-1),
          over4000: cost.filter((x) => x > 4000).length, over6000: cost.filter((x) => x > 6000).length,
          over8000: cost.filter((x) => x > ROWS_READ_GATE).length,
        },
        worst, worstByShape,
      },
    };
  }

  /**
   * Every value each filter can take on this corpus, as single-key echoes.
   * @returns {Promise<Record<FilterKey, FilterEcho[]>>}
   */
  async function filterValues() {
    const distinct = async (/** @type {string} */ col) => /** @type {any[]} */ ((await env.DB.prepare(
      `SELECT DISTINCT ${col} AS v FROM modules WHERE ${col} IS NOT NULL ORDER BY ${col}`).all()).results).map((r) => r.v);
    return {
      sem: [1, 2, 3, 4].map((sem) => ({ sem })),
      level: (await distinct('level')).map((level) => ({ level })),
      credits: (await distinct('credits')).map((credits) => ({ credits })),
      faculty: (await distinct('faculty')).map((faculty) => ({ faculty })),
      ng: [{ ng: true, study: 'ug2' }],
    };
  }

  /**
   * Every two-filter combination of values (two different filters), and a
   * sample of three-to-five-filter ones: all combinations of each filter's
   * two most common values (sem: all four), plus 200 seeded uniform draws.
   * @param {Record<FilterKey, FilterEcho[]>} values
   */
  function combinations(values) {
    const keys = /** @type {FilterKey[]} */ (Object.keys(values));
    /** @param {FilterKey[]} ks @param {Record<FilterKey, FilterEcho[]>} vs @returns {FilterEcho[]} */
    const product = (ks, vs) => ks.reduce((acc, k) => acc.flatMap((e) => vs[k].map((v) => ({ ...e, ...v }))), [/** @type {FilterEcho} */ ({})]);
    /** @param {number} n @returns {FilterKey[][]} */
    const subsets = (n) => {
      /** @type {FilterKey[][]} */
      const out = [];
      const rec = (/** @type {number} */ i, /** @type {FilterKey[]} */ acc) => {
        if (acc.length === n) { out.push(acc); return; }
        for (let j = i; j < keys.length; j++) rec(j + 1, [...acc, keys[j]]);
      };
      rec(0, []);
      return out;
    };
    const pairs = subsets(2).flatMap((ks) => product(ks, values));
    /** @type {Record<FilterKey, FilterEcho[]>} */
    const common = { ...values, level: values.level.filter((e) => e.level === 5 || e.level === 4),
      credits: values.credits.filter((e) => e.credits === 4 || e.credits === 2),
      faculty: values.faculty.filter((e) => e.faculty === 'Arts and Social Science' || e.faculty === 'College of Design and Engineering') };
    const many = [3, 4, 5].flatMap((n) => subsets(n).flatMap((ks) => product(ks, common)));
    let seed = 0x1a2b3c;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    for (let i = 0; i < 200; i++) {
      const n = 3 + Math.floor(rand() * 3);
      const ks = [...keys].sort(() => rand() - 0.5).slice(0, n);
      many.push(Object.assign({}, ...ks.map((k) => values[k][Math.floor(rand() * values[k].length)])));
    }
    // /search never sends ng with a special term (it answers ng-special-term), so neither does the grid.
    const sendable = (/** @type {FilterEcho} */ e) => !(e.ng === true && (e.sem === 3 || e.sem === 4));
    return { pairs: pairs.filter(sendable), many: many.filter(sendable) };
  }

  /**
   * Broad queries for the multi-filter grids: each matches more than 2,000
   * modules (asserted), so every search can reach the filter-driven plan.
   * The fixed-order grids use the first four (the worst ones measured).
   */
  const BROAD = ['and', 'the', 'in', 'students will learn', 'how to', 'students', 'of', 'to', 'for', 'with',
    'is', 'course'];

  it('filtered lexical equals brute force on a grid of single, two- and many-filter searches, and costs <= 8,000 rows read', async () => {
    await call('/admin/facets', {
      fakes: createFakes(),
      env: { INGEST_SECRET: TEST_INGEST_SECRET },
      init: { method: 'POST', headers: { authorization: `Bearer ${TEST_INGEST_SECRET}` } },
    });
    resetFilterCounts();
    const values = await filterValues();
    const { pairs, many } = combinations(values);
    /** @type {string[]} */
    const broad = [];
    for (const q of BROAD) {
      const n = /** @type {number} */ (await env.DB.prepare('SELECT count(*) AS n FROM modules_fts WHERE modules_fts MATCH ?')
        .bind(/** @type {string} */ (ftsMatch(q))).first('n'));
      if (n > 2_000) broad.push(q);
    }
    expect(broad).toEqual(BROAD);

    // Shallower depths (topK 1 and 5) for the selective single filters, where
    // the cap/fallback boundary moves.
    const shallow = (/** @type {FilterEcho} */ e) => e.sem === 3 || e.sem === 4 || e.level === 8 || e.credits === 8
      || (e.faculty !== undefined && e.faculty.length % 3 === 0);
    const singles = Object.values(values).flat();
    const queries = [...new Set([...QUERIES.filter((q) => ftsMatch(q)), ...broad])];
    const single = await grid(queries.flatMap((q) => singles.map((echo) => ({ q, echo, limits: shallow(echo) ? [DEPTH, 3, 15] : [DEPTH] }))));
    const two = await grid(broad.flatMap((q) => pairs.map((echo) => ({ q, echo, limits: [DEPTH] }))));
    const more = await grid(broad.flatMap((q) => many.map((echo) => ({ q, echo, limits: [DEPTH] }))));

    // The same multi-filter grids without counts in the facets row (a row
    // written before they existed): the driver comes from FIXED_DRIVER_ORDER.
    // Exact, but not inside the gate: no per-filter order can know that
    // level=5 (2,713 rows) is a worse driver than credits=5 (407) but a
    // better one than credits=4 (5,081). Measured, not asserted.
    await env.DB.prepare("UPDATE meta SET value = json_remove(value, '$.credits') WHERE key = 'facets'").run();
    resetFilterCounts();
    const fixedQueries = broad.slice(0, 4);
    const fixedTwo = await grid(fixedQueries.flatMap((q) => pairs.map((echo) => ({ q, echo, limits: [DEPTH] }))));
    const fixedMore = await grid(fixedQueries.flatMap((q) => many.map((echo) => ({ q, echo, limits: [DEPTH] }))));
    await call('/admin/facets', {
      fakes: createFakes(),
      env: { INGEST_SECRET: TEST_INGEST_SECRET },
      init: { method: 'POST', headers: { authorization: `Bearer ${TEST_INGEST_SECRET}` } },
    });
    resetFilterCounts();

    const report = {
      grid: {
        queries: queries.length, broadQueries: broad, singleFilters: singles.length, twoFilterCombos: pairs.length,
        manyFilterCombos: many.length, fixedOrderQueries: fixedQueries,
      },
      single: single.summary, two: two.summary, many: more.summary,
      fixedOrder: { two: fixedTwo.summary, many: fixedMore.summary },
    };
    console.log(`[lexical-cost] ${JSON.stringify({ filteredCost: report })}`);
    for (const g of [single, two, more, fixedTwo, fixedMore]) expect(g.mismatches.slice(0, 20)).toEqual([]);
    expect(single.summary.searches + two.summary.searches + more.summary.searches).toBeGreaterThan(SAMPLED ? 3000 : 30000);
    for (const g of [single, two, more]) expect(g.max).toBeLessThanOrEqual(ROWS_READ_GATE);
  }, 1_800_000);

  it('the facets counts are read once per isolate, and only by a multi-filter search that reaches the filter-driven plan', async () => {
    resetFilterCounts();
    const queries = async (/** @type {string} */ q, /** @type {FilterEcho} */ echo) => {
      const trace = new Trace();
      await lexicalSearch(env.DB, q, echo, DEPTH, trace);
      return trace.d1.queries;
    };
    expect(await queries('in', {})).toBe(1);
    expect(await queries('in', { credits: 4, level: 2 })).toBe(1); // bounded pass fills the page
    expect(await queries('in', { level: 8 })).toBe(2); // one indexed filter: no choice to make
    expect(await queries('in', { faculty: 'Computing', credits: 4 })).toBe(3); // bounded, counts, filter-driven
    expect(await queries('in', { faculty: 'Computing', credits: 4 })).toBe(2);
    expect(await queries('in', { faculty: 'Computing', level: 4 })).toBe(2);
  });

  it('a forced full re-ingest writes nothing to the FTS index; one title change reads a handful of rows', async () => {
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
    console.log(`[lexical-cost] ${JSON.stringify(reingestCost)}`);
    // One row read per updated row (a BEFORE UPDATE trigger would make SQLite
    // re-read each row, doubling these).
    expect(update.meta.rows_read).toBe(1);
    expect(one.read).toBe(1);
    expect(full.read).toBe(c.modules.length);
  }, 600_000);
});
