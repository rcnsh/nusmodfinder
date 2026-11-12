#!/usr/bin/env node
// @ts-check
// WCAG AA contrast for the page's colours: every text/background
// pair and every UI-boundary pair public/styles.css uses, in both themes,
// read from the stylesheet's own tokens (the light :root and the dark one under
// prefers-color-scheme), so a token change is checked where it is made.
//
//   npm run contrast        prints each pair; exits 1 if any fails
//
// test/web/contrast.node.test.js runs the same check in `npm test`. Text needs
// 4.5:1; large text and UI boundaries (control edges, focus rings, status
// shapes, rules that carry meaning) need 3:1. Decorative hairlines (--rule)
// and the dialog backdrop carry no meaning and are not checked.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../public/styles.css', import.meta.url));

/**
 * Every pair: [foreground token, background token, minimum, where the page uses it].
 * @type {readonly [string, string, number, string][]}
 */
export const PAIRS = Object.freeze([
  // Text, 4.5:1.
  ['ink', 'ground', 4.5, 'body text, titles, codes, exam times'],
  ['ink', 'surface', 4.5, 'inputs, the open sheet, the hidden-codes box, chips'],
  ['ink', 'panel', 4.5, 'notes, sources, NUS\'s quoted text'],
  ['ink', 'accent-tint', 4.5, 'the chosen tile and pill'],
  ['ink', 'note-tint', 4.5, 'the keyword-only note'],
  ['ink', 'hide-tint', 4.5, 'an error message'],
  ['ink-2', 'ground', 4.5, 'secondary text: department, units, labels, hints, placeholders'],
  ['ink-2', 'surface', 4.5, 'secondary text on the sheet, tiles and inputs (placeholder)'],
  ['ink-2', 'panel', 4.5, 'note scopes and sources'],
  ['ink-2', 'accent-tint', 4.5, 'the chosen tile\'s months'],
  ['accent', 'ground', 4.5, 'links, the chosen segment, "Browse all courses"'],
  ['accent', 'surface', 4.5, 'links on the sheet, "Your semester"'],
  ['accent', 'panel', 4.5, 'course codes linked inside NUS\'s text'],
  ['accent', 'accent-tint', 4.5, 'the chosen semester segment\'s label, the tick'],
  ['on-accent', 'accent-fill', 4.5, 'the Search button\'s label'],
  ['open', 'open-tint', 4.5, '"Open" stamp text'],
  ['note', 'note-tint', 4.5, '"Open, with notes" stamp text'],
  ['hide', 'hide-tint', 4.5, '"Not open" stamp text'],
  ['hide', 'ground', 4.5, 'the set-up\'s "choose" message'],
  // UI boundaries and meaningful shapes, 3:1.
  ['edge', 'ground', 3, 'control edges: inputs, selects, chips, buttons, tiles'],
  ['edge', 'surface', 3, 'control edges on white, the sheet\'s edge'],
  ['edge', 'panel', 3, 'anything outlined inside a panel'],
  ['accent', 'ground', 3, 'focus ring, chosen option border'],
  ['accent', 'surface', 3, 'focus ring on the sheet and inputs'],
  ['accent-fill', 'ground', 3, 'the Search button\'s shape, a checked box'],
  ['accent-fill', 'surface', 3, 'a checked box on white'],
  ['open', 'ground', 3, 'the "Open" mark in the key, the stamp\'s outline'],
  ['note', 'ground', 3, 'the "notes" mark in the key, the stamp\'s outline'],
  ['hide', 'ground', 3, 'the "not open" mark in the key, the stamp\'s outline'],
  ['open', 'surface', 3, 'status marks in the sheet\'s table'],
  ['note', 'surface', 3, 'status marks in the sheet\'s table'],
  ['hide', 'surface', 3, 'the hidden-codes box\'s rule and marks'],
  ['note', 'panel', 3, 'the notes aside\'s left rule'],
  ['ink-2', 'surface', 3, 'a chip\'s remove cross, the chevron'],
]);

/**
 * The custom properties of the first `:root { … }` block in `css`.
 * @param {string} css
 * @returns {Record<string, string>}
 */
function tokens(css) {
  const body = css.match(/:root\s*\{([^}]*)\}/)?.[1] ?? '';
  return Object.fromEntries([...body.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]));
}

/**
 * The light and the dark tokens of a stylesheet: the top-level :root, and the
 * :root inside `@media (prefers-color-scheme: dark)` laid over it.
 * @param {string} css
 */
export function themes(css) {
  const light = tokens(css);
  const at = css.indexOf('@media (prefers-color-scheme: dark)');
  if (at < 0) throw new Error('styles.css has no dark theme');
  const dark = { ...light, ...tokens(css.slice(at)) };
  return { light, dark };
}

/** @param {string} hex */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio. @param {string} a @param {string} b */
export function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every pair in every theme.
 * @param {string} [css] the stylesheet's text
 * @returns {{ theme: string, fg: string, bg: string, fgHex: string, bgHex: string, min: number, ratio: number, ok: boolean, use: string }[]}
 */
export function check(css = readFileSync(CSS, 'utf8')) {
  const out = [];
  for (const [theme, t] of Object.entries(themes(css))) {
    for (const [fg, bg, min, use] of PAIRS) {
      if (!t[fg] || !t[bg]) throw new Error(`${theme}: no token --${t[fg] ? bg : fg}`);
      const r = ratio(t[fg], t[bg]);
      out.push({ theme, fg, bg, fgHex: t[fg], bgHex: t[bg], min, ratio: r, ok: r >= min, use });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rows = check();
  let theme = '';
  for (const r of rows) {
    if (r.theme !== theme) { theme = r.theme; console.log(`\n${theme}`); }
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.ratio.toFixed(2).padStart(5)}:1 (≥${r.min})  --${r.fg} ${r.fgHex} on --${r.bg} ${r.bgHex}  ${r.use}`);
  }
  const fails = rows.filter((r) => !r.ok).length;
  console.log(fails ? `\n${fails} of ${rows.length} pairs fail` : `\nAll ${rows.length} pairs pass (${PAIRS.length} per theme)`);
  process.exit(fails ? 1 : 0);
}
