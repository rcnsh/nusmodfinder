// @ts-check
// SC1 (docs/plans/phase4.md 4E): src/eligibility.js with the committed rules
// agrees with the independent oracle (test/sc1/oracle.node.mjs, written from
// the sources and the interpretations register only) on every pinned-corpus
// module, in every semester and at every study level. Also checks the rules
// file names only departments and faculties the corpus has. Skipped when .data/
// has no corpus; with FULL_CORPUS=1 (the full-corpus CI job) a missing corpus
// fails instead.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPinnedCorpus, MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';
import { eligibility, NG_SEMS, STUDIES } from '../../src/eligibility.js';
import { oracle } from '../sc1/oracle.node.mjs';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);
/** @type {import('../../src/eligibility.js').Rules & { rules: { match: { departments?: string[], faculties?: string[] } }[] }} */
const rules = JSON.parse(readFileSync(new URL('../../data/ng-restrictions-2026-2027.json', import.meta.url), 'utf8'));

describe.skipIf(!available)('SC1: eligibility agrees with the oracle', () => {
  it('on every pinned module x {Sem 1, Sem 2, either} x {ug1..ug4, grad}', async () => {
    const { modules } = await loadPinnedCorpus();
    expect(modules.length).toBeGreaterThan(6000);
    /** @type {string[]} */
    const differ = [];
    let ngShown = 0;
    for (const m of modules) {
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
  });

  it('names only departments and faculties the snapshot has', () => {
    /** @type {{ department?: string, faculty?: string }[]} */
    const records = JSON.parse(readFileSync(MODULE_INFO_PATH, 'utf8'));
    const departments = new Set(records.map((r) => r.department));
    const faculties = new Set(records.map((r) => r.faculty));
    const unknown = rules.rules.flatMap((r) => [
      ...(r.match.departments ?? []).filter((d) => !departments.has(d)).map((d) => `${r.id}: department ${d}`),
      ...(r.match.faculties ?? []).filter((f) => !faculties.has(f)).map((f) => `${r.id}: faculty ${f}`),
    ]);
    expect(unknown).toEqual([]);
  });
});
