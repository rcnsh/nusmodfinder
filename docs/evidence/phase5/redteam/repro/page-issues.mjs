#!/usr/bin/env node
// @ts-check
// Phase 5 red team: local reproductions of the page issues the personas
// reported (redteam.md "Page findings"). Run against `npm run dev` only:
//   node docs/evidence/phase5/redteam/repro/page-issues.mjs http://127.0.0.1:N
// 1. Preclusions keep NUS's glued keywords ("DegreeTHEN(", "DOR("); the
//    prerequisite beside them is spaced by cleanPrereq.
// 2. The count line for typed codes names a fourth, unpinned code as if it led
//    the list ("shown: A, B, C, D, then N other matches") wherever it ranks.
import { chromium } from '@playwright/test';
import { codesCount } from '../../../../../public/explain.js';

const base = process.argv[2];
if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) { console.error('usage: page-issues.mjs http://127.0.0.1:N (local only)'); process.exit(2); }
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${base}/?q=ACC1701XA&open=ACC1701XA`);
const pre = page.locator('section', { has: page.getByRole('heading', { name: 'Preclusions' }) }).first();
await pre.waitFor({ timeout: 30_000 });
const text = (await pre.innerText()).replace(/\s+/g, ' ');
console.log(`1. ACC1701XA preclusions: ${text}`);
console.log(`   glued keyword shown: ${/[a-z)](THEN|AND|OR)\(|\b[A-Z][+-]?(OR|AND)\(/.test(text)}`);
await browser.close();

const results = [{ code: 'AR3101' }, { code: 'AR4601' }, { code: 'AR3223' }, ...Array.from({ length: 16 }, (_, i) => ({ code: `XX${1000 + i}` })), { code: 'PF3210' }];
const c = codesCount('AR3101 AR4601 AR3223 PF3210', results);
console.log(`2. count line with PF3210 ranked 20th: "${c.count}${c.rest}"`);
