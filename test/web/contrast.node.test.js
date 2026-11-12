// @ts-check
// Every text/background and UI-boundary pair the page uses
// passes WCAG AA in both themes, from public/styles.css's own tokens
// (scripts/contrast.mjs), and every colour token the stylesheet puts on text,
// a background or a border is one the check covers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAIRS, check, ratio, themes } from '../../scripts/contrast.mjs';

const css = readFileSync(fileURLToPath(new URL('../../public/styles.css', import.meta.url)), 'utf8');

/** Tokens a property uses in the stylesheet. @param {RegExp} prop */
const used = (prop) => new Set([...css.matchAll(new RegExp(`(?:^|[;{\\s])${prop.source}\\s*:([^;}]*)`, 'g'))]
  .flatMap((m) => [...m[1].matchAll(/var\(--([\w-]+)\)/g)].map((v) => v[1])));

describe('contrast, both themes', () => {
  it('every text/background and UI-boundary pair passes WCAG AA (4.5:1 text, 3:1 UI) in light and dark', () => {
    const rows = check(css);
    expect(rows).toHaveLength(PAIRS.length * 2);
    expect(rows.filter((r) => !r.ok).map((r) => `${r.theme}: --${r.fg} on --${r.bg} ${r.ratio.toFixed(2)}`)).toEqual([]);
  });

  it('both themes define every token, and dark redefines every colour', () => {
    const { light, dark } = themes(css);
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    const darkOnly = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
    for (const name of Object.keys(light)) expect(darkOnly, name).toContain(`--${name}:`);
  });

  it('every token used for text, a background or a border is in a checked pair', () => {
    const fg = new Set(PAIRS.map((p) => p[0]));
    const bg = new Set(PAIRS.map((p) => p[1]));
    // Decorative, never meaning: hairlines, skeleton blocks, the dialog backdrop.
    const decorative = new Set(['rule', 'skeleton', 'backdrop']);
    expect(used(/color/).size).toBeGreaterThan(5);
    expect(used(/background(?:-color)?/).size).toBeGreaterThan(8);
    for (const t of used(/color/)) expect(fg.has(t), `color: --${t}`).toBe(true);
    for (const t of used(/background(?:-color)?/)) if (!decorative.has(t)) expect(bg.has(t) || fg.has(t), `background: --${t}`).toBe(true);
    for (const t of used(/border(?:-[a-z]+)*/)) if (!decorative.has(t)) expect(fg.has(t), `border: --${t}`).toBe(true);
  });

  it('the ratio is WCAG 2\'s: black on white is 21:1, a colour on itself 1:1', () => {
    expect(ratio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(ratio('#6A2E56', '#6A2E56')).toBe(1);
  });
});
