// @ts-check
// Constraint intents in /search: the explicit params `exam=0`,
// `su=1`, `hoursBelow=N` and `prereq=none` are hard filters in SQL, in the
// bundle's filter table and on every hydrated dense row, in every mode and
// route, on results, pins, duplicate-group variants and a not-offered code's neighbours.
// Each param joins the cache key. Phrases in q are read too (PARSE_PHRASES,
// ADR 0003 and ADR 0006).
import { beforeAll, describe, expect, it } from 'vitest';
import { INTENT, PARSE_PHRASES } from '../src/intents.js';
import { searchCacheKey } from '../src/search.js';
import { BASE, adminCall, callJson, fixture, seed } from './helpers.js';

const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
const CSCU = 'Completed Satisfactory/Unsatisfactory';
/**
 * Whether a module satisfies a constraint, stated independently of src/.
 * @param {NormalisedModule} m @param {string} param @param {number} [sem]
 */
function satisfies(m, param, sem) {
  if (param === 'exam=0') return sem !== undefined ? !m.examSemesters.includes(sem) : m.examSemesters.length === 0;
  if (param === 'su=1') return m.su || m.gradingBasis === CSCU;
  if (param.startsWith('hoursBelow=')) return m.workloadHours !== null && m.workloadHours < Number(param.split('=')[1]);
  if (param === 'prereq=none') return INTENT.prereq === 'i' ? m.prereqNone : m.prereqNone || m.prereqCohortOnly;
  throw new Error(param);
}
/**
 * Every code the page shows: results and their variants.
 * @param {any} body
 * @returns {string[]}
 */
const shown = (body) => body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);
const PARAMS = ['exam=0', 'su=1', 'hoursBelow=10', 'prereq=none'];

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
  // A not-offered code, whose `related` neighbours are dense hits too.
  const res = await adminCall('/admin/catalogue', fakes, {
    upsert: [{ code: 'GEQ1000', title: 'Asking Questions', description: 'How to ask good questions about the world.', acadYear: fixture.modules[0].acadYear }],
  });
  if (res.status !== 200) throw new Error(`catalogue seed: HTTP ${res.status}`);
});

describe('several levels or unit counts', () => {
  it('level=a,b and credits=a,b match any of their values, in every mode and on the standby, echoed as a sorted list', async () => {
    for (const [extra, env] of /** @type {const} */ ([['', {}], ['&mode=lexical', {}], ['&mode=vector', {}], ['', { DENSE_BACKEND: 'vectorize' }]])) {
      const path = `/search?q=introduction&topK=50&level=2,1,2&credits=4,2${extra}`;
      const { status, body } = await callJson(path, { fakes, env });
      expect(status, path).toBe(200);
      expect(body.filters, path).toEqual({ level: [1, 2], credits: [2, 4] });
      const codes = shown(body);
      expect(codes.length, path).toBeGreaterThan(0);
      for (const c of codes) {
        const m = /** @type {NormalisedModule} */ (moduleOf.get(c));
        expect([1, 2].includes(/** @type {number} */ (m.level)) && [2, 4].includes(/** @type {number} */ (m.credits)), `${path} ${c}`).toBe(true);
      }
      // Both levels appear: the list is an OR, not the last value.
      if (!extra) expect(new Set(codes.map((c) => moduleOf.get(c)?.level)), path).toEqual(new Set([1, 2]));
    }
  });

  it('one value echoes as a number; a list shares its cache key with any spelling of it', async () => {
    const { body } = await callJson('/search?q=introduction&level=3,3', { fakes });
    expect(body.filters).toEqual({ level: 3 });
    const key = (/** @type {string} */ qs) => searchCacheKey(`${BASE}/search?q=x&${qs}`)?.url;
    expect(key('level=2,1')).toBe(key('level=1,2'));
    expect(key('level=1,1')).toBe(key('level=1'));
  });

  it('rejects a list with an empty or invalid part', async () => {
    for (const bad of ['level=1,', 'level=1,9', 'level=,', 'credits=4,x', 'credits=-1,4']) {
      const { status } = await callJson(`/search?q=introduction&${bad}`, { fakes });
      expect(status, bad).toBe(400);
    }
  });
});

describe('explicit params', () => {
  it('each is a hard filter in every mode and on the standby, and is echoed in `filters`', async () => {
    for (const param of PARAMS) {
      for (const [extra, env] of /** @type {const} */ ([['', {}], ['&mode=lexical', {}], ['&mode=vector', {}], ['', { DENSE_BACKEND: 'vectorize' }]])) {
        const path = `/search?q=introduction&topK=50&${param}${extra}`;
        const { status, body } = await callJson(path, { fakes, env });
        expect(status, path).toBe(200);
        expect(body.count, path).toBeGreaterThan(0);
        const [k, v] = param.split('=');
        expect(body.filters[k], path).toBe(k === 'prereq' ? v : Number(v));
        for (const c of shown(body)) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), param), `${path} ${c}`).toBe(true);
      }
    }
  });

  it('exam=0 with sem=N means no exam in semester N', async () => {
    const { body } = await callJson('/search?q=introduction&topK=50&exam=0&sem=1', { fakes });
    expect(body.count).toBeGreaterThan(0);
    for (const c of shown(body)) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), 'exam=0', 1), c).toBe(true);
    // Some result has an exam in another semester: the rule is per selected semester.
    expect(shown(body).some((c) => (moduleOf.get(c)?.examSemesters.length ?? 0) > 0)).toBe(true);
  });

  it('rejects a value outside its form', async () => {
    for (const bad of ['exam=1', 'su=0', 'hoursBelow=0', 'hoursBelow=100', 'hoursBelow=x', 'prereq=some']) {
      const { status, body } = await callJson(`/search?q=introduction&${bad}`, { fakes });
      expect(status, bad).toBe(400);
      expect(body.message, bad).toMatch(new RegExp(bad.split('=')[0]));
    }
  });
});

describe('phrases in q (PARSE_PHRASES on)', () => {
  it('are read as their constraint intent, and ignore= undoes each one', async () => {
    expect(PARSE_PHRASES).toBe(true);
    for (const [q, key] of [['introduction without final exam', 'exam'], ['introduction s/u', 'su'], ['introduction light workload', 'hoursBelow'], ['introduction no prerequisites', 'prereq']]) {
      const { body } = await callJson(`/search?q=${encodeURIComponent(q)}&topK=50`, { fakes });
      expect(body.interpreted[key], q).not.toBeNull();
      const undone = await callJson(`/search?q=${encodeURIComponent(q)}&topK=50&ignore=${key}`, { fakes });
      expect(undone.body.interpreted[key], `${q} ignore=${key}`).toBeNull();
    }
  });
});

describe('explicit params on masks and pins', () => {
  it('filter mask members, and a pinned code that fails the param is not pinned', async () => {
    const mask = await callJson('/search?q=cs2&topK=50&exam=0', { fakes });
    expect(mask.body.interpreted.prefix).toBe('CS2');
    expect(mask.body.count).toBeGreaterThan(0);
    for (const c of shown(mask.body)) {
      expect(c.startsWith('CS2'), c).toBe(true);
      expect(moduleOf.get(c)?.examSemesters, c).toEqual([]);
    }
    expect(moduleOf.get('CS1010S')?.examSemesters.length).toBeGreaterThan(0);
    const pin = await callJson('/search?q=cs1010s&exam=0', { fakes });
    expect(pin.body.interpreted.pin).toEqual(['CS1010S']);
    expect(shown(pin.body)).not.toContain('CS1010S');
  });
});

describe('a not-offered code\'s related neighbours', () => {
  it('hold every constraint param on the bundle and on the standby', async () => {
    for (const [q, param] of [['GEQ1000&exam=0', 'exam=0'], ['GEQ1000&su=1', 'su=1'], ['GEQ1000&hoursBelow=10', 'hoursBelow=10'],
      ['GEQ1000&prereq=none', 'prereq=none']]) {
      for (const env of [{}, { DENSE_BACKEND: 'vectorize' }]) {
        const { body } = await callJson(`/search?q=${q}`, { fakes, env });
        const where = `${q} ${env.DENSE_BACKEND ?? 'bundle'}`;
        expect(body.noMatch?.reason, where).toBe('not-offered');
        expect(body.noMatch.related.length, where).toBeGreaterThan(0);
        for (const c of body.noMatch.related) expect(satisfies(/** @type {NormalisedModule} */ (moduleOf.get(c)), param), `${where} ${c}`).toBe(true);
      }
    }
  });
});

describe('the cache key (beside the canonical-key tests in test/regressions/backend.test.js)', () => {
  it('each param changes the key; spelling and order do not', () => {
    const key = (/** @type {string} */ qs) => searchCacheKey(`${BASE}/search?q=x${qs}`)?.url;
    const plain = key('');
    for (const param of PARAMS) expect(key(`&${param}`), param).not.toBe(plain);
    expect(key('&hoursBelow=8')).not.toBe(key('&hoursBelow=9'));
    expect(key('&su=1&exam=0')).toBe(key('&exam=0&su=1'));
    expect(key('&ignore=su,exam')).toBe(key('&ignore=exam,su'));
  });
});
