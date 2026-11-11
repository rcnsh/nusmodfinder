// @ts-check
// Phase 4 exchange mode in /search on the fixture (docs/plans/phase4.md §2,
// 4A, 4C): `study` is required with ng=1; every path (D1 lexical, the
// bundle, the Vectorize standby, pins, mask routes, 3F variants, a
// not-offered code's `related`) shows exactly the modules the independent
// oracle (test/sc1/oracle.node.mjs) calls open or noted for (sem, study);
// a zero ng_allow is closed on every path; cards carry the bit's reasons.
// The whole-corpus set equality per path is test/sc1/paths.test.js.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { bitOf } from '../src/ng-bit.js';
import { reasonsFor } from '../src/ng-reasons.js';
import { searchCacheKey } from '../src/search.js';
import { levelNoteOf, oracle, oracleShown, yearNoteOf } from './sc1/oracle.node.mjs';
import { BASE, adminCall, callJson, fixture, seed } from './helpers.js';

const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
/** @type {import('../src/ng-bit.js').Study[]} */
const STUDIES = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
/** @type {[string, 1 | 2 | 'any'][]} */
const SEMS = [['&sem=1', 1], ['&sem=2', 2], ['', 'any']];

/** Whether the oracle shows `code` for (sem, study). @param {string} code @param {1 | 2 | 'any'} sem @param {import('../src/ng-bit.js').Study} study */
const shownByOracle = (code, sem, study) => oracle(/** @type {NormalisedModule} */ (moduleOf.get(code)), { sem, study }) !== 'closed';
/** Every code the page shows: results and their variants. @param {any} body @returns {string[]} */
const shown = (body) => body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);
const ROUTES = /** @type {const} */ ([['', {}], ['&mode=lexical', {}], ['&mode=vector', {}], ['', { DENSE_BACKEND: 'vectorize' }]]);

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
  const res = await adminCall('/admin/catalogue', fakes, {
    upsert: [{ code: 'GEQ1000', title: 'Asking Questions', description: 'How to ask good questions about programming and machine learning.', acadYear: fixture.modules[0].acadYear }],
  });
  if (res.status !== 200) throw new Error(`catalogue seed: HTTP ${res.status}`);
});

describe('the study parameter (4C)', () => {
  it('is required with ng=1: 400 study-required, before any binding is touched', async () => {
    for (const qs of ['&ng=1', '&ng=1&sem=1', '&ng=true&study=']) {
      const before = fakes.ai.calls.length;
      const { status, body } = await callJson(`/search?q=machine%20learning${qs}`, { fakes });
      expect(status, qs).toBe(400);
      expect(body.error, qs).toBe('study-required');
      expect(body.message, qs).toMatch(/ug1\|ug2\|ug3\|ug4\|grad/);
      expect(fakes.ai.calls.length, qs).toBe(before);
    }
  });

  it('rejects an unknown study level; is ignored and not echoed without ng', async () => {
    const bad = await callJson('/search?q=x&ng=1&study=phd', { fakes });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_request');
    const plain = await callJson('/search?q=machine%20learning&study=ug2&mode=lexical', { fakes });
    expect(plain.status).toBe(200);
    expect(plain.body.filters).toEqual({});
    expect(searchCacheKey(`${BASE}/search?q=x&study=ug2`)?.url).toBe(searchCacheKey(`${BASE}/search?q=x`)?.url);
  });

  it('is echoed under ng and joins the cache key; sem 1 and sem 2 are different keys', async () => {
    const { body } = await callJson('/search?q=machine%20learning&ng=1&study=ug3&sem=2&mode=lexical', { fakes });
    expect(body.filters).toEqual({ ng: true, study: 'ug3', sem: 2 });
    const key = (/** @type {string} */ qs) => searchCacheKey(`${BASE}/search?q=x${qs}`)?.url;
    expect(key('&ng=1&study=ug2&sem=1')).not.toBe(key('&ng=1&study=ug2&sem=2'));
    expect(key('&ng=1&study=ug2')).not.toBe(key('&ng=1&study=ug3'));
    expect(key('&study=ug2&ng=1')).toBe(key('&ng=1&study=ug2'));
  });

  it('ng=1 in a special term answers no courses, saying the NG list has no special-term data', async () => {
    for (const sem of [3, 4]) {
      const { status, body } = await callJson(`/search?q=machine%20learning&ng=1&study=ug2&sem=${sem}`, { fakes });
      expect(status).toBe(200);
      expect(body).toMatchObject({ count: 0, results: [], noMatch: { reason: 'ng-special-term' } });
    }
  });
});

describe('every path shows exactly what the oracle shows (4A)', () => {
  it('results and variants, in every mode and on the standby, for all 15 (sem, study)', async () => {
    let checked = 0;
    for (const [semQs, sem] of SEMS) {
      for (const study of STUDIES) {
        for (const [extra, envOver] of ROUTES) {
          for (const q of ['machine learning', 'introduction', 'programming']) {
            const path = `/search?q=${encodeURIComponent(q)}&ng=1&study=${study}${semQs}&topK=50${extra}`;
            const { status, body } = await callJson(path, { fakes, env: envOver });
            expect(status, path).toBe(200);
            for (const c of shown(body)) expect(shownByOracle(c, sem, study), `${path} ${c}`).toBe(true);
            checked += shown(body).length;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('pins: a code search shows the code exactly when the oracle does', async () => {
    const codes = ['CS3244', 'CG3201', 'PC3270', 'LI5202', 'AR5221', 'CS1010S', 'LAK1201'];
    for (const code of codes) {
      for (const [semQs, sem] of SEMS) {
        for (const study of STUDIES) {
          const path = `/search?q=${code}&ng=1&study=${study}${semQs}&mode=lexical`;
          const { body } = await callJson(path, { fakes });
          expect(shown(body).includes(code), path).toBe(shownByOracle(code, sem, study));
        }
      }
    }
  });

  it('a mask route (a bare prefix) holds the bit on the bundle and in code order', async () => {
    for (const [extra, envOver] of ROUTES) {
      const path = `/search?q=CS&ng=1&study=ug2&sem=1&topK=50${extra}`;
      const { body } = await callJson(path, { fakes, env: envOver });
      expect(body.interpreted.prefix, path).not.toBeNull();
      for (const c of shown(body)) expect(shownByOracle(c, 1, 'ug2'), `${path} ${c}`).toBe(true);
    }
  });

  it('a not-offered code\'s related neighbours hold the bit on the bundle and on the standby', async () => {
    for (const envOver of [{}, { DENSE_BACKEND: 'vectorize' }]) {
      for (const study of /** @type {const} */ (['ug1', 'grad'])) {
        const { body } = await callJson(`/search?q=GEQ1000&ng=1&study=${study}&sem=1`, { fakes, env: envOver });
        const where = `${study} ${envOver.DENSE_BACKEND ?? 'bundle'}`;
        expect(body.noMatch?.reason, where).toBe('not-offered');
        expect(body.noMatch.related.length, where).toBeGreaterThan(0);
        for (const c of body.noMatch.related) expect(shownByOracle(c, 1, study), `${where} ${c}`).toBe(true);
      }
    }
  });

  it('sem under ng tests the NG semester, not NUSMods\': PC3270 (NG Sem 1, NUSMods Sem 2) shows in Sem 1 with a note', async () => {
    const pc = /** @type {NormalisedModule} */ (moduleOf.get('PC3270'));
    expect(pc).toMatchObject({ semesters: [2], ngSemesters: [1] });
    const s1 = await callJson('/search?q=PC3270&ng=1&study=ug2&sem=1&mode=lexical', { fakes });
    const card = s1.body.results.find((/** @type {any} */ r) => r.code === 'PC3270');
    expect(card.exchange.status).toBe('note');
    expect(card.exchange.reasons.map((/** @type {any} */ r) => r.id)).toContain('ng-list:nusmods-semester-differs');
    const s2 = await callJson('/search?q=PC3270&ng=1&study=ug2&sem=2&mode=lexical', { fakes });
    expect(shown(s2.body)).not.toContain('PC3270');
  });
});

describe('a zero ng_allow is closed on every path (plan §2 "Storage")', () => {
  it('a module whose D1 row has ng_allow 0 disappears from results, pins, the standby and the bundle\'s dense rows', async () => {
    await seed();
    const path = (/** @type {string} */ q, /** @type {string} */ extra) => `/search?q=${q}&ng=1&study=ug3&sem=2&topK=50${extra}`;
    const before = await callJson(path('machine%20learning', '&mode=vector'), { fakes });
    expect(shown(before.body)).toContain('CS3244');
    // The bundle still has CS3244's bit; D1, the source of truth, now says closed.
    await env.DB.prepare('UPDATE modules SET ng_allow = 0 WHERE code = ?').bind('CS3244').run();
    try {
      for (const [q, extra, envOver] of /** @type {[string, string, Record<string, string>][]} */ ([
        ['machine%20learning', '', {}], ['machine%20learning', '&mode=lexical', {}], ['machine%20learning', '&mode=vector', {}],
        ['machine%20learning', '', { DENSE_BACKEND: 'vectorize' }], ['CS3244', '', {}], ['CS32', '', {}],
      ])) {
        const { body } = await callJson(path(q, extra), { fakes, env: envOver });
        expect(shown(body), `${q}${extra} ${envOver.DENSE_BACKEND ?? ''}`).not.toContain('CS3244');
      }
    } finally {
      await seed();
    }
  });
});

describe('result cards and /module/:code (4C)', () => {
  it('a card in exchange mode carries its bit\'s status and reasons; outside exchange mode none', async () => {
    const ug2 = await callJson('/search?q=CG3201&ng=1&study=ug2&sem=2&mode=lexical', { fakes });
    const cg = ug2.body.results.find((/** @type {any} */ r) => r.code === 'CG3201');
    expect(cg.exchange).toEqual({ status: 'note', reasons: reasonsFor(['3-soc-cg:elsewhere']) });
    expect(cg.exchange.reasons[0].text).toMatch(/School of Computing/);
    const plain = await callJson('/search?q=CG3201&mode=lexical', { fakes });
    expect(plain.body.results[0].exchange).toBeUndefined();
  });

  it('/module/:code answers all 15 (sem, study) with the reasons, matching the oracle', async () => {
    for (const code of ['CS3244', 'LI5202', 'PC3270', 'AR5221']) {
      const { body } = await callJson(`/module/${code}`);
      expect(body.exchange).toHaveLength(15);
      for (const e of body.exchange) {
        const want = oracle(/** @type {NormalisedModule} */ (moduleOf.get(code)), { sem: e.sem, study: e.study });
        expect(e.status === 'closed', `${code} ${e.sem} ${e.study}`).toBe(want === 'closed');
        expect(e.status === 'closed' ? e.reasons.length > 0 : true).toBe(true);
        expect((body.ng_allow & bitOf(e.sem, e.study)) !== 0).toBe(e.status !== 'closed');
      }
    }
  });

  it('an id the reason texts don\'t know gets a generic text, never an error', () => {
    expect(reasonsFor(['no-such-rule'])).toEqual([{ id: 'no-such-rule', kind: 'unknown', text: expect.stringMatching(/can't show the rule/) }]);
  });

  it('/facets names the exchange-mode sources with their dates', async () => {
    const { body } = await callJson('/facets');
    expect(body.ngSources.map((/** @type {any} */ s) => s.updatedAsAt)).toEqual(['01 Sep 2026', '31 Aug 2026']);
  });
});

describe('R3 (ADR 0008): the year-of-study note, read from the prerequisite on every path', () => {
  // ESE3101: on the NG list for Sem 2; its prerequisite binds every undergraduate to Year 2, 3 or 4.
  const ese = /** @type {NormalisedModule} */ (moduleOf.get('ESE3101'));
  const YEAR = 'prereq:year-of-study';
  /** @param {any} e */
  const ids = (e) => (e?.reasons ?? []).map((/** @type {any} */ r) => r.id);

  it('the fixture has the case: the oracle opens ESE3101 in Sem 2 to every year, and R3 notes it for a 1st-year only', () => {
    expect(ese.prerequisite).toMatch(/must be Year 2,3 or 4/);
    for (const study of STUDIES) expect(oracle(ese, { sem: 2, study }), study).toBe('open');
    expect(STUDIES.map((study) => yearNoteOf(ese, study) !== null)).toEqual([true, false, false, false, false]);
  });

  it('a 1st-year sees it open with the note on the pin, the bundle, a vector search, the standby and the mask route; a 2nd-year and a graduate without', async () => {
    for (const study of STUDIES) {
      for (const [q, extra, envOver] of /** @type {[string, string, Record<string, string>][]} */ ([
        ['ESE3101', '&mode=lexical', {}], ['resource management circular economy', '', {}],
        ['resource management circular economy', '&mode=vector', {}], ['resource management circular economy', '', { DENSE_BACKEND: 'vectorize' }],
        ['ESE3', '', {}],
      ])) {
        const path = `/search?q=${encodeURIComponent(q)}&ng=1&study=${study}&sem=2&topK=50${extra}`;
        const { body } = await callJson(path, { fakes, env: envOver });
        const card = body.results.find((/** @type {any} */ r) => r.code === 'ESE3101');
        const where = `${path} ${envOver.DENSE_BACKEND ?? ''}`;
        expect(card, where).toBeDefined();
        expect(card.exchange.status, where).toBe(oracleShown(ese, { sem: 2, study }));
        expect(ids(card.exchange).includes(YEAR), where).toBe(study === 'ug1');
      }
    }
  });

  it('the note\'s text names the years and the next step, after the stored reasons', async () => {
    const { body } = await callJson('/search?q=ESE3101&ng=1&study=ug1&sem=2&mode=lexical', { fakes });
    const card = body.results.find((/** @type {any} */ r) => r.code === 'ESE3101');
    expect(card.exchange).toEqual({
      status: 'note',
      reasons: [{ id: YEAR, kind: 'year', text: 'NUS lists this course for Year 2, 3 or 4 students. Ask the department whether your year of study during your exchange counts.' }],
    });
    // The prerequisite itself is not part of a card.
    expect(card.prerequisite).toBeUndefined();
  });

  it('exchangeBySem: with no semester, Sem 2 carries the note and Sem 1 stays closed without it', async () => {
    const { body } = await callJson('/search?q=ESE3101&ng=1&study=ug1&mode=lexical', { fakes });
    const card = body.results.find((/** @type {any} */ r) => r.code === 'ESE3101');
    expect(card.exchange.status).toBe(oracleShown(ese, { sem: 'any', study: 'ug1' }));
    expect(ids(card.exchange)).toContain(YEAR);
    expect(card.exchangeBySem[2].status).toBe('note');
    expect(ids(card.exchangeBySem[2])).toEqual([YEAR]);
    expect(card.exchangeBySem[1].status).toBe('closed');
    expect(ids(card.exchangeBySem[1])).not.toContain(YEAR);
  });

  it('/module/:code: all 15 entries equal the oracle with R3, the note only where a shown entry is below Year 2', async () => {
    const { body } = await callJson('/module/ESE3101');
    expect(body.exchange).toHaveLength(15);
    for (const e of body.exchange) {
      const where = `${e.sem} ${e.study}`;
      expect(e.status, where).toBe(oracleShown(ese, { sem: e.sem, study: e.study }));
      expect(ids(e).includes(YEAR), where).toBe(e.status !== 'closed' && e.study === 'ug1');
    }
  });

  it('never hides or shows a course: the set shown for each study level is the stored one', async () => {
    for (const study of STUDIES) {
      const { body } = await callJson(`/search?q=resource%20management&ng=1&study=${study}&sem=2&topK=50`, { fakes });
      for (const code of shown(body)) expect(shownByOracle(code, 2, study), `${study} ${code}`).toBe(true);
      expect(shown(body), study).toContain('ESE3101');
    }
  });
});

describe('R6-2 (ADR 0010): GRO\'s level 4000 note, a condition on every path', () => {
  // PC4262: level 4000 (Science), on the NG list for both semesters, no stored note in Sem 1.
  const pc = /** @type {NormalisedModule} */ (moduleOf.get('PC4262'));
  // LL4295: level 4000 Law, on the NG list for Sem 2 (C5-m1: Law is outside the note).
  const ll = /** @type {NormalisedModule} */ (moduleOf.get('LL4295'));
  const GRO = 'gro:level-4000';
  /** @param {any} e */
  const ids = (e) => (e?.reasons ?? []).map((/** @type {any} */ r) => r.id);

  it('the fixture has the cases: the Registrar\'s lists open PC4262 in Sem 1 to everyone, and GRO\'s note covers undergraduates only, never Law', () => {
    expect(pc).toMatchObject({ level: 4, faculty: 'Science', ngSemesters: [1, 2] });
    for (const study of STUDIES) expect(oracle(pc, { sem: 1, study }), study).toBe('open');
    expect(STUDIES.map((study) => levelNoteOf(pc, study) !== null)).toEqual([true, true, true, true, false]);
    expect(ll).toMatchObject({ level: 4, faculty: 'Law' });
    expect(STUDIES.map((study) => levelNoteOf(ll, study))).toEqual([null, null, null, null, null]);
  });

  it('an undergraduate sees PC4262 open with 1 note on the pin, the bundle, a vector search, the standby and the mask route; a graduate sees it open', async () => {
    for (const study of STUDIES) {
      for (const [q, extra, envOver] of /** @type {[string, string, Record<string, string>][]} */ ([
        ['PC4262', '&mode=lexical', {}], ['remote sensing', '', {}],
        ['remote sensing', '&mode=vector', {}], ['remote sensing', '', { DENSE_BACKEND: 'vectorize' }],
        ['PC42', '', {}],
      ])) {
        const path = `/search?q=${encodeURIComponent(q)}&ng=1&study=${study}&sem=1&topK=50${extra}`;
        const { body } = await callJson(path, { fakes, env: envOver });
        const card = body.results.find((/** @type {any} */ r) => r.code === 'PC4262');
        const where = `${path} ${envOver.DENSE_BACKEND ?? ''}`;
        expect(card, where).toBeDefined();
        expect(card.exchange.status, where).toBe(oracleShown(pc, { sem: 1, study }));
        expect(card.exchange.status, where).toBe(study === 'grad' ? 'open' : 'note');
        expect(ids(card.exchange), where).toEqual(study === 'grad' ? [] : [GRO]);
      }
    }
  });

  it('the note is GRO\'s sentence with GRO named, kind `supply`, after the stored reasons', async () => {
    const { body } = await callJson('/search?q=PC4262&ng=1&study=ug3&sem=1&mode=lexical', { fakes });
    const card = body.results.find((/** @type {any} */ r) => r.code === 'PC4262');
    expect(card.exchange).toEqual({
      status: 'note',
      reasons: [{ id: GRO, kind: 'supply', text: 'GRO: “Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very limited supply and are usually NOT available to exchange students. In order to increase the chances of securing enough courses, incoming exchange students should consider taking courses with course code starting from 1000 to 3000”' }],
    });
    // Sem 2: the NG list's timetable note first, then GRO's.
    const s2 = await callJson('/search?q=PC4262&ng=1&study=ug3&sem=2&mode=lexical', { fakes });
    expect(ids(s2.body.results.find((/** @type {any} */ r) => r.code === 'PC4262').exchange)).toEqual(['ng-list:nusmods-semester-differs', GRO]);
  });

  it('exchangeBySem: with no semester, each semester carries the note once', async () => {
    const { body } = await callJson('/search?q=PC4262&ng=1&study=ug1&mode=lexical', { fakes });
    const card = body.results.find((/** @type {any} */ r) => r.code === 'PC4262');
    expect(ids(card.exchange)).toEqual([GRO]);
    expect(ids(card.exchangeBySem[1])).toEqual([GRO]);
    expect(ids(card.exchangeBySem[2])).toEqual(['ng-list:nusmods-semester-differs', GRO]);
  });

  it('/module/:code: every entry equals the oracle with the note, which is on every shown undergraduate entry and nowhere else', async () => {
    for (const [code, m] of /** @type {[string, NormalisedModule][]} */ ([['PC4262', pc], ['LL4295', ll], ['CS4212', moduleOf.get('CS4212')]])) {
      const { body } = await callJson(`/module/${code}`);
      expect(body.exchange).toHaveLength(15);
      for (const e of body.exchange) {
        const where = `${code} ${e.sem} ${e.study}`;
        expect(e.status, where).toBe(oracleShown(m, { sem: e.sem, study: e.study }));
        expect(ids(e).filter((id) => id === GRO), where).toEqual(e.status !== 'closed' && e.study !== 'grad' && code !== 'LL4295' ? [GRO] : []);
      }
    }
  });

  it('never hides or shows a course: the set shown for each study level is the stored one', async () => {
    for (const study of STUDIES) {
      const { body } = await callJson(`/search?q=PC4&ng=1&study=${study}&sem=1&topK=50`, { fakes });
      for (const code of shown(body)) expect(shownByOracle(code, 1, study), `${study} ${code}`).toBe(true);
      expect(shown(body), study).toContain('PC4262');
    }
  });
});
