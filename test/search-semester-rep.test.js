// @ts-check
// The semester representative (ADR 0006, the duplicate-group collapse): when a request names a
// semester, a duplicate group stands as its highest-ranked member that passes
// the filters and is on NUSMods' timetable in that semester, falling back to
// the group's first-ranked passing member when none is. The group keeps its
// place; a pin is never swapped; with no semester, COLLAPSE_GROUPS=off, and
// for `related` nothing changes.
// Checked against the uncollapsed list (COLLAPSE_GROUPS=off) on every path:
// the bundle's hybrid and vector, D1 lexical, the Vectorize standby, and the
// mask route in dense and code order.
import { beforeAll, describe, expect, it } from 'vitest';
import groupsFile from './fixtures/groups.json';
import { parseGroupsFile } from '../src/groups.js';
import { callJson, fixture, seed } from './helpers.js';
import { recordingDb } from './regressions/support.js';

const OFF = { COLLAPSE_GROUPS: 'off' };
const STANDBY = { DENSE_BACKEND: 'vectorize' };
const PATHS = /** @type {const} */ ([['hybrid', {}], ['lexical', {}], ['vector', {}], ['hybrid', STANDBY]]);
const groupOf = parseGroupsFile(/** @type {any} */ (groupsFile));
const key = (/** @type {string} */ c) => groupOf.get(c) ?? c;
/** @returns {string[]} */
const codes = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);
/** @returns {string[]} */
const variantsOf = (/** @type {any} */ body, /** @type {string} */ code) =>
  (body.results.find((/** @type {any} */ r) => r.code === code)?.variants ?? []).map((/** @type {any} */ v) => v.code);

/**
 * The page the rule gives from the uncollapsed list (deep enough to hold every
 * passing member): the group-first projection, each group's first member
 * replaced by its first member in `off` offered in `sem` when the first is not.
 * @param {string[]} off @param {number | undefined} sem @param {Map<string, NormalisedModule>} moduleOf
 * @param {string[]} [pins]
 */
function expectedPage(off, sem, moduleOf, pins = []) {
  const offered = (/** @type {string} */ c) => sem !== undefined && (moduleOf.get(c)?.semesters ?? []).includes(sem);
  const seen = new Set();
  return off.filter((c) => (seen.has(key(c)) ? false : (seen.add(key(c)), true))).map((c) => {
    if (sem === undefined || pins.includes(c) || offered(c)) return c;
    return off.find((x) => key(x) === key(c) && offered(x)) ?? c;
  });
}

/**
 * Every path, with and without a semester, against the rule over the
 * uncollapsed list. Returns how many pages differ from the group-first projection.
 * @param {import('./fakes.js').Fakes} fakes @param {Map<string, NormalisedModule>} moduleOf
 * @param {string[]} queries @param {string} base the params besides q, mode and topK
 */
async function checkRule(fakes, moduleOf, queries, base) {
  let swapped = 0;
  for (const q of queries) {
    for (const sem of [1, 2, undefined]) {
      for (const [mode, extra] of PATHS) {
        const path = `/search?q=${encodeURIComponent(q)}&${base}${sem ? `&sem=${sem}` : ''}&mode=${mode}`;
        const on = await callJson(`${path}&topK=20`, { fakes, env: extra });
        const off = await callJson(`${path}&topK=50`, { fakes, env: { ...extra, ...OFF } });
        expect(on.status, path).toBe(200);
        const want = expectedPage(codes(off.body), sem, moduleOf).slice(0, 20);
        const where = `${path} ${JSON.stringify(extra)}`;
        expect(codes(on.body), where).toEqual(want);
        // Only representatives change: the group keys are the projection's, in order.
        const projected = expectedPage(codes(off.body), undefined, moduleOf).slice(0, 20);
        expect(codes(on.body).map(key), where).toEqual(projected.map(key));
        projected.forEach((c, i) => {
          const got = codes(on.body)[i];
          if (got === c) return;
          swapped++;
          expect(sem, where).toBeDefined();
          expect(moduleOf.get(c)?.semesters, `${where} ${c}`).not.toContain(sem);
          expect(moduleOf.get(got)?.semesters, `${where} ${got}`).toContain(sem);
          // The member it replaced is listed with the others.
          expect(variantsOf(on.body, got), where).toContain(c);
        });
      }
    }
  }
  return swapped;
}

describe('the fixture: NGN2001F (Sem 2 only) ranks above NGN2001G (Sem 1) in exchange mode', () => {
  const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
  /** @type {import('./fakes.js').Fakes} */
  let fakes;
  beforeAll(async () => { fakes = await seed(); });

  it('Sem 1 shows NGN2001G in NGN2001F\'s place, with NGN2001F as its variant; Sem 2 and no semester keep NGN2001F', async () => {
    const base = '/search?q=nus%20college&ng=1&study=ug2';
    const s1 = await callJson(`${base}&sem=1`, { fakes });
    const off = await callJson(`${base}&sem=1&topK=50`, { fakes, env: OFF });
    expect(codes(off.body).indexOf('NGN2001F')).toBeLessThan(codes(off.body).indexOf('NGN2001G'));
    const at = codes(s1.body).indexOf('NGN2001G');
    expect(at).toBe(expectedPage(codes(off.body), undefined, moduleOf).indexOf('NGN2001F'));
    expect(codes(s1.body)).not.toContain('NGN2001F');
    expect(s1.body.results[at].variants).toEqual([{ code: 'NGN2001F', credits: moduleOf.get('NGN2001F')?.credits }]);
    // The card is the shown member's own: its timetable and exchange status.
    expect(s1.body.results[at].semesters).toEqual([1]);
    for (const q of [`${base}&sem=2`, base]) {
      const { body } = await callJson(q, { fakes });
      expect(codes(body), q).toContain('NGN2001F');
      expect(codes(body), q).not.toContain('NGN2001G');
    }
  });

  it('every path follows the rule; outside exchange mode a semester filter leaves nothing to swap', async () => {
    const swapped = await checkRule(fakes, moduleOf, ['nus college', 'accounting', 'programming methodology', 'law seminar', 'cs1', 'ge'], 'ng=1&study=ug2');
    expect(swapped).toBeGreaterThan(0);
    // Without ng, `sem` filters on NUSMods' timetable, so every passing member is offered.
    expect(await checkRule(fakes, moduleOf, ['nus college', 'programming methodology', 'cs1'], 'study=ug2')).toBe(0);
  });

  it('a pinned code is never swapped', async () => {
    const { body } = await callJson('/search?q=NGN2001F&ng=1&study=ug2&sem=1', { fakes });
    expect(codes(body)[0]).toBe('NGN2001F');
    expect(codes(body)).not.toContain('NGN2001G');
    expect(variantsOf(body, 'NGN2001F')).toEqual(['NGN2001G']);
  });

  it('nor is any other code the query types: a 4th typed code is past the pin cap but stays', async () => {
    // The first three typed codes pin (and fail ng, so they are hidden); NGN2001F ranks like any result.
    for (const mode of ['lexical', 'hybrid']) {
      const { body } = await callJson(`/search?q=${encodeURIComponent('GEA1000 LL5004V PLS8002A NGN2001F global narratives')}&ng=1&study=ug2&sem=1&mode=${mode}&topK=50`, { fakes });
      expect(body.interpreted.pin, mode).toEqual(['GEA1000', 'LL5004V', 'PLS8002A']);
      expect(codes(body), mode).toContain('NGN2001F');
      expect(codes(body), mode).not.toContain('NGN2001G');
      expect(variantsOf(body, 'NGN2001F'), mode).toEqual(['NGN2001G']);
    }
  });

  it('COLLAPSE_GROUPS=off: the uncollapsed list, both members, no variants', async () => {
    const { body } = await callJson('/search?q=nus%20college&ng=1&study=ug2&sem=1', { fakes, env: OFF });
    expect(codes(body)).toEqual(expect.arrayContaining(['NGN2001F', 'NGN2001G']));
    for (const r of body.results) expect(r.variants).toBeUndefined();
  });

  it('still one variants read, with the columns a card needs when a semester can swap', async () => {
    /** @type {import('./regressions/support.js').DbCall[]} */
    const log = [];
    const { body } = await callJson('/search?q=nus%20college&ng=1&study=ug2&sem=1&topK=20', { fakes, env: { DB: recordingDb(log) } });
    expect(codes(body)).toContain('NGN2001G');
    const reads = log.filter((c) => c.sql.includes('WHERE code IN'));
    // The variants read: NGN2001F was the result, so it reads the group's other member.
    const variants = reads.filter((c) => { const b = /** @type {string[]} */ (c.binds); return b.includes('NGN2001G') && !b.includes('NGN2001F'); });
    expect(variants).toHaveLength(1);
    expect(variants[0].sql).toContain('SELECT code, title,');
    // It is the last read: the swapped-in card needs no read of its own.
    expect(reads.at(-1)).toBe(variants[0]);
  });
});

describe('an ACC1701X-shaped group: the first two members are off the Sem 1 timetable', () => {
  // ACC1701XA ranks first in the fixture; moved to Sem 2 only it is XB's twin, and only XC
  // (Sem 1), ranked after both, is on the Sem 1 timetable.
  const modules = fixture.modules.map((m) => (m.code === 'ACC1701XA' ? { ...m, semesters: [2] } : m));
  const moduleOf = new Map(modules.map((m) => [m.code, m]));
  /** @type {import('./fakes.js').Fakes} */
  let fakes;
  beforeAll(async () => { fakes = await seed({ modules }); });

  it('Sem 1 shows ACC1701XC in the group\'s place, XA and XB as its variants', async () => {
    for (const [mode, extra] of PATHS) {
      const path = `/search?q=intro%20accounting&ng=1&study=ug2&sem=1&mode=${mode}`;
      const off = await callJson(`${path}&topK=50`, { fakes, env: { ...extra, ...OFF } });
      expect(codes(off.body).filter((c) => key(c) === key('ACC1701XA'))[0], path).not.toBe('ACC1701XC');
      const { body } = await callJson(path, { fakes, env: extra });
      const at = expectedPage(codes(off.body), undefined, moduleOf).indexOf(codes(off.body).filter((c) => key(c) === key('ACC1701XA'))[0]);
      expect(codes(body)[at], `${path} ${JSON.stringify(extra)}`).toBe('ACC1701XC');
      expect(variantsOf(body, 'ACC1701XC'), path).toEqual(['ACC1701XA', 'ACC1701XB']);
    }
  });

  it('every path follows the rule, the mask route included', async () => {
    const swapped = await checkRule(fakes, moduleOf, ['intro accounting', 'accounting', 'acc', 'acc1'], 'ng=1&study=ug2');
    expect(swapped).toBeGreaterThan(0);
    // "acc" is a whole-query prefix: the mask route, by dense score and (lexical) in code order.
    for (const mode of ['hybrid', 'lexical']) {
      const { body } = await callJson(`/search?q=acc&ng=1&study=ug2&sem=1&mode=${mode}`, { fakes });
      expect(body.interpreted.prefix, mode).toBe('ACC');
      expect(codes(body), mode).toContain('ACC1701XC');
      expect(variantsOf(body, 'ACC1701XC'), mode).toEqual(['ACC1701XA', 'ACC1701XB']);
    }
  });

  it('a pinned ACC1701XA stays, though XC is offered', async () => {
    const { body } = await callJson('/search?q=ACC1701XA&ng=1&study=ug2&sem=1', { fakes });
    expect(codes(body)[0]).toBe('ACC1701XA');
    expect(codes(body)).not.toContain('ACC1701XC');
    expect(variantsOf(body, 'ACC1701XA')).toEqual(['ACC1701XB', 'ACC1701XC']);
  });
});
