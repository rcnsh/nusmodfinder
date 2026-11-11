// @ts-check
// Phase 6 6C's shape check: 6B's shortlist (public/shortlist.js) was built
// and tested against hand-made /module 404s and /facets rules, because 6A
// wasn't merged yet. Here the Worker answers for real (the fixture, the
// fixture's ng-unscheduled.json, a catalogue-only row), through the page's
// own fetch layer (public/api.js createModuleClient and fetchFacets), and
// 6B's answerOf and workOut read them. A field renamed on either side fails
// here, not on the live page.
import { beforeAll, describe, expect, it } from 'vitest';
import { createModuleClient, fetchFacets } from '../public/api.js';
import { emptyList } from '../public/list.js';
import { answerOf, semChoices, workOut } from '../public/shortlist.js';
import { adminCall, call, seed } from './helpers.js';

/** @type {import('./fakes.js').Fakes} */
let fakes;
/** The page's fetch, answered by the Worker under test. @type {typeof fetch} */
const pageFetch = /** @type {any} */ ((/** @type {string} */ url) => call(String(url), { fakes }));
/** @type {{ get: (code: string) => Promise<import('../public/api.js').Outcome> }} */
let modules;

beforeAll(async () => {
  fakes = await seed({ facets: true });
  const res = await adminCall('/admin/catalogue', fakes, { upsert: [{ code: 'CS1010J', title: 'Introduction to Programming', description: 'An introductory course in Java.', acadYear: '2026-2027' }] });
  if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
  modules = createModuleClient({ fetch: pageFetch });
});

/**
 * Works out a list over the Worker's real answers.
 * @param {{ pick?: [string, '' | '1' | '2'][], alt?: [string, '' | '1' | '2'][], study?: string, rules?: any }} spec
 */
async function run({ pick = [], alt = [], study = 'ug2', rules = null }) {
  const list = { ...emptyList(), pick: pick.map(([code, sem]) => ({ code, sem })), alt: alt.map(([code, sem]) => ({ code, sem })) };
  /** @type {Map<string, import('../public/shortlist.js').Answer>} */
  const answers = new Map();
  for (const e of [...list.pick, ...list.alt]) answers.set(e.code, answerOf(await modules.get(e.code)));
  return { answers, r: workOut({ list, sem: '1', study, answers, rules }) };
}
/** @param {import('../public/shortlist.js').Result} r @param {string} code */
const at = (r, code) => {
  const w = r.entries.find((x) => x.code === code);
  if (!w) throw new Error(`${code} not in the result`);
  return w;
};

describe('6A\'s answers, read by 6B\'s shortlist (6C shape check)', () => {
  it('an ng-listed 404 (EE4407) reads like a row with no classes: to confirm in Sem 1, numbered; not on the list in Sem 2; its buttons from ngSemesters', async () => {
    const { answers, r } = await run({ pick: [['EE4407', '1']] });
    const a = /** @type {any} */ (answers.get('EE4407'));
    expect(a.kind).toBe('ng-listed');
    expect(a.course).toMatchObject({ title: 'Analog Electronics', credits: 4, ng_semesters: [1], semesters: [], acad_year: '2026-2027' });
    expect(at(r, 'EE4407')).toMatchObject({ standing: 'confirm', units: 4, status: 'note', form: { number: 1 } });
    expect(semChoices(/** @type {any} */ (a), 'ug2')).toEqual([1]);
    expect(at((await run({ pick: [['EE4407', '2']] })).r, 'EE4407')).toMatchObject({ standing: 'out', why: 'Not on NUS\'s exchange list for Sem 2 in 2026/27' });
  });

  it('NUS\'s restrictions in the file close PF2102 at grad in Sem 1', async () => {
    expect(at((await run({ pick: [['PF2102', '1']], study: 'grad' })).r, 'PF2102')).toMatchObject({ standing: 'out', why: 'Not open to exchange students in Sem 1' });
  });

  it('the file\'s otherCodes make NGN2001D the same course as NGN2001G, whichever comes first', async () => {
    for (const order of [['NGN2001G', 'NGN2001D'], ['NGN2001D', 'NGN2001G']]) {
      const { r } = await run({ pick: order.map((c) => /** @type {[string, '1']} */ ([c, '1'])) });
      expect(at(r, 'NGN2001G').standing, order.join()).toBe('counted');
      expect(at(r, 'NGN2001D'), order.join()).toMatchObject({ standing: 'duplicate', sameAs: 'NGN2001G' });
    }
  });

  it('a catalogue-only 404 keeps its title and description (6D exports its text); an unknown 404 says so; both carry the year', async () => {
    const { answers, r } = await run({ pick: [['CS1010J', '1'], ['CS9999', '1']] });
    expect(answers.get('CS1010J')).toEqual({ kind: 'catalogue-only', title: 'Introduction to Programming', description: 'An introductory course in Java.', acadYear: '2026-2027' });
    expect(answers.get('CS9999')).toEqual({ kind: 'unknown', acadYear: '2026-2027' });
    expect(at(r, 'CS1010J')).toMatchObject({ standing: 'out', why: 'Not offered in 2026/27', title: 'Introduction to Programming' });
    expect(at(r, 'CS9999')).toMatchObject({ standing: 'out', why: 'No course with this code in 2026/27' });
  });

  it('/facets\' offListRules, as the Worker answers them, name the CEE and Business no-appeal rules for courses off the list', async () => {
    const facets = await fetchFacets({ fetch: pageFetch });
    const rules = facets?.offListRules;
    expect(Array.isArray(rules)).toBe(true);
    // The fixture has no level 1–4 CEE course off a list, so the rows are the Worker's for real
    // courses, with the department changed: what covers() reads is the rule's scope.
    const base = /** @type {any} */ ((await modules.get('CS3244'))).body;
    const answers = new Map([
      ['CE2183', answerOf({ kind: 'ok', body: { ...base, code: 'CE2183', department: 'Civil and Environmental Engineering', level: 2 } })],
      ['ACC2706', answerOf({ kind: 'ok', body: { ...base, code: 'ACC2706', department: 'Accounting', faculty: 'NUS Business School', level: 2 } })],
      ['CS3244', answerOf({ kind: 'ok', body: base })],
    ]);
    const list = { ...emptyList(), pick: ['CE2183', 'ACC2706', 'CS3244'].map((code) => ({ code, sem: /** @type {'1'} */ ('1') })) };
    // CS3244 is off the Sem 1 list (fixture), so all three are closed as off-list in Sem 1.
    const r = workOut({ list, sem: '1', study: 'ug2', answers, rules });
    const text = (/** @type {string} */ id) => rules.find((/** @type {any} */ x) => x.id === id).text;
    expect(at(r, 'CE2183').why).toContain(text('4-cee-no-appeal'));
    expect(at(r, 'ACC2706').why).toContain(text('2-biz-no-late-add'));
    expect(at(r, 'CS3244').why).toContain(text('E-offerings-list').replace(/^If the courses cannot be found at the Course offerings list, they are /, '').replace(/\.$/, ''));
  });
});
