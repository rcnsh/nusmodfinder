// @ts-check
// P-6: the lists code will read (eval/prereg/*.json) parse, follow the rules
// the prereg doc states, and match the counts in its "Machine-readable lists"
// table, so the doc and the files cannot drift apart.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../eval/lib/sets.mjs';
import { isCohortOnly } from '../../eval/prereg/cohort-only.mjs';
import { CAP, overlapAt, thresholdT } from '../../eval/prereg/typo-threshold.mjs';
import { DOC_PATH, readJson } from './sc4.node.mjs';

const PREREG = join(REPO, 'eval/prereg');
const doc = readFileSync(DOC_PATH, 'utf8');

/**
 * The doc's count rows: | label | `file` | `key.path` | n |
 * @returns {{ label: string, file: string, key: string, n: number }[]}
 */
function docCounts() {
  return [...doc.matchAll(/^\| ([^|]+?) \| `([^`]+\.json)` \| `([^`]+)` \| (\d+) \|$/gm)]
    .map((m) => ({ label: m[1], file: m[2], key: m[3], n: Number(m[4]) }));
}

/** @param {any} obj @param {string} path dot path; a key may hold dots only inside [brackets] */
function at(obj, path) {
  const parts = [...path.matchAll(/\[([^\]]+)\]|([^.[\]]+)/g)].map((m) => m[1] ?? m[2]);
  return parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** @param {unknown} v */
const sizeOf = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : NaN);

/** Rows the doc must carry. */
const REQUIRED = [
  ['eval/prereg/stopwords.json', 'current'],
  ['eval/prereg/stopwords.json', 'v2Additions'],
  ['eval/prereg/stopwords.json', 'v2'],
  ['eval/prereg/collision-list.json', 'seed'],
  ['eval/prereg/collision-list.json', 'added'],
  ['eval/prereg/collision-list.json', 'list'],
  ['eval/prereg/ge-pillars.json', 'prefixes'],
  ['eval/prereg/ge-pillars.json', 'pillars'],
  ['eval/prereg/ge-pillars.json', 'genericPhrases'],
  ['eval/prereg/intent-phrases.json', 'constraints.exam.phrases'],
  ['eval/prereg/intent-phrases.json', 'constraints.su.phrases'],
  ['eval/prereg/intent-phrases.json', 'constraints.hoursBelow.phrases'],
  ['eval/prereg/intent-phrases.json', 'constraints.prereq.phrases'],
  ['eval/prereg/intent-phrases.json', 'level.beginner.phrases'],
  ['eval/prereg/intent-phrases.json', 'level.graduate.phrases'],
  ['eval/prereg/intent-phrases.json', 'level.levelN.phrases'],
  ['eval/prereg/intent-phrases.json', 'level.year.phrases'],
  ['eval/prereg/intent-phrases.json', 'negators'],
  ['eval/prereg/cohort-only-prereq.json', 'remove'],
  ['eval/prereg/grids.json', '[3D].alpha'],
  ['eval/prereg/grids.json', '[3D].beta'],
  ['eval/prereg/grids.json', '[3E].gridOrder'],
  ['eval/prereg/grids.json', '[3H].pooled'],
  ['eval/dev/gibberish.json', 'strings'],
  ['eval/dev/gibberish.json', 'split.derivation'],
  ['eval/dev/gibberish.json', 'split.gate'],
  ['test/sc4/queries.json', 'items'],
];

describe('P-6 machine-readable lists', () => {
  it('every eval/prereg JSON file parses and names its schema', () => {
    const files = readdirSync(PREREG).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) expect(readJson(join(PREREG, f)).schema, f).toMatch(/^vnm-p6-/);
  });

  it('match every count in the prereg doc\'s table, and the table covers every list', () => {
    const rows = docCounts();
    for (const [file, key] of REQUIRED) {
      expect(rows.some((r) => r.file === file && r.key === key), `${file} ${key} in the doc`).toBe(true);
    }
    for (const r of rows) expect(sizeOf(at(readJson(join(REPO, r.file)), r.key)), `${r.label} (${r.file} ${r.key})`).toBe(r.n);
  });

  it('stopwords: current is src/fts-query.js\'s list, and v2 is current plus the plan\'s additions', () => {
    const s = readJson(join(PREREG, 'stopwords.json'));
    const src = readFileSync(join(REPO, 'src/fts-query.js'), 'utf8');
    const m = src.match(/const STOPWORDS = new Set\(\[([^\]]+)\]\)/);
    const shipped = [...(/** @type {RegExpMatchArray} */ (m)[1].matchAll(/'([^']+)'/g))].map((x) => x[1]);
    expect(s.current).toEqual(shipped);
    expect(s.v2Additions).toEqual(['class', 'course', 'courses', 'module', 'modules', 'nus', 'something', 'teach']);
    expect(s.v2).toEqual([...new Set([...s.current, ...s.v2Additions])].sort());
    for (const w of s.notStopwords) expect(s.v2).not.toContain(w);
  });

  it('collision list: the plan\'s seed plus the added words, sorted, none of them a pillar prefix', () => {
    const c = readJson(join(PREREG, 'collision-list.json'));
    expect(c.seed).toEqual(['AI', 'AN', 'CE', 'DSA', 'EE', 'GE', 'IS', 'IT', 'JS', 'LAB', 'LL', 'MA', 'ME', 'PE', 'PR', 'SE']);
    expect(c.list).toEqual([...new Set([...c.seed, ...Object.keys(c.added)])].sort());
    const pillars = readJson(join(PREREG, 'ge-pillars.json')).prefixes;
    expect(c.exempt).toEqual(pillars);
    expect(c.list.filter((/** @type {string} */ p) => pillars.includes(p))).toEqual([]);
  });

  it('GE table: every pillar maps into the ten pillar prefixes, and every prefix has a pillar', () => {
    const g = readJson(join(PREREG, 'ge-pillars.json'));
    expect(g.prefixes).toEqual(['GEA', 'GEC', 'GEH', 'GEI', 'GEN', 'GEQ', 'GES', 'GESS', 'GET', 'GEX']);
    const mapped = g.pillars.flatMap((/** @type {any} */ p) => p.prefixes);
    expect([...mapped].sort()).toEqual(g.prefixes);
    expect(g.genericPhrases).toEqual(['ge', 'gen ed', 'general education']);
  });

  it('intent phrases: lower-case, no phrase in two lists but `no background` (beginner and prereq)', () => {
    const p = readJson(join(PREREG, 'intent-phrases.json'));
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

  it('cohort-only rule: d-011\'s modules read as the plan says (ACC1701XA/XC cohort-only; ACC2706, FIN2704X, QF1100 not)', () => {
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

  it('grids: the plan\'s finite candidate sets', () => {
    const g = readJson(join(PREREG, 'grids.json'));
    expect(Object.keys(g['3A-2'].variants)).toEqual(['v1', 'v2', 'v3']);
    expect(g['3C'].variants).toEqual(['3C-1', '3C-2']);
    expect(g['3D'].alpha).toEqual([0, 0.1, 0.2, 0.35]);
    expect(g['3D'].beta).toEqual([0.1, 0.2, 0.35]);
    const points = g['3E'].wvOverWl.flatMap((/** @type {number} */ w) => g['3E'].k.map((/** @type {number} */ k) => [w, k]));
    expect(g['3E'].gridOrder).toEqual(points);
    expect(points).toHaveLength(8);
    expect(g['3E'].wc).toBe(1);
    expect(g['3H'].pooled).toHaveLength(4);
    expect(g['3H'].rawMargin).toBe(0.05);
    expect(g['3G'].gateHalfThreshold).toBe(0.9);
  });

  it('T: the smallest oracle overlap@10 over the 6 dev typo pairs, capped at 7', () => {
    expect(thresholdT([5, 10, 5, 5, 7, 7])).toBe(5);
    expect(thresholdT([9, 8, 10])).toBe(CAP);
    expect(overlapAt(['a', 'b', 'c'], ['c', 'x', 'a'])).toBe(2);
    expect(overlapAt([...'abcdefghijkl'], [...'lkjihgfedcba'])).toBe(8);
    const t = readJson(join(REPO, 'eval/prereg/typo-threshold.json'));
    expect(t.perPair.map((/** @type {any} */ p) => p.id)).toEqual(['d-093', 'd-094', 'd-095', 'd-096', 'd-097', 'd-099']);
    expect(t.T).toBe(thresholdT(t.perPair.map((/** @type {any} */ p) => p.oracleOverlapAt10)));
    for (const p of t.perPair) {
      expect(p.oracleOverlapAt10).toBe(overlapAt(p.oracleTop10, p.cleanTop10));
    }
    expect(t.ranker.sha).toBe('e8a712468b2f59c4d9dcaeef2fe9680a8b8b0f7d');
  });
});
