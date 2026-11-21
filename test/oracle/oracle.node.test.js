// @ts-check
import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import { unknownRuleNames } from '../../scripts/ng-rule-names.mjs';
import { bitOf, eligibility, NG_SEMS, STUDIES } from '../../src/eligibility.js';
import * as live from './oracle.mjs';

const corpus = inject('corpus');
const { oracle } = corpus ? await live.oracleFor(corpus.acadYear) : live;
/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));

describe.skipIf(!corpus)('eligibility agrees with the oracle over production', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  /** @type {import('../../src/eligibility.js').Rules & { rules: { id: string, match: { departments?: string[], faculties?: string[] } }[] }} */
  const rules = readJson(`data/ng-restrictions-${c.acadYear}.json`);

  it('on every production module x {Sem 1, Sem 2, either} x {ug1..ug4, grad}', () => {
    expect(c.modules.length).toBeGreaterThan(0);
    /** @type {string[]} */
    const differ = [];
    let ngShown = 0;
    for (const m of c.modules) {
      for (const sem of NG_SEMS) {
        for (const study of STUDIES) {
          const got = eligibility(m, { sem, study }, rules);
          const want = oracle(m, { sem, study });
          if (got.status !== want) differ.push(`${m.code} sem ${sem} ${study}: eligibility ${got.status} (${got.reasons.join(', ')}), oracle ${want}`);
          if (!m.ng) expect(got.status, `${m.code} is not on the NG list`).toBe('closed');
          else if (got.status !== 'closed') ngShown++;
        }
      }
    }
    expect(differ).toEqual([]);
    expect(ngShown).toBeGreaterThan(0);
  }, 60_000);

  it('on every NG-listed code with no classes in data/ng-unscheduled.json x {Sem 1, Sem 2} x {ug1..ug4, grad}', () => {
    /** @type {import('../../src/ng-unscheduled-file.js').NgUnscheduledFile} */
    const file = readJson('data/ng-unscheduled.json');
    expect(file.acadYear).toBe(c.acadYear);
    /** @type {string[]} */
    const differ = [];
    let shown = 0;
    for (const e of file.modules) {
      const m = { code: e.code, title: e.title, department: e.department, faculty: e.faculty, level: e.level, semesters: [], ng: true, ngSemesters: e.ngSemesters,
        ...(e.ngUnpublished ? { ngUnpublished: e.ngUnpublished } : {}) };
      for (const sem of /** @type {const} */ ([1, 2])) {
        for (const study of STUDIES) {
          const bit = bitOf(sem, study);
          const ids = e.ngRules?.[String(Math.log2(bit))] ?? [];
          const got = (e.ngAllow & bit) === 0 ? 'closed' : ids.length ? 'note' : 'open';
          const want = oracle(m, { sem, study });
          if (got !== want) differ.push(`${e.code} sem ${sem} ${study}: file ${got} (${ids.join(', ')}), oracle ${want}`);
          if (got !== 'closed') shown++;
        }
      }
    }
    expect(differ).toEqual([]);
    expect(shown).toBeGreaterThan(0);
  });

  it('names only departments and faculties the production corpus has', () => {
    expect(unknownRuleNames(rules, c)).toEqual([]);
  });
});
