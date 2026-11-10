// @ts-check
// The card and its detail (Phase 5 5C, SC2, F1): an APG disclosure per card,
// the exchange status on the card for the chosen semester or per semester,
// every note in full, no score; the detail inline from /module/:code, fetched
// once. Against the fixture, plus interception for what it lacks (a raw
// workload).
import { expect, test } from '@playwright/test';
import { query } from './support.mjs';

/** @param {import('@playwright/test').Page} page @param {string} code */
const card = (page, code) => page.locator('#results > li.card').filter({ has: page.locator(`button[data-code="${code}"]`) });
/** @param {import('@playwright/test').Page} page @param {string} code */
const toggle = (page, code) => page.locator(`#results button.card-toggle[data-code="${code}"]`);
/** The detail region a card's button controls. @param {import('@playwright/test').Page} page @param {string} code */
async function region(page, code) {
  const id = await toggle(page, code).getAttribute('aria-controls');
  return page.locator(`#${id}`);
}

test('[F1] a card is a disclosure: a heading holding one button (code and title) that controls the detail; no score', async ({ page }) => {
  await page.goto('/?q=CS3244');
  const b = toggle(page, 'CS3244');
  await expect(b).toHaveAccessibleName('CS3244 Machine Learning');
  await expect(b).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#results > li.card h2 > button.card-toggle').first()).toBeVisible();
  const detail = await region(page, 'CS3244');
  await expect(detail).toBeHidden();
  await expect(detail).toHaveAttribute('role', 'region');
  await expect(card(page, 'CS3244').locator('.units')).toHaveText('4 units');
  const meta = card(page, 'CS3244').locator('.meta');
  await expect(meta).toHaveText(/^Computer Science · Computing.*Taught in Sem 1, Sem 2.*Sem 1 exam Thu 26 Nov, 5:00 pm.*Sem 2 exam Thu 29 Apr, 9:00 am$/);
  await expect(page.locator('#results .score')).toHaveCount(0);
  await expect(page.locator('#results')).not.toContainText(/\b0\.\d{3}\b/);
  await b.click();
  await expect(b).toHaveAttribute('aria-expanded', 'true');
  await expect(detail).toBeVisible();
  expect(query(page)).toBe('q=CS3244&open=CS3244');
  // By keyboard too: Enter on the focused button closes it (WebKit doesn't focus buttons on click).
  await b.focus();
  await page.keyboard.press('Enter');
  await expect(b).toHaveAttribute('aria-expanded', 'false');
  await expect(detail).toBeHidden();
});

test('the card\'s exam is the chosen semester\'s, or "No final exam"', async ({ page }) => {
  await page.goto('/?q=CS3244&sem=1');
  await expect(card(page, 'CS3244').locator('.meta')).toContainText('Exam Thu 26 Nov, 5:00 pm');
  await page.goto('/?q=CS5562');
  await expect(card(page, 'CS5562').locator('.meta')).toContainText('No final exam');
});

test('exchange status on the card, one semester: every note in full, the semester note worded as an action (ACC1701XB)', async ({ page }) => {
  await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1');
  const c = card(page, 'ACC1701XB');
  await expect(c.locator('.exchange-status')).toHaveText('Sem 1 · Open, with 3 notes');
  await expect(c.locator('.exchange-status')).toHaveAttribute('data-status', 'note');
  // Each note in full, after a lead-in word for what it is about.
  await expect(c.locator('.notes li')).toHaveText([
    "Timetable. Not on NUSMods' timetable for Sem 1: check with the department.",
    'Places. Business courses are over-subscribed and not guaranteed.',
    'Your major. Only for students majoring in business at their home university.',
  ]);
});

test('exchange status on the card, both semesters: one line per semester, never a merged value', async ({ page }) => {
  await page.goto('/?q=CS3244&ng=1&study=ug2');
  await expect(card(page, 'CS3244').locator('.exchange-status')).toHaveText(['Sem 1 · Not open', 'Sem 2 · Open']);
  await expect(card(page, 'CS3244').locator('.exchange-status').first()).toHaveAttribute('data-status', 'closed');
  await expect(card(page, 'CS3244').locator('.notes-box .scope')).toHaveText(['Notes for Sem 1']);
  await expect(card(page, 'CS3244').locator('.notes li')).toHaveText(['Offered to exchange students only in Sem 2.']);
  await page.goto('/?q=ACC1701XB&ng=1&study=ug2');
  const c = card(page, 'ACC1701XB');
  await expect(c.locator('.exchange-status')).toHaveText(['Sem 1 · Open, 3 notes', 'Sem 2 · Open, 2 notes']);
  // The notes both semesters share are said once, and say so.
  await expect(c.locator('.notes-box .scope')).toHaveText(['Notes for Sem 1', 'Notes for Sem 1 and Sem 2']);
  await expect(c.locator('.notes li')).toHaveText([
    "Timetable. Not on NUSMods' timetable for Sem 1: check with the department.",
    'Places. Business courses are over-subscribed and not guaranteed.',
    'Your major. Only for students majoring in business at their home university.',
  ]);
});

test('outside exchange mode the card keeps a marker of the exchange-list semesters (D2)', async ({ page }) => {
  await page.goto('/?q=CS3244');
  await expect(card(page, 'CS3244').locator('.ng')).toHaveText('On the exchange (NG) list: Sem 2');
});

test('[SC2] the detail: description, prerequisites as NUS states them with codes linked, exam, workload, exchange per semester, NUSMods', async ({ page }) => {
  const fetched = /** @type {string[]} */ ([]);
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/module/')) fetched.push(new URL(r.url()).pathname); });
  await page.goto('/?q=CS3244&ng=1&study=ug2&sem=2&open=CS3244');
  const d = await region(page, 'CS3244');
  await expect(d).toBeVisible();
  await expect(d.getByRole('heading', { name: 'Description' })).toBeVisible();
  await expect(d).toContainText('As NUS states it:');
  await expect(d.locator('.nus-text').first()).toContainText('If undertaking an Undergraduate Degree THEN must have completed 1 of CS2040/');
  await expect(d.locator('.nus-text').first()).toContainText('at least D AND must have completed');
  await expect(d.getByRole('link', { name: 'CS2040S', exact: true })).toHaveAttribute('href', '/?q=CS2040S&sem=2&ng=1&study=ug2');
  await expect(d.locator('.exam-list li')).toHaveText(['Sem 1: Thu 26 Nov 2026, 5:00 pm, 2 h', 'Sem 2: Thu 29 Apr 2027, 9:00 am, 2 h']);
  await expect(d.getByRole('heading', { name: 'Workload' })).toBeVisible();
  await expect(d).toContainText('10 hours a week: 2 lecture, 1 tutorial, 4 project, 3 preparation');
  await expect(d.getByRole('heading', { name: 'Can you take it?' })).toBeVisible();
  await expect(d.locator('.avail .for')).toHaveText('As a 2nd-year exchange student');
  await expect(d.locator('.exchange-sem-block')).toHaveText([
    /^Sem 1 · Not open to exchange studentsOffered to exchange students only in Sem 2\.NG list, updated 01 Sep 2026$/,
    /^Sem 2 · Open to exchange studentsYour semester$/,
  ]);
  await expect(d).toContainText('Check with NUS before you register.');
  await expect(d.locator('.sources-line')).toContainText('(updated 01 Sep 2026)');
  const nusmods = d.getByRole('link', { name: 'Class times and timetable on NUSMods' });
  await expect(nusmods).toHaveAttribute('href', 'https://nusmods.com/courses/CS3244');
  await expect(nusmods).toHaveAttribute('rel', 'noopener');
  await expect(d).toContainText("Class times aren't shown here.");
  expect(fetched).toEqual(['/module/CS3244']);
});

test('a cohort-only prerequisite reads "No course prerequisite", NUS\'s text one click away; preclusions as NUS states them', async ({ page }) => {
  await page.goto('/?q=ACC1701XB&open=ACC1701XB');
  const d = await region(page, 'ACC1701XB');
  await expect(d.locator('.prereq-line')).toHaveText('No course prerequisite (the rule names NUS intake years only)');
  await expect(d.locator('details.as-stated .nus-text')).toBeHidden();
  await d.locator('details.as-stated summary').click();
  await expect(d.locator('details.as-stated .nus-text')).toHaveText('If undertaking an Undergraduate Degree THEN must be in one of the cohorts from 2017 inclusive');
  await expect(d.getByRole('heading', { name: 'Preclusions' })).toBeVisible();
  await expect(d).toContainText('0200ACCHON Bachelor of Business Administration (Accountancy)');
});

test('outside exchange mode the detail has the table for all five years', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  const d = await region(page, 'CS3244');
  const table = d.locator('table.exchange-table');
  await expect(table.locator('tbody th')).toHaveText(['1st year', '2nd year', '3rd year', '4th year or later', 'Graduate']);
  await expect(table.locator('thead th')).toHaveText(['Year of study', 'Sem 1', 'Sem 2']);
  await expect(table.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText('Open to exchange students');
});

test('"not listed" texts: no exam, no workload; and NUS\'s raw workload text (intercepted)', async ({ page }) => {
  await page.goto('/?q=CS5562&open=CS5562');
  await expect(await region(page, 'CS5562')).toContainText('No final exam listed');
  await page.goto('/?q=BMC5415&open=BMC5415');
  await expect(await region(page, 'BMC5415')).toContainText('Workload not listed');
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), workload: { raw: '3-.5-0--0-6.5' } } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  await expect(await region(page, 'CS3244')).toContainText('As NUS lists it: 3-.5-0--0-6.5');
});

test('the detail is fetched once: close and reopen reads it from memory', async ({ page }) => {
  await page.goto('/?q=CS3244');
  const seen = /** @type {string[]} */ ([]);
  page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/module/')) seen.push(r.url()); });
  await toggle(page, 'CS3244').click();
  await expect(await region(page, 'CS3244')).toContainText('Description');
  await toggle(page, 'CS3244').click();
  await expect(await region(page, 'CS3244')).toBeHidden();
  await toggle(page, 'CS3244').click();
  await expect(await region(page, 'CS3244')).toContainText('Workload');
  expect(seen).toHaveLength(1);
});

test('a failed /module says so in plain words and retries', async ({ page }) => {
  let calls = 0;
  await page.route('**/module/CS3244', (route) => {
    calls += 1;
    return calls === 1 ? route.fulfill({ status: 502, json: { error: 'upstream_failure', message: 'D1_ERROR' } }) : route.continue();
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const d = await region(page, 'CS3244');
  await expect(d).toContainText('The course details could not be loaded. The search service could not reach its course data.');
  await expect(d).not.toContainText(/upstream|D1_ERROR/);
  await d.getByRole('button', { name: 'Try again' }).click();
  await expect(d).toContainText('Workload');
});

test('a course code in the detail runs a search for it, in place', async ({ page }) => {
  await page.goto('/?q=CS3244&open=CS3244');
  const d = await region(page, 'CS3244');
  await d.getByRole('link', { name: 'CS2040S', exact: true }).click();
  await expect.poll(() => query(page)).toBe('q=CS2040S');
  await expect(page.locator('#q')).toHaveValue('CS2040S');
  await page.goBack();
  await expect.poll(() => query(page)).toBe('q=CS3244&open=CS3244');
  await expect(await region(page, 'CS3244')).toBeVisible();
});

test('[F8] detail fields render as text, never as markup', async ({ page }) => {
  const evil = '<img src=x onerror="window.__pwned=1">';
  await page.route('**/module/CS3244', async (route) => {
    const res = await route.fetch();
    route.fulfill({ response: res, json: { ...(await res.json()), description: evil, prerequisite: evil, preclusion: evil, nusmodsUrl: 'javascript:alert(1)' } });
  });
  await page.goto('/?q=CS3244&open=CS3244');
  const d = await region(page, 'CS3244');
  await expect(d.getByText(evil).first()).toBeVisible();
  await expect(d.getByRole('link', { name: 'Class times and timetable on NUSMods' })).toHaveCount(0);
  expect(await d.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => /** @type {any} */ (globalThis).__pwned)).toBeUndefined();
});
