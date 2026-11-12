// @ts-check
// Phase 7 7E (docs/plans/phase7.md 7E, tests first): the SC1 oracle selector. test/sc1/oracle.mjs
// picks the oracle written for a corpus's year, test/sc1/oracle-<year>.node.mjs, and refuses a
// missing or stub one. No other file imports a dated oracle directly, so a new year cannot be
// tested against last year's readings by an import nobody updated.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';
import { nextYear, previousYear } from '../scripts/ng-sources.mjs';
import * as live from './sc1/oracle.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SELECTOR = 'test/sc1/oracle.mjs';

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-oracle-sel-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * A copy of the selector beside the given dated oracles (year → source), with the page's year file
 * it reads the live year from.
 * @param {Record<string, string>} oracles
 */
async function selectorWith(oracles) {
  mkdirSync(join(dir, 'test/sc1'), { recursive: true });
  mkdirSync(join(dir, 'public'), { recursive: true });
  cpSync(join(ROOT, SELECTOR), join(dir, SELECTOR));
  cpSync(join(ROOT, 'public/year.js'), join(dir, 'public/year.js'));
  for (const [y, src] of Object.entries(oracles)) writeFileSync(join(dir, `test/sc1/oracle-${y}.node.mjs`), src);
  return import(pathToFileURL(join(dir, SELECTOR)).href);
}

/** A minimal dated oracle that says which year wrote it. @param {string} y @param {string} [head] */
const fakeOracle = (y, head = '') => `${head}
export const explain = () => ({ result: 'open', closed: [], notes: ['${y}'] });
export const explainShown = explain;
export const prereqYears = () => null; export const yearNoteOf = () => null; export const levelNoteOf = () => null;
`;

describe('the SC1 oracle selector', () => {
  it('picks the oracle written for the year it is given', async () => {
    const y = DEFAULT_ACAD_YEAR;
    const n = nextYear(y);
    const sel = await selectorWith({ [y]: fakeOracle(y), [n]: fakeOracle(n) });
    expect(sel.oracleYear).toBe(y);
    expect((await sel.oracleFor(n)).explain({}, { sem: 1 }).notes).toEqual([n]);
    expect((await sel.oracleFor(y)).explain({}, { sem: 1 }).notes).toEqual([y]);
    expect(sel.explain({}, { sem: 1 }).notes).toEqual([y]);
  });

  it('refuses a year with no oracle, a stub oracle (what `year next` writes), and a malformed year', async () => {
    const y = DEFAULT_ACAD_YEAR;
    const n = nextYear(y);
    const sel = await selectorWith({ [y]: fakeOracle(y), [n]: fakeOracle(n, 'export const stub = true;') });
    await expect(sel.oracleFor(previousYear(y))).rejects.toThrow(/no SC1 oracle for .*is missing/);
    await expect(sel.oracleFor(n)).rejects.toThrow(/is a stub/);
    await expect(sel.oracleFor('2026')).rejects.toThrow(/not an acad year/);
  });

  it('serves the live year\'s committed oracle', async () => {
    expect(live.oracleYear).toBe(DEFAULT_ACAD_YEAR);
    // oracleFor refuses a stub, so this resolving is the check that the year's oracle is written.
    expect((await live.oracleFor(DEFAULT_ACAD_YEAR)).year).toBe(DEFAULT_ACAD_YEAR);
    expect(typeof live.oracle).toBe('function');
  });

  it('no tracked file imports a dated oracle, or the old oracle.node.mjs, except through the selector', () => {
    const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
    expect(r.status).toBe(0);
    const files = r.stdout.split('\n').filter((f) => /\.(?:[cm]?[jt]s)$/.test(f) && f !== SELECTOR && f !== 'test/oracle-selector.node.test.js' && !/(?:^|\/)node_modules\//.test(f));
    // A literal path, or a template one (`oracle-${year}`), outside the selector.
    const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"`]([^'"`]*\/oracle(?:-\d{4}-\d{4}|-\$\{[^}]*\})?\.node\.mjs)['"`]/g;
    /** @type {string[]} */
    const found = [];
    for (const f of files) {
      let text;
      try { text = readFileSync(join(ROOT, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(IMPORT)) found.push(`${f}: ${m[1]}`);
    }
    expect(found).toEqual([]);
    const dated = `oracle-${DEFAULT_ACAD_YEAR}.node.mjs`;
    for (const line of [`import { oracle } from './sc1/${dated}';`, `const o = await import('../test/sc1/${dated}');`, 'await import(`./sc1/oracle-${y}.node.mjs`)', "import x from './oracle.node.mjs';"]) {
      expect([...line.matchAll(IMPORT)], line).toHaveLength(1);
    }
  });
});
