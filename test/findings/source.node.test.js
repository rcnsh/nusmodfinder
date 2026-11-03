// @ts-check
// Findings that are properties of the source, the docs or the committed data
// rather than of a request: the frontend (src/page.html), the README, the eval
// scripts and the NG list. Browser behaviour (focus, history, axe, layout) is
// cited from the recorded Playwright run in docs/evidence/phase0/ instead.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const exists = (/** @type {string} */ rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

const page = read('src/page.html');
const script = /** @type {string} */ (page.match(/<script>([\s\S]*)<\/script>/)?.[1]);
const css = /** @type {string} */ (page.match(/<style>([\s\S]*)<\/style>/)?.[1]);
// The Worker source, all modules (src/index.js is only the router since Phase 1).
const worker = readdirSync(fileURLToPath(new URL('../../src', import.meta.url)))
  .filter((f) => f.endsWith('.js')).sort().map((f) => read(`src/${f}`)).join('\n');
const readme = read('README.md');
const ngList = JSON.parse(read('data/ng-courses-2026-2027.json'));

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
  it('found the script, styles and result-card template in src/page.html', () => {
    for (const part of [script, css, card, lightRoot, darkRoot]) expect(part).toBeTruthy();
  });
});

describe('frontend', () => {
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

  it('[F8 known-bug] credits, semesters and the NG title attribute are interpolated into innerHTML unescaped', () => {
    expect(card).toContain("<span>${m.credits ?? '?'} units</span>");
    expect(card).toContain("${(m.semesters ?? []).length ? m.semesters.map((s) => SEM_NAMES[s] ?? s).join(', ') : 'Not offered'}");
    expect(card).toContain("title=\"Open to Non-Graduating (exchange) students in ${(m.ngSemesters ?? []).map(SEM_LABEL).join(', ') || 'this year'}\"");
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

  it('[P3 known-bug] no source links anywhere, and the title reads as official NUSMods', () => {
    expect(page).toContain('<title>NUSMods semantic search</title>');
    expect(page).toContain('<h1>NUSMods semantic search</h1>');
    expect(page).not.toMatch(/<a\b|href=/);
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

describe('ops', () => {
  it('[O1 fixed] the README rebuilds the schema from migrations/, which start at 0001 and include ng in the metadata loop', () => {
    expect(exists('schema.sql')).toBe(false);
    for (const f of ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql']) expect(exists(`migrations/${f}`)).toBe(true);
    expect(readme).toContain('npx wrangler d1 migrations apply nusmods --local');
    expect(readme).toContain('ng:boolean; do');
    expect(JSON.parse(read('package.json')).scripts['db:rebuild-check']).toBe('node scripts/schema-snapshot.mjs');
  });

  it('[O2 fixed] lint, typecheck, tests and the schema rebuild run in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const step of ['npm run lint', 'npm run typecheck', 'npm run types:check', 'npm test', 'npm run db:rebuild-check']) {
      expect(ci).toContain(`run: ${step}`);
    }
  });

  it('[O3 fixed] the NG list date has one source: ingest posts it from data/ng-courses-*.json, no copy is kept by hand', () => {
    expect(worker).not.toContain('NG_LIST_UPDATED');
    expect(worker).not.toContain(ngList.updatedAsAt);
    expect(readme).not.toContain('NG_LIST_UPDATED');
    const ingest = read('scripts/ingest.mjs');
    // The payload is built by scripts/lib.mjs facetsPayload (unit-tested in
    // test/facets-payload.node.test.js) and posted by the ingest core on every
    // run that gets past its guards (test/ingest.test.js drives it).
    expect(ingest).toContain('const facetsBody = facetsPayload(ngCourses);');
    expect(ingest).toContain('runIngest({ modules, facetsBody,');
    const core = read('scripts/ingest-core.mjs');
    expect(core.match(/send\('\/admin\/facets', facetsBody, 'facets'\)/g)).toHaveLength(1);
  });

  it('[O4 known-bug] wrangler.jsonc declares no cron trigger', () => {
    expect(read('wrangler.jsonc')).not.toMatch(/"triggers"|"crons"/);
  });

  it('[B9 fixed] README names Vectorize queried dims as the binding limit, with the arithmetic, and marks per-search D1 costs pending', () => {
    expect(readme).not.toContain('D1 row reads are the binding constraint');
    const cost = readme.slice(readme.indexOf('## Cost'), readme.indexOf('## Data source'));
    expect(cost).toContain('**Vectorize queried dimensions are the binding limit, not D1.**');
    // FINDINGS B9: 30,000,000 queried dims/month, billed as (stored vectors +
    // queries) x 384; D1 5,000,000 rows/day at Phase 0's ~50 rows per search.
    const vectorizePerMonth = 30_000_000 / 384 - 6771;
    const d1PerMonth = (5_000_000 / 50) * 30;
    expect(Math.round(vectorizePerMonth)).toBe(71354);
    expect(Math.round(d1PerMonth / vectorizePerMonth)).toBe(42);
    expect(cost).toContain('30,000,000 / 384 − 6,771 ≈ **71,354 uncached searches a month**');
    expect(cost).toContain(`about ${Math.round(vectorizePerMonth / 30).toLocaleString('en-US')} a day`);
    expect(cost).toContain('5,000,000 / 50 ≈ 100,000 searches a day');
    expect(cost).toContain('about 42× more');
    expect(cost).toContain('**5,000,000 / day**');
    expect(cost).toContain('30,000,000 / month');
    // Per-search D1 numbers after Phase 1 are measured after the deploy, not invented.
    expect(cost).toMatch(/\| \*\*D1 rows read\*\* \|[^\n]*\| per search: pending: measured after the Phase 1 deploy/);
  });
});

describe('eval (S1)', () => {
  it('[S1 known-bug] held-out relevance is a regex over titles, recall@10 ignores order, and hybrid MRR trails lexical', () => {
    const judge = read('eval/v1/judge-holdout.mjs');
    const rules = judge.match(/rule: \(m\) => [^\n]+/g) ?? [];
    expect(rules).toHaveLength(12);
    // 11 of 12 are a regex over the title; h1 is a department check.
    expect(rules.filter((r) => /^rule: \(m\) => \/.*\/i\.test\(m\.title\)/.test(r))).toHaveLength(11);

    const evalSrc = read('eval/v1/eval.mjs');
    expect(evalSrc).toContain("const K = Number(arg('k', fixture.k ?? 10));");
    expect(evalSrc).toContain('recall: h / q.relevant.length,');
    // Production returns 20 from a candidate depth of up to 50.
    expect(worker).toContain('const DEFAULT_TOPK = 20;');
    expect(worker).toContain('const MAX_TOPK = 50;');

    const evalMd = read('EVAL.md');
    expect(evalMd).toMatch(/MRR\s+0\.833\s+0\.674\s+0\.903\s+0\.820/);
    expect(evalMd).toContain('`ORDER BY rank` has not been re-run against these fixtures');
  });
});

describe('data', () => {
  /** @type {Map<string, number[]>} */
  const bySem = new Map();
  for (const [sem, list] of Object.entries(/** @type {Record<string, string[]>} */ (ngList.semesters))) {
    for (const code of list) bySem.set(code, [...(bySem.get(code) ?? []), Number(sem)]);
  }

  it('[P1 evidence] 934 of the 1,207 NG courses are open to exchange students in one semester only', () => {
    expect(bySem.size).toBe(1207);
    expect([...bySem.values()].filter((s) => s.length === 1)).toHaveLength(934);
  });

  it('[P2 evidence] 28 NG courses are level 5 or above', () => {
    const grad = [...bySem.keys()].filter((c) => Number(c.match(/\d/)?.[0]) >= 5);
    expect(grad).toHaveLength(28);
    expect(grad).toEqual(expect.arrayContaining(['LI5202', 'LI5204', 'PP5288']));
  });
});
