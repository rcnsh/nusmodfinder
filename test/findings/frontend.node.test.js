// @ts-check
// The Phase 0 frontend findings (F1–F10, P3, V1) as characterisation tests of
// the page as Phase 4 left it: docs/evidence/phase0/page-phase4.html, the old
// src/page.html committed frozen when Phase 5 5B moved the page to public/
// (A-3, A2-5). They assert the old source, so they stay true; each finding
// gets a correctness test against public/ in the workstream that fixes it
// (F2, F3, F4, F7, F8 and F9 in 5B: test/web/, test/ui/). Browser behaviour
// (focus, history, axe, layout) is cited from the recorded Playwright run in
// docs/evidence/phase0/.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

/** The Phase 4 page, frozen. */
const FROZEN_PAGE = 'docs/evidence/phase0/page-phase4.html';
const page = read(FROZEN_PAGE);
const script = /** @type {string} */ (page.match(/<script>([\s\S]*)<\/script>/)?.[1]);
const css = /** @type {string} */ (page.match(/<style>([\s\S]*)<\/style>/)?.[1]);

/** The result-card template inside render(). */
const card = /** @type {string} */ (script.match(/data\.results\.map\(\(m\) => `([\s\S]*?)`\)\.join/)?.[1]);

/** WCAG 2 contrast ratio of two #rrggbb / #rgb colours. */
function contrast(/** @type {string} */ a, /** @type {string} */ b) {
  const lum = (/** @type {string} */ hex) => {
    const h = hex.length === 4 ? hex.replace(/[0-9a-f]/gi, (c) => c + c).slice(1) : hex.slice(1);
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const token = (/** @type {string} */ block, /** @type {string} */ name) =>
  /** @type {string} */ (block.match(new RegExp(`--${name}:\\s*(#[0-9a-f]+)`, 'i'))?.[1]);
const lightRoot = /** @type {string} */ (css.match(/^\s*:root\s*\{([^}]*)\}/m)?.[1]);
const darkRoot = /** @type {string} */ (css.match(/prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/)?.[1]);

describe('harness sanity', () => {
  it('found the script, styles and result-card template in the frozen Phase 4 page', () => {
    for (const part of [script, css, card, lightRoot, darkRoot]) expect(part).toBeTruthy();
  });

  it('the frozen page is the Phase 4 src/page.html, byte for byte (sha256 ef0cadf8…)', () => {
    expect(createHash('sha256').update(page).digest('hex')).toBe('ef0cadf88624635d6c7b434c43df96085baa7da2056db47b91b198dc188bc07e');
  });
});

describe('frontend (the frozen Phase 4 page)', () => {
  it('[F1 known-bug] result cards are dead ends: no link, button or tabindex, no description, raw score', () => {
    expect(card).not.toMatch(/<a\b|<button\b|tabindex|href=/);
    expect(card).not.toContain('m.description');
    expect(script).not.toContain('/module/');
    expect(card).toContain('<span class="score">${(m.score ?? 0).toFixed(3)}</span>');
  });

  it('[F2 known-bug] search fetches have no AbortController and no timeout', () => {
    expect(script).toContain('await fetch(`/search?${params}`)');
    expect(script).not.toMatch(/AbortController|AbortSignal|signal:|setTimeout/);
  });

  it('[F3 known-bug] history uses replaceState only, never pushState, and nothing handles popstate', () => {
    expect(script).toContain("history.replaceState(null, '', `?${params}`)");
    expect(script).not.toContain('history.pushState');
    expect(script).not.toContain('popstate');
    // Clearing the query returns before the URL is touched, so the old ?q= stays.
    const search = /** @type {string} */ (script.match(/async function search[\s\S]*?\n}\n/)?.[0]);
    expect(search.indexOf('if (!q) {')).toBeLessThan(search.indexOf('history.replaceState'));
    expect(search.match(/if \(!q\) \{[^\n]*\}/)?.[0]).not.toContain('history');
  });

  it('[F4 known-bug] a failed /facets is swallowed and the shared-link search waits on it', () => {
    expect(script).toContain('.catch(() => { /* filters still work without the vocabulary */ });');
    // Level and faculty options only exist once /facets succeeded; restoring
    // .value on a select without that option is a silent no-op.
    expect(script).toMatch(/facetsReady\.then\(\(\) => \{\s*for \(const id of filterIds\) \{[\s\S]*?search\(false\);\s*\}\);/);
  });

  it('[F5 known-bug] no aria-live status, no aria-busy, no <main>, no role="search"; the focused button is disabled', () => {
    expect(page).toContain('<div id="status" class="status">');
    expect(page).not.toMatch(/aria-live|aria-busy|role="status"|<main\b|role="search"/);
    expect(script).toContain('els.go.disabled = true;');
  });

  it('[F6 known-bug] colour tokens fail WCAG AA: dark button 2.08:1, light <code>/NG badge 4.44:1', () => {
    expect(css).toMatch(/button \{[^}]*color: #fff; background: var\(--accent\)/);
    // axe reported 2.08 and 4.44 (docs/evidence/phase0/fe-results.json); the
    // WCAG formula here differs from axe's only in the last rounding digit.
    const darkButton = contrast('#fff', token(darkRoot, 'accent'));
    const lightBadge = contrast(token(lightRoot, 'accent'), token(lightRoot, 'accent-soft'));
    expect(darkButton).toBeCloseTo(2.08, 1);
    expect(lightBadge).toBeCloseTo(4.44, 1);
    expect(lightBadge).toBeLessThan(4.5);
  });

  it('[F7 known-bug] errors show raw codes, ignore Retry-After, and parse JSON before checking res.ok', () => {
    expect(script).toContain('<strong>${esc(body.error ?? res.status)}</strong>');
    expect(script).not.toMatch(/retry-after/i);
    expect(script.indexOf('const body = await res.json();')).toBeLessThan(script.indexOf('if (!res.ok)'));
    expect(script).toContain('Could not reach the search service.');
  });

  it('[F8 known-bug] credits and semesters are interpolated into innerHTML unescaped', () => {
    expect(card).toContain("<span>${m.credits ?? '?'} units</span>");
    expect(card).toContain("${(m.semesters ?? []).length ? m.semesters.map((s) => SEM_NAMES[s] ?? s).join(', ') : 'Not offered'}");
    // Phase 4 (4D): the NG badge's semesters and the exchange notes go through esc().
    expect(card).toContain("NG ${esc((m.ngSemesters ?? []).map(SEM_LABEL).join(', '))}");
  });

  it('[F9 known-bug] Enter fires a search even during IME composition', () => {
    expect(script).toContain("if (e.key === 'Enter') { e.preventDefault(); search(); }");
    expect(script).not.toMatch(/isComposing|keyCode|compositionstart|229/);
  });

  it('[F10 known-bug] 15px inputs (iOS zooms below 16px) and a score pushed to its own line on narrow cards', () => {
    expect(css).toMatch(/body \{[^}]*font: 15px\/1\.55/);
    expect(css).toMatch(/input\[type=search\], select \{[^}]*font: inherit/);
    expect(css).toContain('.head { display: flex; align-items: baseline; gap: 9px; flex-wrap: wrap; }');
    expect(css).toContain('.score { margin-left: auto;');
  });

  it('[P3 known-bug] the title reads as official NUSMods, and result cards link to no source', () => {
    expect(page).toContain('<title>NUSMods semantic search</title>');
    expect(page).toContain('<h1>NUSMods semantic search</h1>');
    expect(card).not.toMatch(/<a\b|href=/);
    // Phase 4 (4D) links the exchange-mode sources (the NG list, the restrictions) with their dates.
    expect(script).toContain('<a href="${esc(x.url)}"');
  });

  it('[V1 known-bug] orange accent everywhere, inconsistent filter labels, non-removable chips, dead-end empty state', () => {
    expect(token(lightRoot, 'accent')).toBe('#b4541f');
    expect((css.match(/var\(--accent\)/g) ?? []).length).toBeGreaterThanOrEqual(8);
    // "2" (semester option), "2000 (1016)" (level option), "sem: Sem 2" (chip).
    expect(page).toContain('<option value="2">2</option>');
    expect(script).toContain('new Option(`${l.level}000 (${l.count})`, l.level)');
    expect(script).toContain('`<span class="chip">${esc(k)}: ${esc(k === \'sem\' ? SEM_LABEL(v) : v)}</span>`');
    expect(page).not.toMatch(/<button[^>]*class="chip|chip[^"]*remove/);
    expect(script).toContain('Try loosening one.');
    expect(page).toMatch(/<p class="sub">[^<]*<code>CS3244<\/code>\. Data: unofficial NUSMods API/);
  });
});

