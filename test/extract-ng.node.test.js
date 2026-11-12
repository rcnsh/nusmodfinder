// @ts-check
// Phase 7 7E (docs/plans/phase7.md 7E, tests first): scripts/extract-ng.py keeps only the target
// year's sections. NUS prepends new sections, so an April PDF can hold Sem 1 of the next year above
// Sem 2 of this one. Run over fake text with --from-text (no pypdf, no real PDF), the extractor
// drops the other year's section and names it, fails on a published semester with no section,
// a section with no rows, and a section for a semester the manifest marks unpublished.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';
import { nextYear } from '../scripts/ng-sources.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/extract-ng.py', import.meta.url));
const Y = DEFAULT_ACAD_YEAR;
const [A, B] = Y.split('-');
const [, C] = nextYear(Y).split('-');

/** A section heading as the NG list prints it. @param {number} s @param {string} first @param {string} second */
const heading = (s, first, second) => `For Semester ${s} of AY${first}/${second} (${s === 1 ? 'August' : 'January'} ${s === 1 ? first : second} intake)`;

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-extract-ng-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** Runs the extractor over `pages` (form-feed separated). @param {string[]} pages @param {string[]} args */
function run(pages, args) {
  const text = join(dir, 'pages.txt');
  writeFileSync(text, pages.join('\f'));
  const out = join(dir, 'out.json');
  const r = spawnSync('python3', [SCRIPT, '--from-text', text, '--year', Y, '--out', out, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out, json: r.status === 0 ? JSON.parse(readFileSync(out, 'utf8')) : null };
}

const PAGE_HEAD = `Course Offered for Non-Graduating (NG) Students\nUpdated as at 1 Apr ${B}\n`;

describe('extract-ng.py, the target year only', () => {
  it('drops the next year\'s Sem 1 prepended above this year\'s Sem 2, and names it', () => {
    const r = run([
      `${PAGE_HEAD}${heading(1, B, C)}\nFASS | Economics | EC1101E | Intro | 1 | Mon\n`,
      `${heading(1, A, B)}\nFASS | History | HY1101E | Asia | 2 | Tue\n${heading(2, A, B)}\nSoC | CS | CS2030S | Programming | 3 | Wed\n`,
    ], ['--published', '1,2']);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ acadYear: Y, semesters: { 1: ['HY1101E'], 2: ['CS2030S'] }, allCodes: ['CS2030S', 'HY1101E'] });
    expect(r.stdout).toContain(`dropped       For Semester 1 of AY${B}/${C}`);
    expect(r.stdout).toMatch(/semester 1 {4}1 distinct course codes/);
  });

  it('fails when a published semester has no section for the year', () => {
    const r = run([`${PAGE_HEAD}${heading(1, A, B)}\nFASS | History | HY1101E | Asia | 2 | Tue\n${heading(2, B, C)}\nSoC | CS | CS2030S | P | 3 | Wed\n`], ['--published', '1,2']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`Semester 2 is published .* has no section for it in ${Y}`));
  });

  it('fails on a section with no rows', () => {
    const r = run([`${PAGE_HEAD}${heading(1, A, B)}\nno codes here\n`], ['--published', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Semester 1 section of .* has no rows/);
  });

  it('fails on a section for a semester the manifest marks unpublished (G2), and passes without it', () => {
    const pages = [`${PAGE_HEAD}${heading(1, A, B)}\nFASS | History | HY1101E | Asia | 2 | Tue\n${heading(2, A, B)}\nSoC | CS | CS2030S | P | 3 | Wed\n`];
    const r = run(pages, ['--published', '1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/marks Semester 2 unpublished; publish it there first/);
    const ok = run([`${PAGE_HEAD}${heading(1, A, B)}\nFASS | History | HY1101E | Asia | 2 | Tue\n`], ['--published', '1']);
    expect(ok.status).toBe(0);
    expect(ok.json.semesters).toEqual({ 1: ['HY1101E'] });
  });

  it('refuses a year that is not an acad year', () => {
    const r = spawnSync('python3', [SCRIPT, '--from-text', join(dir, 'none'), '--year', `${A}-${C}`], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is not an acad year/);
  });
});
