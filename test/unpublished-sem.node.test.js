// @ts-check
// Phase 7 7E, G2 (docs/plans/phase7.md 7E, tests first; Jacob's answer, ADR 0011): in July NUS
// has published the coming year's Sem 1 NG list but not Sem 2's. Until it does, a Sem 2 course on
// last year's Sem 2 list is "to confirm" (reason ng:unpublished-sem, kind ask), never open; one
// that wasn't on it is hidden with its own reason. These cases cover each piece: the loader carries
// last year's list from the manifest, eligibility's state, the reason texts, the shortlist and the
// hidden-code stamp, and the SC1 oracle's G2 wrapper agreeing with eligibility. With every
// semester published nothing changes (SC1 over production and the unchanged ranking lock prove
// that at full scale; the no-op case here proves it on the fixture).
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadNgCourses } from '../scripts/lib.mjs';
import { yearLabel } from '../scripts/ng-sources.mjs';
import {
  eligibility, eligibilityMask, NOT_NG_IN_SEM, NG_SEMS, STUDIES, UNPUBLISHED_SEM, UNPUBLISHED_UNLISTED,
} from '../src/eligibility.js';
import { hiddenCodeStamp, noteLead, sourceNote, stampText, statusText } from '../public/explain.js';
import { parseList } from '../public/list.js';
import { answerOf, workOut } from '../public/shortlist.js';
import { oracleFor } from './sc1/oracle.mjs';
import { FIXTURE, REASONS_FILE, exchange, ngListedOutcome, synthOutcome } from './web/shortlist-answers.node.mjs';
import { LAST, REPO, Y, readJson, writeJson } from './year-fakes.node.mjs';

/** @type {import('../src/eligibility.js').Rules} */
const rules = readJson(REPO, `data/ng-restrictions-${Y}.json`);

/**
 * @param {string} code @param {Partial<import('../src/eligibility.js').EligibilityModule>} [over]
 * @returns {import('../src/eligibility.js').EligibilityModule}
 */
const mod = (code, over = {}) => ({
  code, title: `${code} title`, department: null, faculty: null, level: Number(/\d/.exec(code)?.[0] ?? NaN),
  semesters: [1, 2], ng: true, ngSemesters: [1, 2], ...over,
});

describe('G2 in src/eligibility.js', () => {
  it('a course on last year\'s list for an unpublished semester is to confirm there, at every study level, never open', () => {
    const m = mod('XX2101', { ngSemesters: [1, 2], ngUnpublished: [2] });
    for (const study of STUDIES) {
      const e = eligibility(m, { sem: 2, study }, rules);
      expect(e.status, study).toBe('note');
      expect(e.reasons, study).toContain(UNPUBLISHED_SEM);
      expect(eligibility(m, { sem: 1, study }, rules)).toEqual(eligibility(mod('XX2101'), { sem: 1, study }, rules));
    }
  });

  it('one that wasn\'t on last year\'s list is closed there with its own reason, not "only in the other semester"', () => {
    const m = mod('XX2102', { ngSemesters: [1], ngUnpublished: [2] });
    expect(eligibility(m, { sem: 2, study: 'ug2' }, rules)).toEqual({ status: 'closed', reasons: [UNPUBLISHED_UNLISTED] });
    expect(eligibility(mod('XX2102', { ngSemesters: [1] }), { sem: 2, study: 'ug2' }, rules)).toEqual({ status: 'closed', reasons: [NOT_NG_IN_SEM] });
  });

  it('either semester: confirmed when a listed semester is published and timetabled, to confirm when only the unpublished one is', () => {
    expect(eligibility(mod('XX2103', { ngSemesters: [1, 2], ngUnpublished: [2] }), { sem: 'any', study: 'ug2' }, rules).status).toBe('open');
    const only2 = eligibility(mod('XX2104', { ngSemesters: [2], ngUnpublished: [2] }), { sem: 'any', study: 'ug2' }, rules);
    expect(only2).toEqual({ status: 'note', reasons: [UNPUBLISHED_SEM] });
    // Listed for Sem 1 but NUSMods only timetables Sem 2, which is unpublished: both notes.
    const both = eligibility(mod('XX2105', { semesters: [2], ngSemesters: [1, 2], ngUnpublished: [2] }), { sem: 'any', study: 'ug2' }, rules);
    expect(both.status).toBe('note');
    expect(both.reasons).toContain(UNPUBLISHED_SEM);
  });

  it('a rule that closes a course still closes it in the unpublished semester (rule D: level 5000 for a 2nd-year)', () => {
    const e = eligibility(mod('XX5101', { ngSemesters: [2], ngUnpublished: [2] }), { sem: 2, study: 'ug2' }, rules);
    expect(e.status).toBe('closed');
  });

  it('an empty ngUnpublished is no change: every fixture module\'s mask is the same', () => {
    let n = 0;
    for (const m of FIXTURE.values()) {
      expect(eligibilityMask({ ...m, ngUnpublished: [] }, rules), m.code).toEqual(eligibilityMask(m, rules));
      n++;
    }
    expect(n).toBeGreaterThan(50);
  });
});

describe('G2 in scripts/lib.mjs: last year\'s list for an unpublished semester', () => {
  /** @type {string} */
  let dir;
  /** @type {URL} */
  let dataDir;
  const courses = readJson(REPO, `data/ng-courses-${Y}.json`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vnm-g2-'));
    dataDir = pathToFileURL(`${dir}/`);
    const sem1 = { ...courses.semesters };
    delete sem1['2'];
    writeJson(dir, `ng-courses-${Y}.json`, { ...courses, semesters: sem1 });
    writeJson(dir, `ng-courses-${LAST}.json`, { ...courses, acadYear: LAST, semesters: { 1: ['OLD1001'], 2: ['OLD2001', courses.semesters['1'][0]] } });
    writeJson(dir, `ng-restrictions-${Y}.json`, rules);
    const m = readJson(REPO, `data/ng-sources-${Y}.json`);
    writeJson(dir, `ng-sources-${Y}.json`, { ...m, published: { ...m.published, ngList: { 1: true, 2: false } } });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('takes Sem 2 from last year\'s file, and names Sem 2 unpublished', async () => {
    const ng = await loadNgCourses(Y, { dataDir });
    expect(ng.available).toBe(true);
    expect(ng.unpublished).toEqual([2]);
    expect(ng.bySem.get('OLD2001')).toEqual([2]);
    expect(ng.bySem.get('OLD1001')).toBeUndefined();
    expect(ng.bySem.get(courses.semesters['1'][0])).toEqual([1, 2]);
  });

  it('refuses when last year\'s file is missing, or this year\'s has the unpublished semester\'s list', async () => {
    rmSync(join(dir, `ng-courses-${LAST}.json`));
    await expect(loadNgCourses(Y, { dataDir })).rejects.toThrow(new RegExp(`shows ${LAST}'s list for it, but data/ng-courses-${LAST}\\.json can't be read`));
    writeJson(dir, `ng-courses-${LAST}.json`, { ...courses, acadYear: LAST });
    writeJson(dir, `ng-courses-${Y}.json`, courses);
    await expect(loadNgCourses(Y, { dataDir })).rejects.toThrow(/has a Sem 2 list, but .* marks Sem 2 unpublished/);
  });

  it('a stub NG file is not available, and says it is a stub; every semester published is no change', async () => {
    writeFileSync(join(dir, `ng-courses-${Y}.json`), `${JSON.stringify({ stub: true, acadYear: Y, semesters: {} })}\n`);
    expect(await loadNgCourses(Y, { dataDir })).toMatchObject({ available: false, stub: true });
    writeJson(dir, `ng-courses-${Y}.json`, courses);
    const m = readJson(REPO, `data/ng-sources-${Y}.json`);
    writeJson(dir, `ng-sources-${Y}.json`, m);
    const ng = await loadNgCourses(Y, { dataDir });
    expect(ng.unpublished).toEqual([]);
    expect(ng.bySem.get('OLD2001')).toBeUndefined();
  });
});

describe('G2\'s words', () => {
  it('the reasons are worded from the year: last year\'s list, this year\'s not out', () => {
    expect(REASONS_FILE.reasons[UNPUBLISHED_SEM]).toEqual({
      kind: 'ask', text: `On NUS's ${yearLabel(LAST)} list; NUS hasn't published ${yearLabel(Y)}'s yet.`, cite: `NG course list, ${yearLabel(LAST)}`,
    });
    expect(REASONS_FILE.reasons[UNPUBLISHED_UNLISTED]).toMatchObject({ kind: 'closed', text: expect.stringContaining(`Not on NUS's ${yearLabel(LAST)} list for this semester`) });
    expect(noteLead('ask')).toBe('To confirm.');
    expect(sourceNote(UNPUBLISHED_SEM, [])).toBe('NG list');
  });

  it('a card stamps a carried course "To confirm", never "Open"; other notes keep "Open, with notes"', () => {
    const ask = [{ id: UNPUBLISHED_SEM, kind: 'ask', text: 'x' }];
    expect(stampText('note', 2, ask)).toBe('Sem 2 · To confirm with NUS, with 1 note');
    expect(stampText('note', 2, ask, true)).toBe('Sem 2 · To confirm, 1 note');
    expect(statusText('note', ask)).toBe('To confirm with NUS, with notes');
    expect(stampText('note', 2, [{ kind: 'quota' }])).toBe('Sem 2 · Open, with 1 note');
    expect(stampText('note', 2, 1)).toBe('Sem 2 · Open, with 1 note');
  });

  it('a hidden code unlisted in an unpublished semester says so', () => {
    const ex = /** @type {any} */ (exchange({ 1: ['open', []], 2: ['closed', [UNPUBLISHED_UNLISTED]] }));
    expect(hiddenCodeStamp({ sem: '2', study: 'ug2', exchange: ex }).text).toBe("Not on last year's NG list for Sem 2");
  });

  it('the shortlist counts a carried Sem 2 course as to confirm, and an unlisted one as out', () => {
    const params = new URLSearchParams('ng=1&study=ug2&pick=XX2101.2&pick=XX2102.2&pick=XX2103.1');
    const { list } = parseList(params);
    const outcomes = {
      XX2101: synthOutcome('XX2101', { ng_semesters: [1, 2], exchange: exchange({ 1: ['open', []], 2: ['note', [UNPUBLISHED_SEM]] }) }),
      XX2102: synthOutcome('XX2102', { ng_semesters: [1], exchange: exchange({ 1: ['open', []], 2: ['closed', [UNPUBLISHED_UNLISTED]] }) }),
      XX2103: synthOutcome('XX2103'),
    };
    const answers = new Map(Object.entries(outcomes).map(([c, o]) => [c, answerOf(o)]));
    const r = workOut({ list, sem: '2', study: 'ug2', answers, rules: REASONS_FILE.offListRules });
    const at = (/** @type {string} */ c) => r.entries.find((w) => w.code === c);
    expect(at('XX2101')).toMatchObject({ standing: 'confirm', why: `To confirm with NUS: On NUS's ${yearLabel(LAST)} list; NUS hasn't published ${yearLabel(Y)}'s yet` });
    expect(at('XX2102')).toMatchObject({ standing: 'out', why: `Not on NUS's ${yearLabel(LAST)} list for this semester, and NUS hasn't published ${yearLabel(Y)}'s yet` });
    expect(at('XX2103')).toMatchObject({ standing: 'counted' });
    expect(r.sems[2]).toMatchObject({ counted: 0, confirm: 4 });
  });

  it('an NG-listed course with no classes, carried into an unpublished Sem 2, says the listing is last year\'s', () => {
    const { list } = parseList(new URLSearchParams('ng=1&study=ug2&pick=XX4101.2'));
    const answers = new Map([['XX4101', answerOf(ngListedOutcome('XX4101', {
      ngSemesters: [1, 2], ngUnpublished: [2], exchange: exchange({ 1: ['open', []], 2: ['note', [UNPUBLISHED_SEM]] }),
    }))]]);
    const w = workOut({ list, sem: '2', study: 'ug2', answers, rules: REASONS_FILE.offListRules }).entries[0];
    expect(w).toMatchObject({ standing: 'confirm', why: `On NUS's ${yearLabel(LAST)} list; NUS hasn't published ${yearLabel(Y)}'s yet, and NUSMods shows no classes: ask NUS` });
    expect(w.why).not.toMatch(/NUS lists it for Sem 2/);
  });
});

describe('G2 in the SC1 oracle (the selector\'s wrapper) agrees with eligibility', () => {
  it('on every fixture module with Sem 2 unpublished, at every semester and study level', async () => {
    const { oracle } = await oracleFor(Y);
    /** @type {string[]} */
    const differ = [];
    let carried = 0;
    for (const base of FIXTURE.values()) {
      // Last year's Sem 2 list, as the loader gives it: here, this year's.
      const m = { ...base, ngUnpublished: [2] };
      for (const sem of NG_SEMS) {
        for (const study of STUDIES) {
          const got = eligibility(m, { sem, study }, rules);
          const want = oracle(m, { sem, study });
          if (got.status !== want) differ.push(`${m.code} sem ${sem} ${study}: eligibility ${got.status} (${got.reasons.join(', ')}), oracle ${want}`);
          if (sem === 2 && got.status === 'open') differ.push(`${m.code} is open in an unpublished Sem 2`);
          if (sem === 2 && got.reasons.includes(UNPUBLISHED_SEM)) carried++;
        }
      }
    }
    expect(differ).toEqual([]);
    expect(carried).toBeGreaterThan(0);
  });

  it('an empty ngUnpublished leaves the year\'s oracle untouched', async () => {
    const { explain } = await oracleFor(Y);
    for (const m of FIXTURE.values()) {
      for (const sem of NG_SEMS) expect(explain({ ...m, ngUnpublished: [] }, { sem, study: 'ug3' }), m.code).toEqual(explain(m, { sem, study: 'ug3' }));
    }
  });
});
