#!/usr/bin/env node
// @ts-check
// Phase 6 6-0: the mockup against `npm run contrast`'s bar (WCAG AA), by that
// script's own check() (scripts/contrast.mjs), not a copy of it.
//
//   node docs/design/phase6-shortlist/contrast.mjs     exits 1 on any failure
//
// 1. a/page.css's tokens, in both themes, pass every pair scripts/contrast.mjs
//    checks (and equal public/styles.css's, so the mockup is the live palette);
// 2. a/shortlist.css adds no colour: every hex it writes is one of those
//    tokens' values, and its forced-theme and paper blocks repeat them exactly,
//    so every pair it draws is a pair (1) checked.
// check.mjs then runs axe's colour-contrast rule over every rendered state.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { check, themes } from '../../../scripts/contrast.mjs';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const pageCss = readFileSync(here('./a/page.css'), 'utf8');
const liveCss = readFileSync(here('../../../public/styles.css'), 'utf8');
const slCss = readFileSync(here('./a/shortlist.css'), 'utf8');

let fails = 0;
const rows = check(pageCss);
for (const theme of ['light', 'dark']) {
  const own = rows.filter((r) => r.theme === theme);
  const bad = own.filter((r) => !r.ok);
  fails += bad.length;
  const worst = own.reduce((a, r) => (r.ratio / r.min < a.ratio / a.min ? r : a));
  console.log(`${theme}: ${own.length - bad.length}/${own.length} pairs pass; closest to its bar: --${worst.fg} on --${worst.bg} ${worst.ratio.toFixed(2)}:1 (≥${worst.min})`);
  for (const r of bad) console.log(`  FAIL ${r.ratio.toFixed(2)}:1 --${r.fg} on --${r.bg} (${r.use})`);
}

const live = themes(liveCss);
const mine = themes(pageCss);
for (const theme of /** @type {const} */ (['light', 'dark'])) {
  for (const [k, v] of Object.entries(live[theme])) {
    if (mine[theme][k] !== v) { fails++; console.log(`FAIL page.css --${k} (${theme}) is ${mine[theme][k]}, live ${v}`); }
  }
}

/** @param {string} sel */
function block(sel) {
  const at = slCss.indexOf(sel);
  const body = slCss.slice(slCss.indexOf('{', at) + 1, slCss.indexOf('}', at));
  return Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2].toUpperCase()]));
}
const same = (name, got, want, keys = Object.keys(got)) => {
  for (const k of keys) {
    if (got[k] !== want[k]?.toUpperCase()) { fails++; console.log(`FAIL ${name}: --${k} is ${got[k]}, want ${want[k]}`); }
  }
};
same(':root[data-theme="light"]', block(':root[data-theme="light"]'), mine.light);
same(':root[data-theme="dark"]', block(':root[data-theme="dark"]'), mine.dark);
// Paper: the light tokens, except a white ground (light --surface).
const paper = block('.sl-paper {');
same('.sl-paper', paper, { ...mine.light, ground: mine.light.surface });
same('@media print :root', block(':root, :root[data-theme] {'), { ...mine.light, ground: mine.light.surface });

const allowed = new Set([...Object.values(mine.light), ...Object.values(mine.dark)].map((v) => v.toUpperCase()));
const stray = [...slCss.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toUpperCase()).filter((v) => !allowed.has(v));
if (stray.length) { fails += stray.length; console.log(`FAIL shortlist.css writes colours that aren't tokens: ${[...new Set(stray)].join(', ')}`); }
else console.log('shortlist.css: every colour is a D token (forced themes and paper repeat page.css exactly)');

console.log(fails ? `\n${fails} failure(s)` : '\nAll pass');
process.exit(fails ? 1 : 0);
