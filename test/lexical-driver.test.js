// @ts-check
// The filter-driven plan in src/lexical.js walks the index of the most
// selective filter. Without sqlite_stat1, SQLite picks among equality indexes
// by creation order, so with two or more filters it used to drive from
// idx_modules_credits (credits=4: 5,081 rows on the full corpus) instead of,
// say, faculty=Computing (315). The plan does not depend on the data here
// (no stat1), so the fixture database shows the same choice as the full one.
import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXED_DRIVER_ORDER, chooseDriver, exactStatement, filterSql, lexicalSearch, loadFilterCounts, parseFilterCounts, resetFilterCounts,
} from '../src/lexical.js';
import { Trace } from '../src/timing.js';
import { fixture, seed } from './helpers.js';

/** @typedef {import('../src/search.js').FilterEcho} FilterEcho */
/** @typedef {import('../src/lexical.js').FilterKey} FilterKey */

/** The index each filter drives through (0001, 0003, 0006). */
const INDEX = {
  faculty: 'idx_modules_faculty', ng: 'idx_modules_ng', level: 'idx_modules_level',
  credits: 'idx_modules_credits',
};

/** @param {FilterEcho} echo @param {FilterKey} [driver] */
async function plan(echo, driver) {
  const { sql, binds } = exactStatement(echo, driver);
  const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind('"in"', ...binds, 50).all();
  return results.map((r) => String(r.detail)).filter((d) => /\bm\b/.test(d));
}

/** @type {any} */
let facets;

beforeAll(async () => {
  await seed({ facets: true });
  facets = JSON.parse(/** @type {string} */ (await env.DB.prepare("SELECT value FROM meta WHERE key = 'facets'").first('value')));
});
beforeEach(() => resetFilterCounts());

describe('facets row counts', () => {
  it('has a count for every credits value, semester and NG semester', () => {
    const count = (/** @type {(m: NormalisedModule) => boolean} */ p) => fixture.modules.filter(p).length;
    const credits = [...new Set(fixture.modules.map((m) => m.credits).filter((c) => c !== null))].sort((a, b) => Number(a) - Number(b));
    expect(facets.credits).toEqual(credits.map((c) => ({ credits: c, count: count((m) => m.credits === c) })));
    expect(facets.semesters).toEqual([1, 2, 3, 4].map((sem) => ({ sem, count: count((m) => m.semesters.includes(sem)) })));
    expect(facets.ngSemesters).toEqual([1, 2].map((sem) => ({ sem, count: count((m) => (m.ngSemesters ?? []).includes(sem)) })));
    expect(parseFilterCounts(facets)).not.toBeNull();
  });

  it('a row without counts is not cached: a facets rebuild is picked up without a new isolate (PR #8 review round 2)', async () => {
    const put = (/** @type {unknown} */ v) => env.DB.prepare("UPDATE meta SET value = ? WHERE key = 'facets'").bind(JSON.stringify(v)).run();
    const old = { ...facets };
    delete old.credits;
    delete old.semesters;
    delete old.ngSemesters;
    try {
      await put(old);
      expect(await loadFilterCounts(env.DB, new Trace())).toBeNull();
      await put(facets); // POST /admin/facets after the deploy
      expect(await loadFilterCounts(env.DB, new Trace())).toEqual(parseFilterCounts(facets));
      // Found counts are cached: a later row change is not re-read.
      await put(old);
      expect(await loadFilterCounts(env.DB, new Trace())).toEqual(parseFilterCounts(facets));
    } finally {
      await put(facets);
    }
  });

  it('a row without them (written before they existed) parses to null', () => {
    const old = { ...facets };
    delete old.credits;
    expect(parseFilterCounts(old)).toBeNull();
    expect(parseFilterCounts(null)).toBeNull();
  });
});

describe('chooseDriver', () => {
  const counts = parseFilterCounts({
    faculties: [{ name: 'Computing', count: 315 }, { name: 'Arts and Social Science', count: 1363 }],
    levels: [{ level: 5, count: 2713 }, { level: 8, count: 6 }],
    credits: [{ credits: 4, count: 5081 }, { credits: 8, count: 354 }],
    semesters: [{ sem: 1, count: 4250 }, { sem: 3, count: 284 }],
    ng: { count: 1175 },
  });

  it.each(/** @type {[FilterEcho, FilterKey | undefined][]} */ ([
    [{ faculty: 'Computing', credits: 4 }, 'faculty'],
    [{ faculty: 'Arts and Social Science', credits: 8 }, 'credits'],
    [{ level: 5, ng: true }, 'ng'],
    [{ level: 8, faculty: 'Computing', credits: 4, ng: true, sem: 3 }, 'level'],
    [{ sem: 1, credits: 8 }, 'credits'],
    [{ sem: 1, ng: true }, 'ng'],
    [{ sem: 1 }, undefined],
    [{ faculty: 'No Such Faculty', level: 8 }, 'faculty'],
    [{ level: 5, ng: false }, 'level'],
  ]))('%j drives from %s', (echo, want) => {
    expect(chooseDriver(echo, counts)).toBe(want);
  });

  it('without counts follows FIXED_DRIVER_ORDER', () => {
    expect(FIXED_DRIVER_ORDER).toEqual(['sem', 'faculty', 'ng', 'level', 'credits']);
    expect(chooseDriver({ credits: 4, level: 5 }, null)).toBe('level');
    expect(chooseDriver({ credits: 4, faculty: 'Computing', ng: true }, null)).toBe('faculty');
    expect(chooseDriver({ sem: 1, credits: 4 }, null)).toBe('credits');
    expect(chooseDriver({ sem: 4, faculty: 'Computing' }, null)).toBe('sem');
  });

  it('filterSql disables every index but the driver\'s with unary plus', () => {
    const echo = { sem: 3, level: 4, credits: 4, faculty: 'Computing', ng: true };
    expect(filterSql(echo, 'faculty').clauses).toEqual(['+m.sem3 = 1', '+m.level = ?', '+m.credits = ?', 'm.faculty = ?', '+m.ng = 1']);
    expect(filterSql(echo).clauses).toEqual(['m.sem3 = 1', 'm.level = ?', 'm.credits = ?', 'm.faculty = ?', 'm.ng = 1']);
  });
});

describe('the filter-driven plan', () => {
  it('without a driver, SQLite drives faculty+credits from the credits index (the bug)', async () => {
    expect(await plan({ faculty: 'Computing', credits: 4 })).toEqual(['SEARCH m USING INDEX idx_modules_credits (credits=?)']);
  });

  /** Every multi-filter shape, each filter in turn as the driver. */
  const SHAPES = /** @type {FilterEcho[]} */ ([
    { faculty: 'Computing', credits: 4 }, { credits: 4, level: 5 }, { faculty: 'Computing', level: 4 },
    { level: 1, ng: true }, { credits: 4, ng: true }, { faculty: 'Computing', ng: true }, { sem: 3, credits: 4 },
    { sem: 4, level: 5, faculty: 'Computing' }, { credits: 4, faculty: 'Computing', level: 3, ng: true, sem: 3 },
  ]);
  const cases = SHAPES.flatMap((echo) => /** @type {FilterKey[]} */ (Object.keys(echo)).map((driver) => /** @type {[FilterEcho, FilterKey]} */ ([echo, driver])));

  it.each(cases)('%j with driver %s walks only that index', async (echo, driver) => {
    const want = driver === 'sem'
      ? `SEARCH m USING INDEX idx_modules_sem${echo.sem} (sem${echo.sem}=?)`
      : `SEARCH m USING INDEX ${INDEX[driver]} (${driver}=?)`;
    expect(await plan(echo, driver)).toEqual([want]);
  });
});

describe('counts are read only on the filter-driven path', () => {
  it('a filtered search answered by the bounded pass is one D1 query and never reads the facets row', async () => {
    for (const echo of [{ sem: 1 }, { sem: 1, ng: true }, { credits: 4, level: 2 }]) {
      const trace = new Trace();
      const codes = await lexicalSearch(env.DB, 'programming', echo, 5, trace);
      expect(codes).toHaveLength(5);
      expect(trace.d1.queries).toBe(1);
    }
  });
});
