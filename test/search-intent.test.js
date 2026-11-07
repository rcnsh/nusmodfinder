// @ts-check
// 3B in /search (docs/plans/phase3.md 3B, docs/plans/phase3-prereg.md §3–§4)
// on the fixture corpus and the fixture bundle: pins, whole-query masks
// (partial codes, bare prefixes, XX N000, GE) by exact dense score and in code
// order without the dense half, the third RRF list, the GE pre-retrieval mask
// on both halves, noMatch, `interpreted` on every response, and `ignore`.
import { beforeAll, describe, expect, it } from 'vitest';
import { denseBundle } from '../src/dense.js';
import { exactSearch } from '../src/vector-bundle.js';
import { createFakes, hashEmbed } from './fakes.js';
import { adminCall, callJson, fixture, seed } from './helpers.js';

const PILLARS = ['GEA', 'GEC', 'GEH', 'GEI', 'GEN', 'GEQ', 'GES', 'GESS', 'GET', 'GEX'];
const STANDBY = { DENSE_BACKEND: 'vectorize' };
const letters = (/** @type {string} */ c) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(c))[0];
/** @returns {string[]} */
const codes = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);
const byCode = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
const fixtureCodes = fixture.modules.map((m) => m.code).sort(byCode);
const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
/** Fixture members of a partial code's range [P(+0), P:). @param {string} p */
const members = (p) => fixtureCodes.filter((c) => c >= (/\d$/.test(p) ? p : `${p}0`) && c < `${p}:`);
const pillarMembers = fixtureCodes.filter((c) => PILLARS.includes(letters(c)));
/** The exact dense order of `q` over the rows the constraints admit. @param {string} q @param {any} constraints @param {number} depth */
const denseOrder = (q, constraints, depth) => exactSearch(denseBundle(), hashEmbed(q), constraints, depth).map((h) => h.code);

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
  // The catalogue-only text a not-offered response names and embeds.
  const res = await adminCall('/admin/catalogue', fakes, {
    upsert: [{ code: 'GEQ1000', title: 'Asking Questions', description: 'How to ask good questions about the world.', acadYear: fixture.modules[0].acadYear }],
  });
  if (res.status !== 200) throw new Error(`catalogue seed: HTTP ${res.status}`);
});

describe('interpreted', () => {
  it('is on every response, with the eight keys in order', async () => {
    for (const path of ['/search?q=machine%20learning', '/search?q=machine%20learning&mode=lexical', '/search?q=CS9999', '/search?q=cs2']) {
      const { status, body } = await callJson(path, { fakes });
      expect(status, path).toBe(200);
      expect(Object.keys(body.interpreted), path).toEqual(['pin', 'prefix', 'ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
    }
    const { body } = await callJson('/search?q=machine%20learning', { fakes });
    expect(Object.values(body.interpreted).every((v) => v === null)).toBe(true);
    expect(body.noMatch).toBeUndefined();
  });
});

describe('pins', () => {
  it('a joined code pins at rank 1; several pin in query order; the rest fuse below them', async () => {
    const one = await callJson('/search?q=cs%201010s', { fakes });
    expect(one.body.interpreted.pin).toEqual(['CS1010S']);
    expect(codes(one.body)[0]).toBe('CS1010S');
    expect(codes(one.body).filter((c) => c === 'CS1010S')).toHaveLength(1);
    const two = await callJson('/search?q=cs1010%20or%20cs2030', { fakes });
    expect(two.body.interpreted.pin).toEqual(['CS1010', 'CS2030']);
    expect(codes(two.body).slice(0, 2)).toEqual(['CS1010', 'CS2030']);
    expect(two.body.count).toBe(20);
  });

  it('stay subject to the filters', async () => {
    const sem = [1, 2, 3, 4].find((s) => !moduleOf.get('CS1010S')?.semesters.includes(s));
    const { body } = await callJson(`/search?q=cs1010s&sem=${sem}`, { fakes });
    expect(body.interpreted.pin).toEqual(['CS1010S']);
    expect(codes(body)).not.toContain('CS1010S');
  });
});

describe('whole-query masks', () => {
  it('a partial code returns its members only, ordered by exact dense score', async () => {
    const { body } = await callJson('/search?q=cs2&topK=50', { fakes });
    expect(body.interpreted.prefix).toBe('CS2');
    expect(codes(body)).toEqual(denseOrder('cs2', { ranges: [['CS2', 'CS2:']] }, 50));
    expect([...codes(body)].sort(byCode)).toEqual(members('CS2'));
    expect(body.count).toBe(members('CS2').length);
  });

  it('a bare prefix never takes in a longer one: ges returns no GESS code, cs no CSA code', async () => {
    for (const mode of ['hybrid', 'lexical']) {
      const ges = await callJson(`/search?q=ges&topK=50&mode=${mode}`, { fakes });
      expect(ges.body.interpreted.prefix).toBe('GES');
      expect([...codes(ges.body)].sort(byCode), mode).toEqual(members('GES'));
      expect(codes(ges.body).some((c) => c.startsWith('GESS')), mode).toBe(false);
      const cs = await callJson(`/search?q=cs&topK=50&mode=${mode}`, { fakes });
      expect(cs.body.count, mode).toBe(Math.min(50, members('CS').length));
      expect(codes(cs.body).every((c) => /^CS\d/.test(c)), mode).toBe(true);
    }
    expect(members('GESS').length).toBeGreaterThan(0);
  });

  it('is in code order in mode=lexical, in the keyword-only fallback and under the Vectorize flip', async () => {
    const lexical = await callJson('/search?q=cs2&topK=50&mode=lexical', { fakes });
    expect(codes(lexical.body)).toEqual(members('CS2'));
    const failing = createFakes();
    failing.ai.throws('workers ai down');
    const fallback = await callJson('/search?q=cs2&topK=50', { fakes: failing });
    expect(fallback.body.degraded).toMatchObject({ source: 'workers-ai' });
    expect(codes(fallback.body)).toEqual(members('CS2'));
    const flip = await callJson('/search?q=cs2&topK=50', { fakes, env: STANDBY });
    expect(codes(flip.body)).toEqual(members('CS2'));
    // topK cuts the code order too.
    expect(codes((await callJson('/search?q=cs&topK=5&mode=lexical', { fakes })).body)).toEqual(members('CS').slice(0, 5));
  });

  it('XX N000 as the whole query is prefix ∩ level, with the level echoed', async () => {
    const { body } = await callJson('/search?q=cs%203000&topK=50', { fakes });
    expect(body.interpreted).toMatchObject({ prefix: 'CS', level: { min: 3, max: 3, source: ['level'] } });
    const want = members('CS').filter((c) => moduleOf.get(c)?.level === 3);
    expect(want.length).toBeGreaterThan(0);
    expect([...codes(body)].sort(byCode)).toEqual(want);
    const lexical = await callJson('/search?q=cs%203000&topK=50&mode=lexical', { fakes });
    expect(codes(lexical.body)).toEqual(want);
    // ignore=level drops the level, keeps the route.
    const all = await callJson('/search?q=cs%203000&topK=50&ignore=level', { fakes });
    expect(all.body.interpreted.level).toBeNull();
    expect([...codes(all.body)].sort(byCode)).toEqual(members('CS'));
  });

  it('a GE phrase as the whole query is the pillar mask, never Geography', async () => {
    const { body } = await callJson('/search?q=general%20education&topK=50', { fakes });
    expect(body.interpreted.ge).toEqual(PILLARS);
    expect(body.interpreted.prefix).toBeNull();
    expect([...codes(body)].sort(byCode)).toEqual(pillarMembers);
    expect(codes(body)).toEqual(denseOrder('general education', { ranges: PILLARS.map((p) => [`${p}0`, `${p}:`]) }, 50));
    expect(fixtureCodes.some((c) => /^GE\d/.test(c))).toBe(true);
  });

  it('still applies the filters', async () => {
    const m = moduleOf.get(members('CS2')[0]);
    const { body } = await callJson(`/search?q=cs2&topK=50&credits=${m?.credits}&level=2`, { fakes });
    expect(body.count).toBeGreaterThan(0);
    for (const c of codes(body)) expect(moduleOf.get(c)?.credits, c).toBe(m?.credits);
  });
});

describe('a code token inside a longer query: the third RRF list', () => {
  it('adds the prefix members by exact dense score, weight 1', async () => {
    // No lexical match, so the fusion is the dense list and the third list: rank 1 of each ties at 1/61.
    const q = 'cs3 zzqxv';
    const { body } = await callJson(`/search?q=${encodeURIComponent(q)}`, { fakes });
    expect(body.interpreted.prefix).toBe('CS3');
    expect(body.retrieval).toMatchObject({ lexical: 0, code: members('CS3').length });
    const first = denseOrder(q, { ranges: [['CS3', 'CS3:']] }, 1)[0];
    expect(codes(body).slice(0, 2)).toContain(first);
    for (const c of members('CS3')) expect(codes(body).slice(0, 6), c).toContain(c);
    // In mode=lexical the third list is in code order, fused with the (empty) lexical list.
    const lexical = await callJson(`/search?q=${encodeURIComponent(q)}&mode=lexical`, { fakes });
    expect(codes(lexical.body)).toEqual(members('CS3'));
  });

  it('carries an XX N000 level as a filter on every list', async () => {
    for (const mode of ['hybrid', 'lexical']) {
      const { body } = await callJson(`/search?q=cs3000%20machine%20learning&mode=${mode}`, { fakes });
      expect(body.interpreted.level, mode).toEqual({ min: 3, max: 3, source: ['level'] });
      expect(body.count, mode).toBeGreaterThan(0);
      for (const c of codes(body)) expect(moduleOf.get(c)?.level, `${mode} ${c}`).toBe(3);
    }
  });
});

describe('GE inside a longer query: a pre-retrieval mask', () => {
  const q = encodeURIComponent('GE module about society and culture');

  it('every result is a pillar member, in every mode and under the flip', async () => {
    for (const [mode, extra] of /** @type {const} */ ([['hybrid', {}], ['vector', {}], ['lexical', {}], ['hybrid', STANDBY]])) {
      const { body } = await callJson(`/search?q=${q}&mode=${mode}`, { fakes, env: extra });
      expect(body.interpreted.ge).toEqual(PILLARS);
      expect(body.count, `${mode} ${JSON.stringify(extra)}`).toBeGreaterThan(0);
      for (const c of codes(body)) expect(PILLARS, `${mode} ${c}`).toContain(letters(c));
    }
  });

  it('the dense half scores only pillar rows, so the page fills from them', async () => {
    const { body } = await callJson(`/search?q=${q}&mode=vector&topK=50`, { fakes });
    expect([...codes(body)].sort(byCode)).toEqual(pillarMembers);
  });

  it('ignore=ge undoes it', async () => {
    const { body } = await callJson(`/search?q=${q}&ignore=ge`, { fakes });
    expect(body.interpreted.ge).toBeNull();
    expect(codes(body).some((c) => !PILLARS.includes(letters(c)))).toBe(true);
  });
});

describe('noMatch', () => {
  it('an unknown code is count 0 with reason unknown-code, and embeds nothing', async () => {
    const f = createFakes();
    const { body } = await callJson('/search?q=CS9999', { fakes: f });
    expect(body).toMatchObject({ count: 0, results: [], noMatch: { reason: 'unknown-code', code: 'CS9999' } });
    expect(f.ai.calls).toHaveLength(0);
  });

  it('a not-offered code names its catalogue title and its dense neighbours, never in results', async () => {
    const f = createFakes();
    const { body } = await callJson('/search?q=GEQ1000', { fakes: f });
    const text = 'Asking Questions. How to ask good questions about the world.';
    expect(body).toMatchObject({ count: 0, results: [], noMatch: { reason: 'not-offered', code: 'GEQ1000', title: 'Asking Questions' } });
    expect(body.noMatch.related).toEqual(denseOrder(text, {}, 5));
    expect(f.ai.calls.map((c) => /** @type {any} */ (c.args[1]).text)).toEqual([[text]]);
    expect(body.interpreted.pin).toBeNull();
  });

  it('degrades to no neighbours when the embedding fails, and has none in mode=lexical', async () => {
    const failing = createFakes();
    failing.ai.throws('workers ai down');
    const down = await callJson('/search?q=GEQ1000', { fakes: failing });
    expect(down.body).toMatchObject({ count: 0, noMatch: { reason: 'not-offered', title: 'Asking Questions', related: [] }, degraded: { source: 'workers-ai' } });
    const lexical = await callJson('/search?q=GEQ1000&mode=lexical', { fakes });
    expect(lexical.body.noMatch).toMatchObject({ reason: 'not-offered', related: [] });
  });

  it('a catalogue-only code D1 does not hold still answers not-offered, with no title', async () => {
    const { body } = await callJson('/search?q=GEH1001', { fakes });
    expect(body).toMatchObject({ count: 0, noMatch: { reason: 'not-offered', code: 'GEH1001', title: null, related: [] } });
  });

  it('inside a longer query an unknown or catalogue-only code routes nothing', async () => {
    for (const q of ['CS 4400 Operating Systems', 'something like ACC1701X for engineers']) {
      const { body } = await callJson(`/search?q=${encodeURIComponent(q)}`, { fakes });
      expect(body.noMatch, q).toBeUndefined();
      expect(body.count, q).toBeGreaterThan(0);
      expect([body.interpreted.pin, body.interpreted.prefix], q).toEqual([null, null]);
    }
  });
});

describe('ignore', () => {
  it('rejects an unknown intent with a 400 naming it', async () => {
    const { status, body } = await callJson('/search?q=x&ignore=ge,banana', { fakes });
    expect(status).toBe(400);
    expect(body.message).toMatch(/banana/);
  });
});

describe('the bundle filter table is untouched', () => {
  it('still reads the 3-0 layout (no prefix id in the reserved slot)', () => {
    const b = denseBundle();
    expect(b.header.schema).toBe('vnm-vectors/1');
  });
});
