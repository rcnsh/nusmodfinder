// @ts-check
// Typed codes the page does not show (Phase 5 5C, D4, C2-4, C3-1, C3-2): each
// hidden code with its own stored reasons and sources, codes not offered this
// year, a partial code exchange mode empties (with and without "see Sem 2"),
// and the typed codes past the three that pin. A hidden course is never a
// result card (SC1).
import { expect, test } from '@playwright/test';
import { body, query } from './support.mjs';

const cards = (/** @type {import('@playwright/test').Page} */ page) => page.locator('#results button.card-toggle');

test('[D4] four typed codes at 2nd year, Sem 1: each hidden one says why, from its own reasons and sources', async ({ page }) => {
  await page.goto('/?q=CS2030+CS3244+CS5562+AR5801&ng=1&study=ug2&sem=1');
  const lines = page.locator('#status .hidden-codes .why');
  await expect(lines).toHaveText([
    'CS3244 is open to exchange students only in Sem 2 (NG list, updated 01 Sep 2026).',
    "CS5562 isn't on the Registrar's list of courses offered to exchange students (NG list, updated 01 Sep 2026).",
    "AR5801 isn't open to exchange students in Sem 1 at 2nd year. Level 5000 and 6000 courses are not open to exchange students unless a department says so (NG restrictions, updated 31 Aug 2026).",
  ]);
  // Each line is headed by the code and its title (direction D), the title from /module/:code.
  await expect(page.locator('#status .hidden-codes li[data-code="CS3244"] .hc-head')).toHaveText('CS3244Machine Learning');
  await expect(page.locator('#status .hiddenbox h2')).toHaveText("3 of the 4 codes you typed aren't shown");
  await expect(cards(page).first()).toHaveAttribute('data-code', 'CS2030');
  for (const code of ['CS3244', 'CS5562', 'AR5801']) await expect(page.locator(`#results button[data-code="${code}"]`)).toHaveCount(0);
  await expect(page.locator('#status .unpinned')).toHaveText('Only the first three course codes you type that are offered this year are pinned to the top of the results.');
});

test('[D4] both semesters: a code closed in both says why for either semester', async ({ page }) => {
  await page.goto('/?q=CS2030+PP5164&ng=1&study=ug2');
  await expect(page.locator('#status .hidden-codes .why')).toHaveText([
    "PP5164 isn't open to exchange students in either semester at 2nd year. Level 5000 and 6000 courses are not open to exchange students unless a department says so (NG restrictions, updated 31 Aug 2026). Undergraduates may not take Public Policy (PP) courses (NG restrictions, updated 31 Aug 2026).",
  ]);
});

test('a typed code hidden by another filter says which filter', async ({ page }) => {
  await page.goto('/?q=CS2030+CS3244&level=3');
  await expect(page.locator('#status .hidden-codes .why')).toHaveText(['CS2030 is hidden by your filters: it is a level 2000 course.']);
});

test('a lone hidden code: no results, and why, never "loosen a filter"', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body({ query: 'CS3244', filters: { sem: 1, ng: true, study: 'ug2' }, count: 0, results: [], hiddenPins: ['CS3244'], notOffered: [] }) }));
  await page.goto('/?q=CS3244&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status')).toContainText('No results for “CS3244”.');
  await expect(page.locator('#status .hidden-codes .why')).toHaveText(['CS3244 is open to exchange students only in Sem 2 (NG list, updated 01 Sep 2026).']);
  await expect(page.locator('#status')).not.toContainText(/loosen/i);
});

test('a code not offered this year, inside a list and as the whole query (with related courses)', async ({ page }) => {
  await page.goto('/?q=CS2030+CS1001');
  await expect(page.locator('#status .hidden-codes .why')).toHaveText(["CS1001 isn't offered this academic year."]);
  await page.route('**/search?**', (route) => route.fulfill({ json: body({
    query: 'CS1001', count: 0, results: [], hiddenPins: [], notOffered: ['CS1001'],
    noMatch: { reason: 'not-offered', code: 'CS1001', title: 'Programming Methodology', related: ['CS1010', 'CS2030'] },
  }) }));
  await page.goto('/?q=CS1001');
  await expect(page.locator('#status')).toContainText("CS1001 (Programming Methodology) isn't offered this academic year.");
  await expect(page.locator('#status .hidden-codes')).toHaveCount(0);
  const related = page.locator('#status .related a');
  await expect(related).toHaveText(['CS1010', 'CS2030']);
  await expect(related.first()).toHaveAttribute('href', '/?q=CS1010');
  await page.unroute('**/search?**');
  await related.first().click();
  await expect.poll(() => query(page)).toBe('q=CS1010');
});

test('[C3-2] a partial code emptied in Sem 1, open in Sem 2: says so, and the button shows Sem 2', async ({ page }) => {
  await page.goto('/?q=CG32&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status .partial')).toHaveText('No CG32xx course is open to exchange students in Sem 1 at 2nd year.');
  const see = page.getByRole('button', { name: 'See Sem 2 courses' });
  await expect(see).toBeVisible();
  await expect(page.locator('#status')).not.toContainText(/loosen/i);
  await see.click();
  await expect.poll(() => query(page)).toBe('q=CG32&sem=2&ng=1&study=ug2');
  await expect(page.locator('#sem')).toHaveValue('2');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute('data-code', 'CG3201');
});

test('[C3-2] a partial code empty in both semesters: either semester, no button', async ({ page }) => {
  await page.goto('/?q=AI52&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status .partial')).toHaveText('No AI52xx course is open to exchange students in either semester at 2nd year.');
  await expect(page.locator('#status button')).toHaveCount(0);
  await page.goto('/?q=AI52&ng=1&study=ug2');
  await expect(page.locator('#status .partial')).toHaveText('No AI52xx course is open to exchange students in either semester at 2nd year.');
  await expect(page.locator('#status button')).toHaveCount(0);
  await expect(page.locator('#status')).not.toContainText(/loosen/i);
});

test('only the first three typed codes pin: a 4th that is neither shown nor explained is named', async ({ page }) => {
  await page.route('**/search?**', (route) => route.fulfill({ json: body({
    query: 'CS2030 CS1010 CS2113 CS2104', filters: {}, count: 3, interpreted: { pin: ['CS2030', 'CS1010', 'CS2113'] }, hiddenPins: [], notOffered: [],
    results: ['CS2030', 'CS1010', 'CS2113'].map((code) => ({ code, title: code, credits: 4, semesters: [1], score: 1 })),
  }) }));
  await page.goto('/?q=CS2030+CS1010+CS2113+CS2104');
  await expect(page.locator('#status .unpinned')).toHaveText('Only the first three course codes you type that are offered this year are pinned to the top of the results. CS2104 is not in these results: search for it on its own.');
});

test('only the first three typed codes pin, on the fixture: the 4th is either a card or named', async ({ page }) => {
  await page.goto('/?q=CS2030+CS1010+CS2113+CS2104&ng=1&study=ug2&sem=1');
  const note = page.locator('#status .unpinned');
  await expect(note).toContainText('Only the first three course codes you type that are offered this year are pinned to the top of the results.');
  const shown = await page.locator('#results button[data-code="CS2104"]').count();
  if (shown) await expect(note).not.toContainText('CS2104');
  else await expect(note).toContainText('CS2104 is not in these results');
});

test('three typed codes or fewer: no pin note', async ({ page }) => {
  await page.goto('/?q=CS2030+CS3244&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status .hidden-codes .why')).toHaveCount(1);
  await expect(page.locator('#status .unpinned')).toHaveCount(0);
});

test('a hidden code in exchange mode never blames the timetable semester (the NG list decides it)', async ({ page }) => {
  await page.goto('/?q=CS2030+ACC1701XB&level=2&ng=1&study=ug2&sem=1');
  await expect(page.locator('#status .hidden-codes .why')).toHaveText(['ACC1701XB is hidden by your filters: it is a level 1000 course.']);
});
