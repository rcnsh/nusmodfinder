// @ts-check
import { beforeAll, describe, expect, it } from 'vitest';
import fixture from './fixtures/corpus.json';
import { unscheduled } from '../src/ng-unscheduled.js';
import { call, seed } from './helpers.js';
import { shortlistAgainstOracle } from './shortlist-oracle.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => { fakes = await seed(); });

describe('the oracle over the shortlist, fixture', () => {
  it('every fixture module and classless NG code × Sem 1 and Sem 2 × each study level and browse mode agrees with the oracle', async () => {
    const classless = [...unscheduled().values()].map((u) => ({
      code: u.code, title: u.title, department: u.department, faculty: u.faculty, level: u.level,
      semesters: [], ng: true, ngSemesters: u.ngSemesters, prerequisite: u.prerequisite,
    }));
    expect(classless.length).toBeGreaterThan(0);
    const modules = /** @type {any[]} */ (fixture.modules);
    expect(modules).toHaveLength(434);
    /** @type {typeof fetch} */
    const pageFetch = /** @type {any} */ ((/** @type {string} */ url) => call(String(url), { fakes }));
    const { wrong, closed, shown, browse } = await shortlistAgainstOracle([...modules, ...classless], pageFetch);
    expect(wrong).toEqual([]);
    expect(closed + shown).toBe((modules.length + classless.length) * 10);
    expect(closed).toBeGreaterThan(1000);
    expect(shown).toBeGreaterThan(500);
    expect(browse).toBe((modules.length + classless.length) * 2);
  }, 120_000);
});
