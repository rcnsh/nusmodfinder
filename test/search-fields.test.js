// @ts-check
// Phase 5 5C-api (docs/plans/phase5.md §3 "5C-api"): /search's additive,
// ranking-neutral fields on the fixture.
// - `hiddenPins`: every typed offered code (up to 10, not only the 3 pinned)
//   whose row the filters remove. A code with no row, or a pin skipped because
//   its duplicate group's member is already shown, is never listed.
// - `notOffered`: every typed catalogue-only code, from the parse (no read).
// - `exchangeBySem`: under ng=1 with no sem, each result's status and reasons
//   for Sem 1 and Sem 2 at the request's study level, from the stored row.
// - `examDates`: each result's exams, as /module/:code answers them.
// The whole-corpus check of exchangeBySem against the oracle is
// test/sc1/paths.test.js.
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { bitOf } from '../src/ng-bit.js';
import { exchangeAt } from '../src/ng-reasons.js';
import { oracleShown } from './sc1/oracle.node.mjs';
import { callJson, fixture, seed } from './helpers.js';

const moduleOf = new Map(fixture.modules.map((m) => [m.code, m]));
/** @type {import('../src/ng-bit.js').Study[]} */
const STUDIES = ['ug1', 'ug2', 'ug3', 'ug4', 'grad'];
/** @returns {string[]} */
const codes = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);
/** @param {string} code */
const mod = (code) => /** @type {NormalisedModule} */ (moduleOf.get(code));

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('hiddenPins', () => {
  it('lists each typed code the filters remove, in query order, each for its own reason, past the 3 pins', async () => {
    // ug2, Sem 1: CS3244 is on the NG list for Sem 2 only; CS1010S is not on it. CS1010S is the
    // 4th offered code, so it is never pinned, and is still reported.
    expect(mod('CS3244')).toMatchObject({ ng: true, ngSemesters: [2] });
    expect(mod('CS1010S')).toMatchObject({ ng: false });
    const { status, body } = await callJson('/search?q=CS1010%20CS3244%20CS2030%20CS1010S&ng=1&study=ug2&sem=1', { fakes });
    expect(status).toBe(200);
    expect(body.interpreted.pin).toEqual(['CS1010', 'CS3244', 'CS2030']);
    expect(body.hiddenPins).toEqual(['CS3244', 'CS1010S']);
    expect(body.notOffered).toEqual([]);
    expect(codes(body).slice(0, 2)).toEqual(['CS1010', 'CS2030']);
    expect(codes(body)).not.toContain('CS3244');
    expect(codes(body)).not.toContain('CS1010S');
  });

  it('is empty when every typed code shows, and on routes with no typed code', async () => {
    for (const path of ['/search?q=CS3244%20CS2030&ng=1&study=ug2&sem=2', '/search?q=machine%20learning', '/search?q=cs32', '/search?q=CS9999']) {
      const { body } = await callJson(path, { fakes });
      expect(body.hiddenPins, path).toEqual([]);
      expect(body.notOffered, path).toEqual([]);
    }
  });

  it('never lists a pin skipped because its group\'s member already shows', async () => {
    // CS1010 and CS1010S are one duplicate group: CS1010 stands for it, CS1010S is its variant.
    const { body } = await callJson('/search?q=CS1010%20CS1010S', { fakes });
    expect(codes(body)[0]).toBe('CS1010');
    expect(body.results[0].variants.map((/** @type {any} */ v) => v.code)).toContain('CS1010S');
    expect(body.hiddenPins).toEqual([]);
  });

  it('never lists a code with no row (the bundle has it, D1 no longer does)', async () => {
    await env.DB.prepare('DELETE FROM modules WHERE code = ?').bind('CS3244').run();
    try {
      const { body } = await callJson('/search?q=CS3244%20CS1010S&sem=4', { fakes });
      expect(body.interpreted.pin).toEqual(['CS3244', 'CS1010S']);
      expect(body.hiddenPins).toEqual(['CS1010S']);
    } finally {
      fakes = await seed();
    }
  });

  it('follows the filters the pins follow: 3H\'s intents, not 3B\'s level window', async () => {
    // exam=0: CS3244 has exams, so it is hidden; PC3270 has none.
    const exam = await callJson('/search?q=CS3244%20PC3270&exam=0', { fakes });
    expect(exam.body.hiddenPins).toEqual(['CS3244']);
    expect(codes(exam.body)[0]).toBe('PC3270');
  });
});

describe('notOffered', () => {
  it('lists catalogue-only codes inside a longer query; ranking is as without them', async () => {
    const { body } = await callJson('/search?q=CS1010%20CS1001%20GEQ1000', { fakes });
    expect(body.notOffered).toEqual(['CS1001', 'GEQ1000']);
    expect(body.noMatch).toBeUndefined();
    expect(codes(body)[0]).toBe('CS1010');
  });

  it('names a whole-query catalogue-only code too, beside noMatch', async () => {
    const { body } = await callJson('/search?q=CS1001', { fakes });
    expect(body.noMatch.reason).toBe('not-offered');
    expect(body.notOffered).toEqual(['CS1001']);
    expect(body.hiddenPins).toEqual([]);
  });
});

describe('exchangeBySem', () => {
  it('under ng=1 with no sem, each result carries Sem 1 and Sem 2 at its study level, matching the oracle', async () => {
    let checked = 0;
    for (const study of STUDIES) {
      for (const [q, extra, envOver] of /** @type {[string, string, Record<string, string>][]} */ ([
        ['machine%20learning', '&topK=50', {}], ['programming', '&topK=50&mode=lexical', {}],
        ['introduction', '&topK=50', { DENSE_BACKEND: 'vectorize' }], ['CS', '&topK=50', {}], ['CS3244%20PC3270%20CG2023', '', {}],
      ])) {
        const path = `/search?q=${q}&ng=1&study=${study}${extra}`;
        const { body } = await callJson(path, { fakes, env: envOver });
        expect(body.results.length, path).toBeGreaterThan(0);
        for (const r of body.results) {
          expect(Object.keys(r.exchangeBySem), `${path} ${r.code}`).toEqual(['1', '2']);
          for (const sem of /** @type {const} */ ([1, 2])) {
            expect(r.exchangeBySem[sem].status, `${path} ${r.code} sem ${sem}`).toBe(oracleShown(mod(r.code), { sem, study }));
            const row = { ng: mod(r.code).ng ? 1 : 0, ng_allow: mod(r.code).ngAllow, ng_rules: mod(r.code).ngRules === null ? null : JSON.stringify(mod(r.code).ngRules), prerequisite: mod(r.code).prerequisite };
            expect(r.exchangeBySem[sem], `${path} ${r.code} sem ${sem}`).toEqual(exchangeAt(row, bitOf(sem, study)));
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('a course open in one semester only says so per semester (PC3270: NG Sem 1 only)', async () => {
    const { body } = await callJson('/search?q=PC3270&ng=1&study=ug2', { fakes });
    const pc = body.results.find((/** @type {any} */ r) => r.code === 'PC3270');
    expect(pc.exchangeBySem[1].status).toBe('note');
    expect(pc.exchangeBySem[2]).toEqual({ status: 'closed', reasons: [expect.objectContaining({ id: 'ng-list:not-in-semester' })] });
  });

  it('is absent with a sem, and outside exchange mode', async () => {
    for (const path of ['/search?q=machine%20learning&ng=1&study=ug2&sem=1', '/search?q=machine%20learning', '/search?q=machine%20learning&sem=1']) {
      const { body } = await callJson(path, { fakes });
      expect(body.results.length, path).toBeGreaterThan(0);
      for (const r of body.results) expect(r.exchangeBySem, `${path} ${r.code}`).toBeUndefined();
    }
  });
});

describe('examDates', () => {
  it('each result carries its exams (ISO UTC, with duration), or [] when none is listed', async () => {
    let withExam = 0;
    for (const path of ['/search?q=machine%20learning&topK=50', '/search?q=CS3244%20PC3270', '/search?q=CS&topK=50', '/search?q=physics&ng=1&study=ug2&topK=50']) {
      const { body } = await callJson(path, { fakes });
      for (const r of body.results) {
        expect(r.examDates, `${path} ${r.code}`).toEqual(mod(r.code).examDates);
        if (r.examDates.length) withExam++;
      }
    }
    expect(withExam).toBeGreaterThan(0);
    const { body } = await callJson('/search?q=CS3244%20PC3270', { fakes });
    expect(body.results.find((/** @type {any} */ r) => r.code === 'CS3244').examDates[0]).toEqual({ sem: 1, date: '2026-11-26T09:00:00.000Z', durationMins: 120 });
    expect(body.results.find((/** @type {any} */ r) => r.code === 'PC3270').examDates).toEqual([]);
  });
});
