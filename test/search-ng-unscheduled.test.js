// @ts-check
// Phase 6 6A (docs/plans/phase6.md §3 "6A"): /search reads the NG-listed codes
// with no classes this year (src/ng-unscheduled.js, here
// test/fixtures/ng-unscheduled.json) before its unknown-code and not-offered
// answers, so a typed EE4438, which data/catalogue-codes.json (built from the
// pinned release) lacks, says what the shortlist says instead of "There is no
// course EE4438". It changes the answer's reason and `notOffered`, never which
// courses are ranked.
import { beforeAll, describe, expect, it } from 'vitest';
import catalogueCodes from '../data/catalogue-codes.json';
import { unscheduled } from '../src/ng-unscheduled.js';
import { callJson, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('a typed NG-listed code with no classes', () => {
  it('EE4438, in the file and absent from catalogue-codes.json, answers as NG-listed with no classes, not unknown', async () => {
    expect(catalogueCodes.codes).not.toContain('EE4438');
    expect(unscheduled().get('EE4438')).toBeDefined();
    const { status, body } = await callJson('/search?q=EE4438', { fakes });
    expect(status).toBe(200);
    expect(body.count).toBe(0);
    expect(body.results).toEqual([]);
    expect(body.noMatch).toMatchObject({ reason: 'ng-unscheduled', code: 'EE4438', title: 'Solar Cells and Modules', ngSemesters: [2] });
    expect(Array.isArray(body.noMatch.related)).toBe(true);
  });

  it('a file code that catalogue-codes.json has (EE4407) answers the same way, in any case and in exchange mode', async () => {
    expect(catalogueCodes.codes).toContain('EE4407');
    for (const q of ['EE4407', 'ee4407', 'EE4407&ng=1&study=ug3&sem=1']) {
      const { body } = await callJson(`/search?q=${q}`, { fakes });
      expect(body.noMatch, q).toMatchObject({ reason: 'ng-unscheduled', code: 'EE4407', title: 'Analog Electronics', ngSemesters: [1] });
    }
  });

  it('inside a longer query it is one of the typed codes not offered, and is never ranked', async () => {
    const { body } = await callJson('/search?q=EE4438%20solar%20energy', { fakes });
    expect(body.noMatch).toBeUndefined();
    expect(body.notOffered).toEqual(['EE4438']);
    expect(body.results.map((/** @type {{ code: string }} */ r) => r.code)).not.toContain('EE4438');
  });

  it('a code in neither the catalogue nor the file is still unknown', async () => {
    const { body } = await callJson('/search?q=CS9999', { fakes });
    expect(body.noMatch).toEqual({ reason: 'unknown-code', code: 'CS9999' });
  });
});
