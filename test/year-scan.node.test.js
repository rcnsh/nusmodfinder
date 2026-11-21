// @ts-check
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';
import { PINNED_ACAD_YEAR, PINNED_RELEASE } from '../scripts/pinned-corpus.mjs';
import { DEFAULT_ACAD_YEAR as PAGE_YEAR } from '../public/year.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const YEAR = /\b20\d\d\b/g;

const NOT_YEARS = [
  { re: /U\+[0-9A-F]{4}(?:-[0-9A-F]{4})?/g, why: 'a CSS unicode-range code point (Google Fonts\' @font-face ranges)' },
  { re: /www\.w3\.org\/2000\//g, why: 'the SVG and XML namespace URIs, fixed by the W3C' },
];

const PER_YEAR_FILE = /^(?:scripts\/ng-overlay\/|test\/oracle\/oracle-)\d{4}-\d{4}(?:\.node)?\.mjs$/;

const FILES = {
  'src/fts-separators.js': 'generated hex code-point ranges (scripts/gen-fts-separators.mjs)',
  'public/fonts/OFL.txt': 'the fonts\' licence, as its authors wrote it',
};

const yearLabel = (/** @type {string} */ y) => `${y.slice(0, 4)}/${y.slice(7, 9)}`;

/** @type {{ file: string, text: string, kind: 'live' | 'pinned' | 'cited', why: string }[]} */
const ALLOWED = [
  { file: 'scripts/lib.mjs', text: `export const DEFAULT_ACAD_YEAR = '${DEFAULT_ACAD_YEAR}';`, kind: 'live', why: 'the one year source' },
  { file: 'public/year.js', text: `export const DEFAULT_ACAD_YEAR = '${DEFAULT_ACAD_YEAR}';`, kind: 'live', why: 'the page has no import from scripts/; checked equal' },
  { file: 'public/index.html', text: `Academic year ${yearLabel(DEFAULT_ACAD_YEAR)}`, kind: 'live', why: 'the header before any row loads; checked equal' },
  { file: 'scripts/pinned-corpus.mjs', text: `export const PINNED_ACAD_YEAR = '${PINNED_ACAD_YEAR}';`, kind: 'pinned', why: 'the eval\'s corpus never moves (ADR 0003)' },
  { file: 'scripts/pinned-corpus.mjs', text: `export const PINNED_RELEASE = '${PINNED_RELEASE}';`, kind: 'pinned', why: 'the pinned corpus\'s release asset; checked to name the pinned year' },
  { file: 'public/shortlist.js', text: 'NUS info sheet, 2018/19', kind: 'cited', why: 'NUS\'s exchange information sheet, cited by its own year' },
  { file: 'public/shortlist.js', text: '2018/19 exchange information sheet', kind: 'cited', why: 'the same sheet, in the page\'s own words' },
];

const READS_REAL_DATA = /pinned-corpus|corpus-manifest|inject\('corpus'\)|data\/ng-(?:courses|restrictions)-|loadNg(?:Courses|Restrictions)\(/;
const TEXT = /\.(?:js|mjs|cjs|ts|mts|html|css|json|jsonc|svg|txt|md|py|webmanifest)$|\/_headers$/;

/**
 * @param {string} file
 * @param {string} text
 * @returns {string[]}
 */
export function unallowedYears(file, text) {
  if (Object.hasOwn(FILES, file) || PER_YEAR_FILE.test(file)) return [];
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /** @type {[number, number][]} */
    const covered = [];
    for (const { re } of NOT_YEARS) for (const m of line.matchAll(re)) covered.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
    for (const a of ALLOWED) {
      if (a.file !== file) continue;
      let at = line.indexOf(a.text);
      while (at >= 0) { covered.push([at, at + a.text.length]); at = line.indexOf(a.text, at + 1); }
    }
    for (const m of line.matchAll(YEAR)) {
      const s = m.index ?? 0;
      if (covered.some(([a, b]) => s >= a && s + m[0].length <= b)) continue;
      out.push(`${file}:${i + 1}: ${line.slice(Math.max(0, s - 40), s + 30).trim()}`);
    }
  }
  return out;
}

function scannedFiles() {
  const r = spawnSync('git', ['ls-files', 'src', 'public', 'scripts', 'test'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.split('\n').filter((f) => f && TEXT.test(f)).filter((f) => {
    if (!f.startsWith('test/')) return true;
    if (f === 'test/year-scan.node.test.js' || f.startsWith('test/fixtures/')) return false;
    return READS_REAL_DATA.test(readFileSync(join(ROOT, f), 'utf8'));
  });
}

describe('one year source: the year scan', () => {
  it('finds a year in a string, a comment and a data-file name', () => {
    expect(unallowedYears('src/x.js', "const y = '2026-2027'; // Academic year 2026/27\nimport x from '../data/ng-courses-2026-2027.json';"))
      .toHaveLength(5);
  });

  it('skips a year\'s own overlay and oracle, and nothing else named by a year', () => {
    const y = DEFAULT_ACAD_YEAR;
    expect(unallowedYears(`scripts/ng-overlay/${y}.mjs`, '// The 2026/27 overlay')).toEqual([]);
    expect(unallowedYears(`test/oracle/oracle-${y}.node.mjs`, '// D1 (2026/27)')).toEqual([]);
    expect(unallowedYears(`scripts/ng-overlay/${y}-notes.mjs`, '// 2026/27')).toHaveLength(1);
    expect(unallowedYears(`src/${y}.js`, '// 2026/27')).toHaveLength(1);
  });

  it('does not match a year inside a hex string, a longer number or a numeric separator', () => {
    expect(unallowedYears('src/x.js', [
      "const sha = 'a2026b9f2027c'; const rel = '20261104abc'; const id = 'f02026';",
      'const n = 20260; const ms = 2_000; const big = 120261;',
    ].join('\n'))).toEqual([]);
  });

  it('allows the listed non-years and lines, and nothing else on those lines', () => {
    expect(unallowedYears('public/styles.css', 'unicode-range: U+2013-2014, U+2026;')).toEqual([]);
    expect(unallowedYears('public/icons.js', "const NS = 'http://www.w3.org/2000/svg';")).toEqual([]);
    expect(unallowedYears('public/year.js', `export const DEFAULT_ACAD_YEAR = '${DEFAULT_ACAD_YEAR}'; // 2031`)).toHaveLength(1);
    expect(unallowedYears('public/app.js', `export const DEFAULT_ACAD_YEAR = '${DEFAULT_ACAD_YEAR}';`)).toHaveLength(2);
  });

  it('every allow-list entry gives its reason and is still used', () => {
    for (const [file, why] of Object.entries(FILES)) expect(why, file).toMatch(/\S+ \S+ \S+/);
    for (const a of ALLOWED) {
      expect(a.why, `${a.file}: ${a.text}`).toMatch(/\S+ \S+ \S+/);
      expect(readFileSync(join(ROOT, a.file), 'utf8'), `${a.file} no longer holds "${a.text}"; drop the entry`).toContain(a.text);
    }
  });

  it('the live-year entries name DEFAULT_ACAD_YEAR, and the pinned ones the pinned year', () => {
    expect(PAGE_YEAR).toBe(DEFAULT_ACAD_YEAR);
    expect(readFileSync(join(ROOT, 'public/index.html'), 'utf8')).toContain(`Academic year ${yearLabel(DEFAULT_ACAD_YEAR)}<`);
    expect(PINNED_RELEASE.startsWith(`data-${PINNED_ACAD_YEAR}-`)).toBe(true);
    expect(DEFAULT_ACAD_YEAR).toMatch(/^(\d{4})-(\d{4})$/);
    const [a, b] = DEFAULT_ACAD_YEAR.split('-').map(Number);
    expect(b).toBe(a + 1);
  });

  it('src/, public/, scripts/ and the tests over production or pinned data hold no other year', () => {
    const files = scannedFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.flatMap((f) => unallowedYears(f, readFileSync(join(ROOT, f), 'utf8')));
    expect(found).toEqual([]);
  });
});
