// @ts-check
// What students say (ADR 0018): the review panel in an entry's right-hand column, with the
// overall score and a word, a meter per score whose accessible name carries the number, how
// many reviews and how recent, and a link to read them on NUSMods; nothing under three
// reviews; under the exchange status in exchange mode.
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { axeViolations } from './support.mjs';

const reviews = JSON.parse(readFileSync(new URL('../../data/reviews.json', import.meta.url), 'utf8')).courses;
/** @param {import('@playwright/test').Page} page @param {string} code */
const card = (page, code) => page.locator('#results > li.card').filter({ has: page.locator(`button.card-toggle[data-code="${code}"]`) });

test('a course with reviews shows its scores, count, latest year and a link', async ({ page }) => {
  const r = reviews.CS1101S;
  expect(r.n).toBeGreaterThanOrEqual(3);
  await page.goto('/?q=CS1101S');
  const panel = card(page, 'CS1101S').locator('.rv-panel');
  await expect(panel.locator('.rv-head')).toHaveText('What students say');
  await expect(panel.locator('.rv-num')).toHaveText(r.overall.toFixed(1));
  await expect(panel.getByRole('img')).toHaveCount(3);
  await expect(panel.getByRole('img').first()).toHaveAccessibleName(`${r.workload.toFixed(1)} of 5, from light to heavy`);
  await expect(panel.getByRole('img').first().locator('i.on')).toHaveCount(Math.round(r.workload));
  await expect(panel.locator('.rv-foot')).toContainText(`${r.n} reviews, latest ${r.latest}.`);
  const link = panel.getByRole('link', { name: 'Read them on NUSMods' });
  await expect(link).toHaveAttribute('href', 'https://nusmods.com/courses/CS1101S/reviews');
  await expect(link).toHaveAttribute('target', '_blank');
  expect(await axeViolations(page)).toEqual([]);
});

test('a course with fewer than three reviews, or none, has no panel', async ({ page }) => {
  expect(reviews.CS1010A.n).toBeLessThan(3);
  expect(reviews.PC3294).toBeUndefined();
  await page.goto('/?q=CS1010A+PC3294');
  await expect(card(page, 'CS1010A')).toHaveCount(1);
  await expect(card(page, 'CS1010A').locator('.rv-panel')).toHaveCount(0);
  await expect(card(page, 'PC3294').locator('.rv-panel')).toHaveCount(0);
});

test('in exchange mode the panel sits under the exchange status', async ({ page }) => {
  await page.goto('/?q=CS1010&ng=1&study=ug2&sem=1');
  // One right-hand column: the exchange status, then the panel.
  const guide = card(page, 'CS1010').locator('.guide');
  await expect(guide).toHaveCount(1);
  await expect(guide.locator('> .exchange + .rv-panel .rv-num')).toHaveText(reviews.CS1010.overall.toFixed(1));
});
