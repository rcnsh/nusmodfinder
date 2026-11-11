// @ts-check
// SC2 in CI (Phase 5 5G): for every fixture code, `?q=CODE&open=CODE` opens
// that course's detail, and each SC2 field is there with the fixture's value,
// or its "not listed" text: the description; prerequisites and preclusions;
// the exam per semester, or "No final exam listed"; the workload, or
// "Workload not listed"; exchange availability per semester; the NUSMods
// link. test/ui/sc2-fields.mjs reads the fields and says what each should be
// (the live check, scripts/p5-live.mjs, uses it too). The raw-workload case
// (NUS's text instead of the 5-number form, which the fixture lacks) is
// intercepted (A2-8).
//
// The codes are split into batches, one test each, so the workers share them;
// each batch reuses one page.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { readSc2, sc2Expected, sc2Problems } from './sc2-fields.mjs';

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/corpus.json', import.meta.url)), 'utf8'));
/** @type {any[]} */
const MODULES = corpus.modules;
const BATCHES = 12;
const size = Math.ceil(MODULES.length / BATCHES);
const batches = Array.from({ length: BATCHES }, (_, b) => MODULES.slice(b * size, (b + 1) * size));

for (const [b, batch] of batches.entries()) {
  test(`[SC2] every fixture code, batch ${b + 1} of ${BATCHES} (${batch[0].code} to ${batch.at(-1).code}): ?q=CODE&open=CODE has every field or its "not listed" text`, async ({ page }) => {
    test.setTimeout(120_000);
    for (const m of batch) {
      await page.goto(`/?q=${encodeURIComponent(m.code)}&open=${encodeURIComponent(m.code)}`);
      expect(sc2Problems(await readSc2(page, m.code), sc2Expected(m)), m.code).toEqual([]);
    }
  });
}

test('[SC2] every fixture code is checked once, and the fixture has every "not listed" case', () => {
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

test('[SC2] [A2-8] NUS\'s raw workload text, when it isn\'t the 5-number form (intercepted)', async ({ page }) => {
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), workload: { raw: '3-.5-0--0-6.5' } } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const want = { ...sc2Expected(MODULES.find((m) => m.code === 'CS3244')), workload: 'As NUS lists it: 3-.5-0--0-6.5' };
  expect(sc2Problems(await readSc2(page, 'CS3244'), want)).toEqual([]);
});

test('[SC2] a missing field is caught: the check is not vacuous', async ({ page }) => {
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), examDates: [], nusmodsUrl: null } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const problems = sc2Problems(await readSc2(page, 'CS3244'), sc2Expected(MODULES.find((m) => m.code === 'CS3244')));
  expect(problems.map((p) => p.split(':')[0])).toEqual(['exams', 'NUSMods link']);
});
