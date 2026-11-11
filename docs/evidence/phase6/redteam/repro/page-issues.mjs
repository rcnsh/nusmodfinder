#!/usr/bin/env node
// @ts-check
// Phase 6 red team: a local repro of the page defect the personas found (RT6-PD1),
// with no Worker, no wrangler and no live request. Chromium loads the page
// from public/ on disk; /facets and /module/:code are answered from the live
// answers p2's session received (answers/, saved from the run's cache); any
// other request is refused.
//
//   node docs/evidence/phase6/redteam/repro/page-issues.mjs
//
// RT6-PD1: a list with picks in both semesters, opened with sem=2, gets the
// view's subheading "Sem 2 · 3rd-year exchange student · NUS's 2026/27 courses"
// (public/shortlist-view.js update(): `m.sem` is the semester filter, not the
// list's semesters). The approved 6-0 mockup's full-year state (sem changed to 2
// in the view) reads "Sem 1 and Sem 2 · …" (docs/design/phase6-shortlist/a/mockup.js
// stateFullYear). Exits 1 while the defect is there, 0 once fixed.
import { readFileSync, existsSync } from 'node:fs';
import { extname } from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = new URL('../../../../../', import.meta.url);
const HERE = new URL('.', import.meta.url);
const ORIGIN = 'http://redteam.invalid';
const LINK = '/?sem=2&ng=1&study=ug3&pick=ST4234.2&pick=MA4251.2&pick=ST3247.2&pick=ST2137.2&pick=MA3210.1&pick=ST3131.1&pick=ST3236.1&pick=ST3248.1&alt=ST4253.1&alt=ST4248.2&ay=2026-2027&view=shortlist';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 390, height: 664 } })).newPage();
await page.route('**/*', async (route) => {
  const u = new URL(route.request().url());
  if (u.origin !== ORIGIN) return route.abort('blockedbyclient');
  if (u.pathname === '/facets' || u.pathname.startsWith('/module/')) {
    const f = new URL(`answers/${u.pathname.slice(1).replace('/', '-')}.json`, HERE);
    if (!existsSync(f)) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"not in the repro"}' });
    const a = JSON.parse(readFileSync(f, 'utf8'));
    return route.fulfill({ status: a.status, contentType: a.contentType, body: JSON.stringify(a.body) });
  }
  const file = new URL(`public${u.pathname === '/' ? '/index.html' : u.pathname}`, ROOT);
  if (!existsSync(file)) return route.fulfill({ status: 404, body: '' });
  return route.fulfill({ status: 200, contentType: TYPES[/** @type {keyof TYPES} */ (extname(file.pathname))] ?? 'application/octet-stream', body: readFileSync(file) });
});
await page.goto(ORIGIN + LINK);
await page.locator('#slView .sl-sub').waitFor();
await page.waitForFunction(() => /10 courses loaded|Sem 1: 16/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {});
const sub = (await page.locator('#slView .sl-sub').innerText()).trim();
const sems = [...new Set((await page.locator('#slView').innerText()).match(/Application form, Sem [12]/g) ?? [])];
await browser.close();
const want = /^Sem 1 and Sem 2 · /;
console.log(`RT6-PD1: the list's entries are in ${sems.map((s) => s.slice(-5)).join(' and ')}; the view's subheading reads "${sub}"`);
console.log(want.test(sub) ? 'fixed: it names both semesters, as the mockup does' : 'defect: it names only the semester filter (the mockup: "Sem 1 and Sem 2 · …")');
process.exit(want.test(sub) ? 0 : 1);
