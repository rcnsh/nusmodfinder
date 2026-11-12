// @ts-check
// Every result opens a full detail: for every fixture code, `?q=CODE&open=CODE` opens
// that course's detail, and each field is there with the fixture's value,
// or its "not listed" text: the description; prerequisites and preclusions;
// the exam per semester, or "No final exam listed"; the workload, or
// "Workload not listed"; exchange availability per semester; the NUSMods
// link. test/ui/detail-fields.mjs reads the fields and says what each should be
// (the live check, scripts/live-check.mjs, uses it too). The raw-workload case
// (NUS's text instead of the 5-number form, which the fixture lacks) is
// intercepted.
//
// The codes are split into batches, one test each, so the workers share them;
// each batch reuses one page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { readDetail, detailExpected, detailProblems } from './detail-fields.mjs';

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/corpus.json', import.meta.url)), 'utf8'));
/** @type {any[]} */
const MODULES = corpus.modules;
const BATCHES = 12;
const size = Math.ceil(MODULES.length / BATCHES);
const batches = Array.from({ length: BATCHES }, (_, b) => MODULES.slice(b * size, (b + 1) * size));

for (const [b, batch] of batches.entries()) {
  test(`every fixture code, batch ${b + 1} of ${BATCHES} (${batch[0].code} to ${batch.at(-1).code}): ?q=CODE&open=CODE has every field or its "not listed" text`, async ({ page }) => {
    test.setTimeout(120_000);
    for (const m of batch) {
      await page.goto(`/?q=${encodeURIComponent(m.code)}&open=${encodeURIComponent(m.code)}`);
      expect(detailProblems(await readDetail(page, m.code), detailExpected(m)), m.code).toEqual([]);
    }
  });
}

test('every fixture code is checked once, and the fixture has every "not listed" case', () => {
  const covered = batches.flat().map((m) => m.code);
  expect(covered).toEqual(MODULES.map((m) => m.code));
  expect(new Set(covered).size).toBe(MODULES.length);
  expect(MODULES.some((m) => !m.examDates?.length)).toBe(true);
  expect(MODULES.some((m) => m.workload === null)).toBe(true);
  expect(MODULES.some((m) => m.workload === '[0,0,0,0,0]')).toBe(true);
  expect(MODULES.some((m) => !m.prerequisite)).toBe(true);
  expect(MODULES.some((m) => m.prereqCohortOnly)).toBe(true);
  expect(MODULES.some((m) => !m.preclusion)).toBe(true);
});

test('the detail shows NUS\'s raw workload text, when it isn\'t the 5-number form (intercepted)', async ({ page }) => {
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), workload: { raw: '3-.5-0--0-6.5' } } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const want = { ...detailExpected(MODULES.find((m) => m.code === 'CS3244')), workload: 'As NUS lists it: 3-.5-0--0-6.5' };
  expect(detailProblems(await readDetail(page, 'CS3244'), want)).toEqual([]);
});

test('a missing field, or one from another course, is caught: the check is not vacuous', async ({ page }) => {
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    route.fulfill({ response: res, json: {
      ...body, examDates: [], nusmodsUrl: null, prerequisite: 'MA9999 only', preclusion: 'ZZ9999',
      // Every year closed in Sem 2, where CS3244 is open to exchange students.
      exchange: body.exchange.map((/** @type {any} */ e) => (e.sem === 2 ? { ...e, status: 'closed' } : e)),
    } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const problems = detailProblems(await readDetail(page, 'CS3244'), detailExpected(MODULES.find((m) => m.code === 'CS3244')));
  expect(problems.map((p) => p.split(':')[0])).toEqual([
    "prerequisites, NUS's text", "preclusions, NUS's text", 'exams', 'exchange, 1st year', 'exchange, 2nd year', 'exchange, 3rd year',
    'exchange, 4th year or later', 'exchange, Graduate', 'NUSMods link',
  ]);
});
