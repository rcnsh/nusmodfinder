// @ts-check
// Duplicate groups from the corpus (eval/lib/groups.mjs) and how scoring uses
// them. The rebuild check over the full pinned corpus is test/full/groups.node.test.js.
import { describe, expect, it } from 'vitest';
import { CorpusMismatchError } from '../../eval/lib/errors.mjs';
import { buildGroups, groupsFile, loadGroups, serialiseGroups, withCorpusGroups } from '../../eval/lib/groups.mjs';
import { scoreRun } from '../../eval/lib/metrics.mjs';
import { PINNED_MODULE_INFO_SHA256, PINNED_RELEASE } from '../../scripts/pinned-corpus.mjs';

const MI = PINNED_MODULE_INFO_SHA256;
/** @param {string} code @param {string} title @param {string} [description] */
const m = (code, title, description = `About ${code}.`) => ({ code, title, description });

describe('buildGroups', () => {
  it('groups a variant family with the same title, ignoring case and whitespace', () => {
    const { groups } = buildGroups([
      m('TR3202I', 'Start-up Internship Programme'),
      m('TR3202S', 'Start-up  internship programme '),
      m('TR3202T', 'START-UP INTERNSHIP PROGRAMME'),
      m('ACC1701X', 'Accounting for Decision Makers'),
      m('ACC1701XA', 'Accounting for Decision Makers'),
    ]);
    expect(groups).toEqual([['ACC1701X', 'ACC1701XA'], ['TR3202I', 'TR3202S', 'TR3202T']]);
  });

  it('keeps a family apart when the titles differ, and different digits or prefixes apart', () => {
    const { groups } = buildGroups([
      m('MA2101', 'Linear Algebra II'),
      m('MA2101S', 'Linear Algebra II (S)'),
      m('CS1010', 'Programming Methodology'),
      m('CS1101S', 'Programming Methodology'),
      m('TCE2112', 'Soil Mechanics'),
      m('CE2112', 'Soil Mechanics'),
    ]);
    expect(groups).toEqual([]);
  });

  it('groups cross-listings: identical title and description after normalisation', () => {
    const { groups } = buildGroups([
      m('GET1028', 'Logic', 'Reasoning  well.\n'),
      m('GEX1014', 'logic', 'reasoning well.'),
      m('CS4225', 'Big Data Systems', 'One text.'),
      m('CS5425', 'Big Data Systems', 'Another text.'),
    ]);
    expect(groups).toEqual([['GET1028', 'GEX1014']]);
  });

  it('a placeholder description never makes a cross-listing', () => {
    const { groups } = buildGroups([
      m('BN5999', 'Graduate Seminars', 'Not Available'),
      m('EE5999', 'Graduate Seminars', 'Not Available'),
      m('ME5999', 'Graduate Seminars', ''),
      m('MT5999', 'Graduate Seminars', ''),
    ]);
    expect(groups).toEqual([]);
  });

  it('is transitive across both relations, drops singletons, and counts', () => {
    const r = buildGroups([
      m('CS2030', 'Programming Methodology II', 'Java.'),
      m('CS2030S', 'Programming Methodology II', 'Java, again.'), // variant of CS2030
      m('TIC2030', 'Programming Methodology II', 'Java, again.'), // cross-listed with CS2030S
      m('CS3230', 'Algorithms'),
    ]);
    expect(r.groups).toEqual([['CS2030', 'CS2030S', 'TIC2030']]);
    expect(r.counts).toEqual({ groups: 1, members: 3, largest: 3 });
  });

  it('does not depend on input order', () => {
    const mods = [m('B1000', 'X'), m('B1000A', 'X'), m('A2000', 'Y', 'd'), m('C3000', 'Y', 'd'), m('A2000B', 'Y', 'other')];
    expect(buildGroups([...mods].reverse())).toEqual(buildGroups(mods));
    expect(buildGroups(mods).groups).toEqual([['A2000', 'A2000B', 'C3000'], ['B1000', 'B1000A']]);
  });
});

describe('the committed eval/groups.json', () => {
  it('is a valid groups file for the pinned corpus, with consistent counts', async () => {
    const f = await loadGroups();
    expect(f.corpus).toMatchObject({ release: PINNED_RELEASE, moduleInfoSha256: MI });
    expect(f.counts.groups).toBe(f.groups.length);
    expect(f.counts.members).toBe(f.groups.flat().length);
    expect(new Set(f.groups.flat()).size).toBe(f.counts.members); // no code in two groups
    expect(f.groups).toContainEqual(['TR3202I', 'TR3202N', 'TR3202S', 'TR3202T']);
    expect(serialiseGroups(f)).toBe(serialiseGroups(JSON.parse(serialiseGroups(f))));
  });
});

/** @returns {import('../../eval/lib/metrics.mjs').Qrels} */
const qrelsOn = (/** @type {string} */ sha, /** @type {string[][]} */ groups = []) => ({
  version: 'q-test', corpus: { moduleInfoSha256: sha }, groups,
  queries: { q1: { judgments: { TR3202I: 2, TR3202S: 2, X: 1 } } },
});

describe('withCorpusGroups', () => {
  const corpusGroups = groupsFile([m('TR3202I', 'Internship'), m('TR3202S', 'Internship'), m('X', 'x')], { release: PINNED_RELEASE, moduleInfoSha256: MI });

  it('adds the corpus groups to the groups the qrels carry', () => {
    expect(withCorpusGroups(qrelsOn(MI, [['X', 'Y']]), corpusGroups).groups).toEqual([['X', 'Y'], ['TR3202I', 'TR3202S']]);
  });

  it('refuses groups built from another corpus, naming hashes only', () => {
    const other = '0'.repeat(64);
    expect(() => withCorpusGroups(qrelsOn(other), corpusGroups)).toThrow(CorpusMismatchError);
    expect(() => withCorpusGroups(qrelsOn(other), corpusGroups))
      .toThrow(/^duplicate groups groups-v1 were built from a corpus with moduleInfoSha256 2d138795d387…, but qrels q-test were judged on 000000000000…/);
    expect(() => withCorpusGroups(/** @type {any} */ ({ version: 'q0', queries: {} }), corpusGroups)).toThrow(CorpusMismatchError);
  });

  it('scoring with them: a group\'s second member earns no gain and the ideal ranking holds one per group', () => {
    const queries = [{ id: 'q1', text: 'internship' }];
    /** @param {string[]} codes @returns {import('../../eval/lib/metrics.mjs').RunFile} */
    const run = (codes) => ({ schema: 'vnm-eval-run/1', variant: 'v', set: 'dev', docs: {}, results: { q1: { status: 200, codes } } });
    const L = Math.log2;
    const plain = qrelsOn(MI);
    const grouped = withCorpusGroups(plain, corpusGroups);

    // Without groups: ideal is TR3202I, TR3202S, X; both internships earn gain.
    const [before] = scoreRun(run(['TR3202I', 'TR3202S', 'X']), queries, plain);
    expect(before.ndcg).toBeCloseTo(1, 12);
    expect(before.p5).toBe(3 / 5);

    // With groups: TR3202S is a duplicate, so it earns nothing and does not count for P@5;
    // the ideal is one internship (grade 2) and X (grade 1).
    const idcg = 3 / L(2) + 1 / L(3);
    const [after] = scoreRun(run(['TR3202I', 'TR3202S', 'X']), queries, grouped);
    expect(after.ndcg).toBeCloseTo((3 / L(2) + 0 + 1 / L(4)) / idcg, 12);
    expect(after.p5).toBe(2 / 5);
    // The deduped ranking is ideal.
    const [deduped] = scoreRun(run(['TR3202S', 'X']), queries, grouped);
    expect(deduped.ndcg).toBeCloseTo(1, 12);
    // MRR counts only a group's first member: a grade-0 sibling ahead takes the group's slot.
    const zero = { ...grouped, queries: { q1: { judgments: { TR3202I: 0, TR3202S: 2, X: 1 } } } };
    expect(scoreRun(run(['TR3202I', 'TR3202S', 'X']), queries, zero)[0].rr).toBe(1 / 3);
  });

  it('a returned member that breaks the query\'s constraints is no duplicate for it', () => {
    // ACC3704 and ACC4702 are one cross-listing (eval/groups.json) at levels 3 and 4. For a
    // level-4 query ACC3704 is graded 0 by rule; ranked first it must not take ACC4702's slot.
    const queries = [{ id: 'q1', text: 'audit', constraints: { level: 4 } }];
    const qrels = withCorpusGroups({
      version: 'q-test', corpus: { moduleInfoSha256: MI }, queries: { q1: { judgments: { ACC3704: 0, ACC4702: 2 } } },
    }, groupsFile([m('ACC3704', 'Audit', 'Same.'), m('ACC4702', 'Audit', 'Same.')], { release: PINNED_RELEASE, moduleInfoSha256: MI }));
    expect(qrels.groups).toEqual([['ACC3704', 'ACC4702']]);
    const doc = (/** @type {number} */ level) => ({ level, semesters: [1], ng: false, ngSemesters: [], credits: 4, faculty: 'Business' });
    /** @type {import('../../eval/lib/metrics.mjs').RunFile} */
    const r = { schema: 'vnm-eval-run/1', variant: 'v', set: 'dev', docs: { ACC3704: doc(3), ACC4702: doc(4) }, results: { q1: { status: 200, codes: ['ACC3704', 'ACC4702'] } } };
    const [s] = scoreRun(r, queries, qrels);
    expect(s.ndcg).toBeCloseTo(1 / Math.log2(3), 12);
    expect(s.p5).toBe(1 / 5);
    expect(s.rr).toBe(1 / 2);
    expect(s.violations).toBe(1);
  });
});
