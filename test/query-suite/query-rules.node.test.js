// @ts-check
// The lists the query parser reads (eval/query-rules/*.json, mirrored into data/
// by scripts/build-catalogue-data.mjs) parse and follow their own rules, and the
// suite's typo threshold T is what its recorded measurement gives.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../eval/lib/sets.mjs';
import { isCohortOnly } from '../../eval/query-rules/cohort-only.mjs';
import { readJson } from './suite-files.node.mjs';

const RULES = join(REPO, 'eval/query-rules');

/** Shared codes between two top-10 lists. @param {string[]} a @param {string[]} b */
const overlapAt10 = (a, b) => {
  const top = new Set(b.slice(0, 10));
  return a.slice(0, 10).filter((c) => top.has(c)).length;
};

describe('the query-rule lists', () => {
  it('every list parses and names its schema', () => {
    const files = readdirSync(RULES).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(readJson(join(RULES, f)).schema, f).toMatch(/^vnm-p6-/);
  });

  it('stopwords: current is src/fts-query.js\'s list, and v2 is current plus the catalogue words', () => {
    const s = readJson(join(RULES, 'stopwords.json'));
    const src = readFileSync(join(REPO, 'src/fts-query.js'), 'utf8');
    const m = src.match(/const STOPWORDS = new Set\(\[([^\]]+)\]\)/);
    const shipped = [...(/** @type {RegExpMatchArray} */ (m)[1].matchAll(/'([^']+)'/g))].map((x) => x[1]);
    expect(s.current).toEqual(shipped);
    expect(s.v2Additions).toEqual(['class', 'course', 'courses', 'module', 'modules', 'nus', 'something', 'teach']);
    expect(s.v2).toEqual([...new Set([...s.current, ...s.v2Additions])].sort());
    for (const w of s.notStopwords) expect(s.v2).not.toContain(w);
  });

  it('collision list: the seed plus the added words, sorted, none of them a pillar prefix', () => {
    const c = readJson(join(RULES, 'collision-list.json'));
    expect(c.seed).toEqual(['AI', 'AN', 'CE', 'DSA', 'EE', 'GE', 'IS', 'IT', 'JS', 'LAB', 'LL', 'MA', 'ME', 'PE', 'PR', 'SE']);
    expect(c.list).toEqual([...new Set([...c.seed, ...Object.keys(c.added)])].sort());
    const pillars = readJson(join(RULES, 'ge-pillars.json')).prefixes;
    expect(c.exempt).toEqual(pillars);
    expect(c.list.filter((/** @type {string} */ p) => pillars.includes(p))).toEqual([]);
  });

  it('collision review: its additions are on the list with the same reason, and nothing it keeps off is', () => {
    const c = readJson(join(RULES, 'collision-list.json'));
    const r = readJson(join(RULES, 'collision-review.json'));
    for (const [p, why] of Object.entries(r.added)) expect(c.added[p], p).toBe(why);
    const off = [...Object.keys(r.keptOff), ...Object.keys(r.dictionaryHitKeptOff)];
    expect(new Set([...Object.keys(r.added), ...off]).size, 'groups are disjoint').toBe(Object.keys(r.added).length + off.length);
    for (const p of off) expect(c.list, p).not.toContain(p);
    expect(r.counts).toEqual({ reviewed: Object.keys(r.added).length + off.length, added: Object.keys(r.added).length, keptOff: Object.keys(r.keptOff).length, dictionaryHitKeptOff: Object.keys(r.dictionaryHitKeptOff).length });
    for (const p of r.source.dictionaryHitsAdded) expect(r.added, p).toHaveProperty(p);
  });

  it('GE table: every pillar maps into the ten pillar prefixes, and every prefix has a pillar', () => {
    const g = readJson(join(RULES, 'ge-pillars.json'));
    expect(g.prefixes).toEqual(['GEA', 'GEC', 'GEH', 'GEI', 'GEN', 'GEQ', 'GES', 'GESS', 'GET', 'GEX']);
    const mapped = g.pillars.flatMap((/** @type {any} */ p) => p.prefixes);
    expect([...mapped].sort()).toEqual(g.prefixes);
    expect(g.genericPhrases).toEqual(['ge', 'gen ed', 'general education']);
  });

  it('intent phrases: lower-case, no phrase in two lists but `no background` (beginner and prereq)', () => {
    const p = readJson(join(RULES, 'intent-phrases.json'));
    /** @type {Record<string, string[]>} */
    const lists = {
      exam: p.constraints.exam.phrases,
      su: p.constraints.su.phrases,
      hoursBelow: p.constraints.hoursBelow.phrases,
      prereq: p.constraints.prereq.phrases,
      beginner: p.level.beginner.phrases,
      graduate: p.level.graduate.phrases,
      levelN: p.level.levelN.phrases,
      year: p.level.year.phrases,
    };
    /** @type {Map<string, string[]>} */
    const where = new Map();
    for (const [name, phrases] of Object.entries(lists)) {
      for (const ph of phrases) {
        // Lower-case, except the placeholder N.
        expect(ph.replace(/N/g, ''), name).toBe(ph.replace(/N/g, '').toLowerCase());
        where.set(ph, [...(where.get(ph) ?? []), name]);
      }
    }
    const shared = [...where].filter(([, ls]) => ls.length > 1);
    expect(shared).toEqual([['no background', ['prereq', 'beginner']]]);
    expect(p.constraints.hoursBelow.light).toBe(10);
    expect(p.negators).toEqual(['not', 'non', 'except', 'beyond']);
    expect(p.negationWindow).toBe(2);
    expect(Object.keys(p.level.year.N).sort()).toEqual([...p.level.year.phrases].sort());
  });

  it('cohort-only rule: d-011\'s modules (ACC1701XA/XC cohort-only; ACC2706, FIN2704X, QF1100 not)', () => {
    // Prerequisite fields of the pinned corpus, verbatim.
    const cohort = 'If undertaking an Undergraduate DegreeTHENmust be in one of the cohorts from 2017 inclusive';
    const acc2706 = 'If undertaking an Undergraduate DegreeTHEN( must have completed 1 of EC2204 at a grade of at least D, any Courses beginning with ACC1701 at a grade of at least DANDmust be in one of the cohorts from 2017 inclusive )';
    const fin2704x = 'If undertaking an Undergraduate Degree THEN ( must have completed 1 of EC2204 at a grade of at least D, any Courses beginning with ACC1701 at a grade of at least D AND must be in one of the cohorts from 2017 inclusive )';
    const qf1100 = 'If undertaking an Undergraduate DegreeTHEN(( must have completed 1 of 06 MATHEMATICS/07 FURTHER MATHEMATICS at a grade of at least E)OR( must have completed 1 of MA1301/MA1301X at a grade of at least D))';
    expect(isCohortOnly(cohort)).toBe(true);
    for (const t of [acc2706, fin2704x, qf1100]) expect(isCohortOnly(t)).toBe(false);
    expect(isCohortOnly(null)).toBe(false);
    expect(isCohortOnly('If undertaking an Undergraduate Degree THEN (must be undertaking 1004PRMHON Bachelor of Pharmacy (Hons))')).toBe(true);
    expect(isCohortOnly('If undertaking an Undergraduate DegreeTHEN((must be undertaking 0112SWHON Bachelor of Social Sciences - Social Work (Hons)ORmust be undertaking 0112SW2MJ Social Work (2nd Major)ORmust be undertaking 0112SHMIN Human Services (Minor)))')).toBe(true);
    expect(isCohortOnly('if undertaking an Undergraduate Degree then ( must be undertaking 2001CEGHON Bachelor of Engineering (CEG) and must be Year 3 or 4 )')).toBe(false);
    expect(isCohortOnly('If undertaking an Undergraduate Degree THEN must be in one of the cohorts from 2021 inclusive AND the student must have achieved at least 80 units prior to enrolment')).toBe(false);
    expect(isCohortOnly('If undertaking an Undergraduate DegreeTHEN(if in one of the cohorts from 2025 inclusiveTHENmust have completed 1 of any Courses beginning with UTC18 at a grade of at least D)')).toBe(false);
  });

  it('T: the smallest oracle overlap@10 over the 6 dev typo pairs, capped at 7', () => {
    const t = readJson(join(RULES, 'typo-threshold.json'));
    expect(t.perPair.map((/** @type {any} */ p) => p.id)).toEqual(['d-093', 'd-094', 'd-095', 'd-096', 'd-097', 'd-099']);
    for (const p of t.perPair) expect(p.oracleOverlapAt10, p.id).toBe(overlapAt10(p.oracleTop10, p.cleanTop10));
    expect(t.cap).toBe(7);
    expect(t.T).toBe(Math.min(t.cap, ...t.perPair.map((/** @type {any} */ p) => p.oracleOverlapAt10)));
    expect(t.ranker.sha).toBe('8adb476c3f51e7a2e67dc39b02aa96ff918cf362');
  });
});
