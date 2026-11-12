// @ts-check
// The parsed-phrase chips. Most cases use intercepted /search answers in the
// Worker's `interpreted` shape; one checks the real Worker, which reads
// phrases (PARSE_PHRASES on).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { body, query, searches } from './support.mjs';

const Q = 'history no final exam under 10 hours no prerequisites';

/**
 * Answers /search as a Worker with phrases on would: every intent the
 * request's `ignore=` leaves.
 * @param {import('@playwright/test').Page} page
 */
async function phrasesOn(page) {
  await page.route('**/search?**', (route) => {
    const u = new URL(route.request().url());
    const ignore = (u.searchParams.get('ignore') ?? '').split(',');
    const interpreted = {
      pin: null, prefix: null, ge: null, level: null,
      exam: ignore.includes('exam') ? null : 0,
      su: null,
      hoursBelow: ignore.includes('hoursBelow') ? null : 10,
      prereq: ignore.includes('prereq') ? null : { value: 'none', semantics: 'ii' },
    };
    return route.fulfill({ json: body({ query: u.searchParams.get('q'), interpreted }) });
  });
}

const chips = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#status .intents li');

test('each parsed phrase is a chip, and removing one re-runs the search with ignore= in place', async ({ page }) => {
  await phrasesOn(page);
  const sent = searches(page);
  await page.goto(`/?q=${encodeURIComponent(Q)}`);
  await expect(chips(page)).toHaveText(['No final exam×', 'Under 10 h a week×', 'No prerequisites×']);
  await expect(page.locator('#status .intents')).toContainText('Read from your query:');
  const length = await page.evaluate(() => /** @type {any} */ (globalThis).history.length);

  await page.getByRole('button', { name: 'Remove “No final exam” and search again' }).click();
  await expect(chips(page)).toHaveText(['Under 10 h a week×', 'No prerequisites×']);
  expect(new URLSearchParams(query(page)).get('ignore')).toBe('exam');
  expect(new URLSearchParams(sent.at(-1)).get('ignore')).toBe('exam');
  // A chip removal replaces the entry (nav.js), and focus goes back to the query, not the body.
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).history.length)).toBe(length);
  await expect(page.locator('#q')).toBeFocused();

  await page.getByRole('button', { name: 'Remove “No prerequisites” and search again' }).click();
  await expect(chips(page)).toHaveText(['Under 10 h a week×']);
  expect(new URLSearchParams(query(page)).get('ignore')).toBe('exam,prereq');
  expect(new URLSearchParams(sent.at(-1)).get('ignore')).toBe('exam,prereq');
});

test('the remove button works from the keyboard and a shared link with ignore= keeps it', async ({ page }) => {
  await phrasesOn(page);
  await page.goto(`/?q=${encodeURIComponent(Q)}&ignore=hoursBelow`);
  await expect(chips(page)).toHaveText(['No final exam×', 'No prerequisites×']);
  await page.getByRole('button', { name: 'Remove “No final exam” and search again' }).focus();
  await page.keyboard.press('Enter');
  await expect(chips(page)).toHaveText(['No prerequisites×']);
  expect(new URLSearchParams(query(page)).get('ignore')).toBe('exam,hoursBelow');
});

test('removing a chip closes an open detail, and a new query starts without ignore=', async ({ page }) => {
  await phrasesOn(page);
  await page.goto(`/?q=${encodeURIComponent(Q)}&open=CS2105`);
  await page.getByRole('button', { name: 'Remove “Under 10 h a week” and search again' }).click();
  await expect(chips(page)).toHaveText(['No final exam×', 'No prerequisites×']);
  const params = new URLSearchParams(query(page));
  expect(params.get('ignore')).toBe('hoursBelow');
  expect(params.get('open')).toBeNull();
  await page.locator('#q').fill('networks no final exam');
  await page.locator('#q').press('Enter');
  await expect(chips(page)).toHaveText(['No final exam×', 'Under 10 h a week×', 'No prerequisites×']);
  expect(new URLSearchParams(query(page)).get('ignore')).toBeNull();
});

test('a no-result answer still shows its chips, so the student can undo the phrase that emptied it', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: 'x', count: 0, results: [], interpreted: { exam: 0, su: { value: 1, basis: ['CS/CU', 'su'] }, hoursBelow: null, prereq: null } }) }));
  await page.goto('/?q=x');
  await expect(chips(page)).toHaveText(['No final exam×', 'Can be taken S/U×']);
});

test('the Worker, with PARSE_PHRASES on, reads the phrases, and the chips show them', async ({ page }) => {
  const answered = page.waitForResponse((r) => new URL(r.url()).pathname === '/search');
  await page.goto('/?q=programming%20no%20final%20exam%20no%20prerequisites');
  const res = await answered;
  const json = await res.json();
  expect(json.interpreted.exam).not.toBeNull();
  expect(json.interpreted.prereq).not.toBeNull();
  await expect(chips(page)).toHaveText(['No final exam×', 'No prerequisites×']);
});

for (const scheme of /** @type {const} */ (['light', 'dark'])) {
  test(`axe, every rule, on the chips (${scheme}): no violation`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await phrasesOn(page);
    await page.goto(`/?q=${encodeURIComponent(Q)}`);
    await expect(chips(page)).toHaveCount(3);
    const { violations } = await new AxeBuilder({ page }).analyze();
    // As a11y.spec.js: no violation is allowed.
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });
}
