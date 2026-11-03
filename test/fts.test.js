// @ts-check
// Migration 0006's external-content FTS table and its rowid triggers, over the
// fixture corpus: the index stays exactly what a fresh 'rebuild' would make
// under any mix of inserts, upserts, updates and deletes, and re-ingesting
// unchanged rows writes nothing to it.
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { adminCall, fixture, seed } from './helpers.js';

/** @typedef {import('./fakes.js').Fakes} Fakes */

/** Every row of every FTS shadow table, so any FTS write shows up as a diff. */
async function ftsState() {
  const [data, idx, docsize, config] = await env.DB.batch([
    env.DB.prepare('SELECT id, hex(block) AS b FROM modules_fts_data ORDER BY id'),
    env.DB.prepare('SELECT segid, term, pgno FROM modules_fts_idx ORDER BY segid, term'),
    env.DB.prepare('SELECT id, hex(sz) AS sz FROM modules_fts_docsize ORDER BY id'),
    env.DB.prepare('SELECT k, v FROM modules_fts_config ORDER BY k'),
  ]);
  return { data: data.results, idx: idx.results, docsize: docsize.results, config: config.results };
}

const integrityCheck = () =>
  env.DB.prepare("INSERT INTO modules_fts(modules_fts, rank) VALUES('integrity-check', 1)").run();

/**
 * (rowid, code, rank) of every match for each term, in rank order.
 * @param {string[]} terms
 */
async function matches(terms) {
  /** @type {Record<string, unknown[]>} */
  const out = {};
  for (const t of terms) {
    const { results } = await env.DB.prepare(
      `SELECT modules_fts.rowid AS r, modules_fts.code AS code, rank FROM modules_fts
        WHERE modules_fts MATCH ? ORDER BY rank, modules_fts.rowid`).bind(`"${t}"`).all();
    out[t] = results;
  }
  return out;
}

/** Deterministic PRNG (mulberry32). @param {number} seed */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['quantum', 'zebra', 'management', 'learning', 'design', 'ethics', 'finance', 'robotics', 'poetry', 'data'];
const TERMS = [...WORDS, 'introduction', 'programming', 'system', 'urban', 'law', 'chemistry'];

/** @type {Fakes} */
let fakes;
beforeEach(async () => {
  fakes = await seed();
});

describe('0006 external-content FTS', () => {
  it('stays equal to a fresh rebuild under random inserts, upserts, updates and deletes', async () => {
    const rand = rng(6);
    const pick = (/** @type {any[]} */ xs) => xs[Math.floor(rand() * xs.length)];
    const pool = fixture.modules.slice(0, 120);
    /** @type {Map<string, NormalisedModule>} */
    const live = new Map(fixture.modules.map((m) => [m.code, m]));
    const ops = { ingest: 0, update: 0, renameCode: 0, delete: 0, reinsert: 0, noop: 0 };

    for (let step = 0; step < 60; step++) {
      const kind = pick(['ingest', 'ingest', 'update', 'renameCode', 'delete', 'reinsert', 'noop']);
      ops[/** @type {keyof typeof ops} */ (kind)]++;
      if (kind === 'ingest' || kind === 'noop') {
        // A batch through the Worker's own upsert: some rows changed in an
        // indexed column, some only in semesters, some new, some unchanged.
        const batch = Array.from({ length: 1 + Math.floor(rand() * 8) }, () => {
          const base = live.get(pick(pool).code) ?? pick(pool);
          if (kind === 'noop') return base;
          const r = rand();
          if (r < 0.3) return { ...base, title: `${base.title} ${pick(WORDS)}` };
          if (r < 0.5) return { ...base, description: `${pick(WORDS)} ${base.description ?? ''}` };
          if (r < 0.7) return { ...base, semesters: [pick([1, 2, 3, 4])] };
          if (r < 0.85) return { ...base, code: `ZZ${1000 + step}${Math.floor(rand() * 9)}`, title: `${pick(WORDS)} ${pick(WORDS)}` };
          return base;
        });
        const unique = [...new Map(batch.map((m) => [m.code, m])).values()];
        const res = await adminCall('/admin/ingest', fakes, { modules: unique });
        expect(res.status).toBe(200);
        for (const m of unique) live.set(m.code, m);
      } else if (kind === 'update') {
        const code = pick([...live.keys()]);
        await env.DB.prepare('UPDATE modules SET title = ?, description = ? WHERE code = ?')
          .bind(`${pick(WORDS)} retitled`, rand() < 0.5 ? null : `${pick(WORDS)} text`, code).run();
      } else if (kind === 'renameCode') {
        const code = pick([...live.keys()]);
        const to = `YY${2000 + step}`;
        await env.DB.prepare('UPDATE modules SET code = ? WHERE code = ?').bind(to, code).run();
        const m = /** @type {NormalisedModule} */ (live.get(code));
        live.delete(code);
        live.set(to, { ...m, code: to });
      } else if (kind === 'delete') {
        const code = pick([...live.keys()]);
        await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(code).run();
        live.delete(code);
      } else {
        // DELETE then INSERT of the same code: the row comes back on a new rowid.
        const m = /** @type {NormalisedModule} */ (live.get(pick([...live.keys()])));
        await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind(m.code).run();
        const res = await adminCall('/admin/ingest', fakes, { modules: [{ ...m, title: `${m.title} ${pick(WORDS)}` }] });
        expect(res.status).toBe(200);
      }
    }
    expect(Object.values(ops).every((n) => n > 0)).toBe(true);

    await integrityCheck();
    const before = await matches(TERMS);
    await env.DB.prepare("INSERT INTO modules_fts(modules_fts) VALUES('rebuild')").run();
    await integrityCheck();
    expect(await matches(TERMS)).toEqual(before);
    // And the index agrees with the content table on the same words.
    const { results } = await env.DB.prepare(
      "SELECT count(*) AS n FROM modules WHERE title LIKE '%zebra%' OR description LIKE '%zebra%'").all();
    expect(before.zebra.length).toBe(results[0].n);
  });

  it('a no-op re-ingest of every row writes nothing to the FTS index', async () => {
    const before = await ftsState();
    for (let i = 0; i < fixture.modules.length; i += 50) {
      const res = await adminCall('/admin/ingest', fakes, { modules: fixture.modules.slice(i, i + 50) });
      expect(res.status).toBe(200);
    }
    expect(await ftsState()).toEqual(before);

    // Changing only a filter column (semesters) does not touch the index either.
    const m = fixture.modules[0];
    await adminCall('/admin/ingest', fakes, { modules: [{ ...m, semesters: [3, 4] }] });
    expect(await ftsState()).toEqual(before);
    const row = await env.DB.prepare('SELECT sem1, sem3, sem4 FROM modules WHERE code = ?').bind(m.code).first();
    expect(row).toEqual({ sem1: 0, sem3: 1, sem4: 1 });

    // A title change does, and the index stays consistent.
    await adminCall('/admin/ingest', fakes, { modules: [{ ...m, title: `${m.title} zebra` }] });
    expect(await ftsState()).not.toEqual(before);
    await integrityCheck();
    const hit = await env.DB.prepare(`SELECT code FROM modules_fts WHERE modules_fts MATCH '"zebra"'`).all();
    expect(hit.results).toEqual([{ code: m.code }]);
  });

  it('generated semester columns agree with the JSON they are derived from', async () => {
    const { results } = await env.DB.prepare(`
      SELECT count(*) AS n FROM modules m WHERE
        sem1 != EXISTS (SELECT 1 FROM json_each(m.semesters) WHERE value = 1) OR
        sem2 != EXISTS (SELECT 1 FROM json_each(m.semesters) WHERE value = 2) OR
        sem3 != EXISTS (SELECT 1 FROM json_each(m.semesters) WHERE value = 3) OR
        sem4 != EXISTS (SELECT 1 FROM json_each(m.semesters) WHERE value = 4) OR
        ng_sem1 != EXISTS (SELECT 1 FROM json_each(coalesce(m.ng_semesters, '[]')) WHERE value = 1) OR
        ng_sem2 != EXISTS (SELECT 1 FROM json_each(coalesce(m.ng_semesters, '[]')) WHERE value = 2)`).all();
    expect(results[0].n).toBe(0);
    const sums = await env.DB.prepare('SELECT sum(sem1) + sum(sem2) + sum(sem3) + sum(sem4) AS s FROM modules').first('s');
    expect(sums).toBe(fixture.modules.reduce((a, m) => a + m.semesters.length, 0));
  });

  it('records schema 6 in meta', async () => {
    expect(await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema'").first('value')).toBe('6');
  });
});
