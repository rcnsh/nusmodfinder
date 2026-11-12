// @ts-check
// Phase 7 7E (docs/plans/phase7.md 7E, tests first): `year check` in its CI mode, and `year next`.
// Each case runs over a temp copy of the files the check reads (test/year-fakes.node.mjs), changed
// one way: a consistent tree, a stale constant, a stub, a date that disagrees, a 40% drop in a
// semester published both years, a missing oracle, and an unpublished semester (which passes).
// `year next` writes stubs and never overwrites. The real tree passes too.
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKLIST, flagCodeRows, preflight, yearCheck, yearNext } from '../scripts/year.mjs';
import { nextYear, previousYear, yearLabel } from '../scripts/ng-sources.mjs';
import { LAST, REPO, Y, copyTree, readJson, writeJson } from './year-fakes.node.mjs';

/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** @type {string} */
let root;
beforeEach(() => { root = copyTree(mkdtempSync(join(tmpdir(), 'vnm-year-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const problems = () => yearCheck({ root }).problems.join('\n');

describe('year check, CI mode', () => {
  it('passes a consistent tree, noting a pending archive and what the lead must confirm', () => {
    // The real manifest's archive is published and nothing is left to confirm, so the copy is
    // put back in the state the lead started from: both are notes, never failures.
    const rel = `data/ng-sources-${Y}.json`;
    const pending = readJson(root, rel);
    const rev = pending.revisions.at(-1);
    rev.archive = { ...rev.archive, sha256: null, pending: 'the lead publishes it' };
    rev.documents.find((/** @type {any} */ d) => d.id === 'self-funded').confirm = ['url'];
    writeFileSync(join(root, rel), `${JSON.stringify(pending, null, 1)}\n`);
    const r = yearCheck({ root });
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.year).toBe(Y);
    expect(r.notes.join('\n')).toMatch(/archive: pending/);
    expect(r.notes.join('\n')).toMatch(/to confirm \(the lead\)/);
    // YST's Sem 2 page is last year's until YST publishes this year's: said, not failed.
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    for (const s of ['1', '2']) if (m.published.yst[s] !== Y) expect(r.notes.join('\n')).toContain(`YST Sem ${s}: ${yearLabel(m.published.yst[s])}'s page`);
  });

  it('passes the repo itself (what the deploy preflight runs)', async () => {
    expect(yearCheck({ root: REPO }).problems).toEqual([]);
    expect(await preflight({ root: REPO })).toMatchObject({ ok: true });
  });

  it('fails on a stale constant: public/year.js, the header, or a data file a year behind', () => {
    const page = join(root, 'public/year.js');
    writeFileSync(page, readFileSync(page, 'utf8').replace(`'${Y}'`, `'${LAST}'`));
    expect(problems()).toMatch(new RegExp(`year sources disagree: public/year.js says ${LAST}`));
    const reasons = readJson(root, 'data/ng-reasons.json');
    writeJson(root, 'data/ng-reasons.json', { ...reasons, acadYear: LAST });
    expect(problems()).toMatch(/data\/ng-reasons\.json says/);
  });

  it('fails on a stub: an NG file, the manifest, or the overlay, oracle or register module', () => {
    writeJson(root, `data/ng-courses-${Y}.json`, { stub: true, acadYear: Y, semesters: {} });
    expect(problems()).toMatch(new RegExp(`data/ng-courses-${Y}\\.json is a stub`));
    copyTree(root);
    const overlay = join(root, `scripts/ng-overlay/${Y}.mjs`);
    writeFileSync(overlay, `export const stub = true;\n${readFileSync(overlay, 'utf8')}`);
    expect(problems()).toMatch(new RegExp(`scripts/ng-overlay/${Y}\\.mjs is a stub`));
  });

  it('fails on a date that disagrees with the source manifest', () => {
    const courses = readJson(root, `data/ng-courses-${Y}.json`);
    const listed = courses.updatedAsAt;
    writeJson(root, `data/ng-courses-${Y}.json`, { ...courses, updatedAsAt: `${listed} (edited)` }, 2);
    expect(problems()).toMatch(new RegExp(`updated as at ${esc(listed)} \\(edited\\); the source manifest says ${esc(listed)}`));
    copyTree(root);
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    const doc = m.revisions.at(-1).documents.find((/** @type {any} */ d) => d.id === 'restrictions');
    const dated = doc.updatedAsAt;
    doc.updatedAsAt = `${dated} (edited)`;
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    expect(problems()).toMatch(new RegExp(`Course restrictions for exchange \\(NG\\) students" updated as at ${esc(dated)}; the source manifest says ${esc(dated)} \\(edited\\)`));
  });

  it('fails when the rules file was built from documents other than the revision lists', () => {
    const rules = readJson(root, `data/ng-restrictions-${Y}.json`);
    rules.sourceSha256['ng-courses.pdf'] = 'f'.repeat(64);
    writeJson(root, `data/ng-restrictions-${Y}.json`, rules);
    expect(problems()).toMatch(/was built from ng-courses\.pdf f{64}/);
  });

  it('fails on a 40% drop in a semester published both years, and passes a 10% one', () => {
    const courses = readJson(root, `data/ng-courses-${Y}.json`);
    writeJson(root, `data/ng-courses-${LAST}.json`, { ...courses, acadYear: LAST }, 2);
    const cut = (/** @type {number} */ f) => {
      const sem1 = courses.semesters['1'];
      writeJson(root, `data/ng-courses-${Y}.json`, { ...courses, semesters: { ...courses.semesters, 1: sem1.slice(0, Math.round(sem1.length * (1 - f))) } }, 2);
    };
    cut(0.4);
    expect(problems()).toMatch(new RegExp(`Sem 1: \\d+ courses, 40% away from ${LAST}'s \\d+`));
    cut(0.1);
    expect(yearCheck({ root }).problems).toEqual([]);
  });

  it('fails when the year has no oracle', () => {
    unlinkSync(join(root, `test/sc1/oracle-${Y}.node.mjs`));
    expect(problems()).toMatch(new RegExp(`names oracle test/sc1/oracle-${Y}\\.node\\.mjs, which doesn't exist`));
  });

  it('passes an unpublished semester (G2) whose last-year list exists, and says so', () => {
    const courses = readJson(root, `data/ng-courses-${Y}.json`);
    writeJson(root, `data/ng-courses-${LAST}.json`, { ...courses, acadYear: LAST }, 2);
    const sem1 = { ...courses.semesters };
    delete sem1['2'];
    writeJson(root, `data/ng-courses-${Y}.json`, { ...courses, semesters: sem1 }, 2);
    const m = readJson(root, `data/ng-sources-${Y}.json`);
    m.published.ngList['2'] = false;
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    const r = yearCheck({ root });
    expect(r.problems).toEqual([]);
    expect(r.notes.join('\n')).toContain(`Sem 2 unpublished: exchange mode shows ${yearLabel(LAST)}'s Sem 2 list`);
    // Without last year's list there is nothing to show.
    unlinkSync(join(root, `data/ng-courses-${LAST}.json`));
    expect(problems()).toContain(`Sem 2 is unpublished, so exchange mode shows ${LAST}'s Sem 2 list`);
    // A published semester needs its section, an unpublished one has none.
    m.published.ngList['2'] = true;
    writeJson(root, `data/ng-sources-${Y}.json`, m);
    expect(problems()).toMatch(/Sem 2 is published .* has no Sem 2 list/);
  });

  it('fails when an indexed NUS quote is no longer in its file', () => {
    const page = join(root, 'public/shortlist.js');
    writeFileSync(page, readFileSync(page, 'utf8').replace('no particular course can be guaranteed by NUS', 'no course is guaranteed'));
    expect(problems()).toMatch(/quote gro-no-guarantee is no longer in public\/shortlist\.js/);
  });
});

describe('year next', () => {
  const NEXT = nextYear(Y);
  const scaffold = [`data/ng-sources-${NEXT}.json`, `data/ng-courses-${NEXT}.json`, `data/ng-restrictions-${NEXT}.json`,
    `scripts/ng-overlay/${NEXT}.mjs`, `test/sc1/oracle-${NEXT}.node.mjs`, `docs/year-refresh/registers/${NEXT}.md`];

  it('writes the year\'s files as stubs, each starting from last year\'s, and the checklist names every step', () => {
    const r = yearNext(NEXT, { root });
    expect(r.written).toEqual(scaffold);
    expect(r.kept).toEqual([]);
    expect(readJson(root, `data/ng-sources-${NEXT}.json`)).toMatchObject({ acadYear: NEXT, stub: true, overlay: `scripts/ng-overlay/${NEXT}.mjs`, oracle: `test/sc1/oracle-${NEXT}.node.mjs` });
    expect(readJson(root, `data/ng-courses-${NEXT}.json`)).toEqual({ stub: true, acadYear: NEXT, semesters: {} });
    expect(readFileSync(join(root, `scripts/ng-overlay/${NEXT}.mjs`), 'utf8')).toMatch(/^export const stub = true;$/m);
    const oracle = readFileSync(join(root, `test/sc1/oracle-${NEXT}.node.mjs`), 'utf8');
    expect(oracle).toMatch(/^export const stub = true;$/m);
    expect(oracle).toContain(readFileSync(join(root, `test/sc1/oracle-${Y}.node.mjs`), 'utf8'));
    expect(readFileSync(join(root, `docs/year-refresh/registers/${NEXT}.md`), 'utf8')).toMatch(/\| C1 \(re-verify\) \|/);
    expect(CHECKLIST(NEXT)).toMatch(/--write-budget 80000/);
    // The next year's stubs fail its own year check.
    expect(yearCheck({ root, year: NEXT }).problems.join('\n')).toMatch(/is a stub/);
  });

  it('never overwrites a file', () => {
    yearNext(NEXT, { root });
    const before = scaffold.map((f) => readFileSync(join(root, f), 'utf8'));
    writeFileSync(join(root, scaffold[1]), '{"mine": true}\n');
    const again = yearNext(NEXT, { root });
    expect(again.written).toEqual([]);
    expect(again.kept).toEqual(scaffold);
    expect(readFileSync(join(root, scaffold[1]), 'utf8')).toBe('{"mine": true}\n');
    expect(readFileSync(join(root, scaffold[0]), 'utf8')).toBe(before[0]);
  });

  it('refuses a year whose last year has no manifest', () => {
    const far = nextYear(nextYear(nextYear(NEXT)));
    expect(() => yearNext(far, { root })).toThrow(`no data/ng-sources-${previousYear(far)}.json`);
    expect(existsSync(join(root, `data/ng-courses-${far}.json`))).toBe(false);
  });

  it('flags only the register rows that name a course code', () => {
    expect(flagCodeRows('| R1 | courses off the list | closed |\n| C3 | AR5801, CM5223 | closed |')).toBe('| R1 | courses off the list | closed |\n| C3 (re-verify) | AR5801, CM5223 | closed |');
  });
});
