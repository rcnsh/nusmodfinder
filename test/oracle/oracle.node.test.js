// @ts-check
// Over the production corpus (CI on the live year): src/eligibility.js with the committed rules agrees with the
// independent oracle (test/oracle/oracle.mjs, written from the sources and
// the interpretations register only) on every production module, in every
// semester and at every study level, and on every NG-listed code with no
// classes in data/ng-unscheduled.json. And every department and faculty a rule
// names exists in the production corpus: the rules and the oracle match on
// those strings, so a NUSMods rename would leave a closed rule matching
// nothing and CI green while those courses showed as open.
//
// The oracle-node project (vitest.config.mjs) provides `corpus`: `current` from
// data/corpus.json, normalised with HEAD's NG files for its year. The oracle CI
// job restores it and sets FULL_CORPUS=1, so a missing corpus fails there; a
// local run without `npm run corpus -- restore` skips.
import { readFileSync } from 'node:fs';
import { describe, expect, inject, it } from 'vitest';
import { unknownRuleNames } from '../../scripts/ng-rule-names.mjs';
import { bitOf, eligibility, NG_SEMS, STUDIES } from '../../src/eligibility.js';
import * as live from './oracle.mjs';

const corpus = inject('corpus');
// The oracle for the corpus's year (test/oracle/oracle.mjs picks it); the live year's without one.
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
  }, 60_000); // ~100k cases: 3-4 s locally, 8.4 s once on a CI runner (past the 5 s default)

  // The NG-listed codes with no classes, as the Worker ships them (data/ng-unscheduled.json, built
  // from `current`): each stored mask and its rule ids give, at every semester and study level, the
  // oracle's answer for a course with no classes.
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
