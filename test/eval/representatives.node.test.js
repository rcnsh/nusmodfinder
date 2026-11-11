// @ts-check
// The semester representative's open-set check (eval/lib/representatives.mjs):
// only representatives change, each to a member offered in the semester the
// request named where the baseline's was not.
import { describe, expect, it } from 'vitest';
import { groupIndex, groupKeys } from '../../eval/lib/groups.mjs';
import { compareRepresentatives, requestSemester } from '../../eval/lib/representatives.mjs';

const groupOf = groupIndex([['ACC1701XA', 'ACC1701XB', 'ACC1701XC', 'ACC1701XD'], ['NGN2001F', 'NGN2001G']]);
const semestersOf = new Map([['ACC1701XA', [1, 2]], ['ACC1701XB', [2]], ['ACC1701XC', [1]], ['ACC1701XD', [2]], ['NGN2001F', [2]], ['NGN2001G', [1]], ['CS3244', [1, 2]]]);
const config = { mode: 'hybrid', filters: true, studyMap: 'x' };
const q = (/** @type {string} */ id, /** @type {any} */ filters) => ({ id, text: id, persona: undefined, shapes: ['topical'], filters });
const queries = [q('s1', { ng: true, sem: 1 }), q('s2', { ng: true, sem: 2 }), q('any', { ng: true })];
/** @param {Record<string, string[]>} lists @param {any} [cfg] */
const runOf = (lists, cfg = config) => /** @type {any} */ ({
  config: cfg, queries: { sha256: 'q' }, corpus: { moduleInfoSha256: 'c' },
  results: Object.fromEntries(Object.entries(lists).map(([id, codes]) => [id, { status: 200, codes }])),
});
const base = runOf({ s1: ['ACC1701XB', 'CS3244', 'NGN2001F'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] });
const check = (/** @type {any} */ run, /** @type {any} */ baseline = base) => compareRepresentatives({ queries, run, baseline, groupOf, semestersOf });

describe('groupKeys', () => {
  it('maps each code to its group\'s first member; a code in no group is its own', () => {
    expect(groupKeys(['ACC1701XC', 'CS3244', 'NGN2001G'], groupOf)).toEqual(['ACC1701XA', 'CS3244', 'NGN2001F']);
  });
});

describe('requestSemester', () => {
  it('is the semester the runner sends, none when filters are dropped or `sem` is stripped', () => {
    expect(requestSemester(queries[0], config)).toBe(1);
    expect(requestSemester(queries[2], config)).toBeUndefined();
    expect(requestSemester(queries[0], { ...config, filters: false })).toBeUndefined();
    expect(requestSemester(queries[0], { ...config, strip: ['sem'] })).toBeUndefined();
    expect(requestSemester(queries[0], { ...config, strip: ['ng'] })).toBe(1);
  });
});

describe('compareRepresentatives', () => {
  it('passes swaps to a member offered in the named semester, and counts them', () => {
    const r = check(runOf({ s1: ['ACC1701XC', 'CS3244', 'NGN2001G'], s2: ['ACC1701XA', 'CS3244'], any: ['ACC1701XB', 'CS3244'] }));
    expect(r).toEqual({ lists: 3, changedLists: 2, changedCodes: 3, problems: [] });
    expect(check(base)).toEqual({ lists: 3, changedLists: 0, changedCodes: 0, problems: [] });
  });

  it('fails a change in group order, a dropped or added group, and a status change', () => {
    expect(check(runOf({ s1: ['CS3244', 'ACC1701XC', 'NGN2001G'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] })).problems).toEqual([expect.stringMatching(/^s1: the group sequence differs/)]);
    expect(check(runOf({ s1: ['ACC1701XC', 'CS3244'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] })).problems).toEqual([expect.stringMatching(/^s1: the group sequence differs/)]);
    const errored = runOf({ s1: ['ACC1701XB', 'CS3244', 'NGN2001F'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] });
    errored.results.any = { status: 500, codes: [] };
    expect(check(errored).problems).toEqual(['any: status 200 -> 500']);
  });

  it('fails a swap with no semester named, away from an offered member, or to a member not offered', () => {
    const p = check(runOf({ s1: ['ACC1701XD', 'CS3244', 'NGN2001F'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XC', 'CS3244'] })).problems;
    expect(p).toEqual([
      's1 #1: ACC1701XB -> ACC1701XD, which is not offered in semester 1',
      'any #1: ACC1701XB -> ACC1701XC with no semester named',
    ]);
    const fromOffered = runOf({ s1: ['ACC1701XB', 'CS3244', 'NGN2001F'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] });
    const baseOffered = runOf({ s1: ['ACC1701XA', 'CS3244', 'NGN2001F'], s2: ['ACC1701XC', 'CS3244'], any: ['ACC1701XB', 'CS3244'] });
    expect(check(fromOffered, baseOffered).problems).toEqual(['s1 #1: ACC1701XA -> ACC1701XB, but ACC1701XA is offered in semester 1']);
  });

  it('refuses runs made with other settings, queries or corpus', () => {
    expect(check(runOf({ s1: [], s2: [], any: [] }, { ...config, strip: ['ng'] }), runOf({ s1: [], s2: [], any: [] })).problems)
      .toContain('the two runs were made with different settings (config)');
    const other = runOf({ s1: [], s2: [], any: [] });
    other.corpus.moduleInfoSha256 = 'd';
    other.queries.sha256 = 'r';
    expect(check(other, runOf({ s1: [], s2: [], any: [] })).problems).toEqual(['the two runs were made on different queries', 'the two runs were made on different corpora']);
  });
});

describe('eval:representatives', () => {
  it('refuses runs not made on the set\'s current queries, which would read the wrong semester', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawnSync } = await import('node:child_process');
    const { REPO } = await import('../../eval/lib/sets.mjs');
    const dir = await mkdtemp(join(tmpdir(), 'vnm-reps-'));
    try {
      const mod = (/** @type {string} */ code, /** @type {number[]} */ semesters) => ({ code, title: 'NUS College seminar', description: 'Same.', semesters });
      await writeFile(join(dir, 'corpus.json'), JSON.stringify({ source: { moduleInfoSha256: 'c0' }, modules: [mod('NGN2001F', [2]), mod('NGN2001G', [1])] }));
      const querySet = { schema: 'vnm-eval-queries/1', set: 'fixture', version: 'v2', queries: [{ id: 'q1', text: 'nus college', shapes: ['topical'], filters: { ng: true, sem: 1 } }] };
      await writeFile(join(dir, 'queries.json'), JSON.stringify(querySet));
      await mkdir(join(dir, 'runs'));
      const run = (/** @type {string} */ code, /** @type {string} */ sha) => JSON.stringify({ config, queries: { sha256: sha }, corpus: { moduleInfoSha256: 'c0' }, results: { q1: { status: 200, codes: [code] } } });
      const cli = () => spawnSync(process.execPath, [join(REPO, 'eval/representatives.mjs'), '--set', 'fixture', '--set-dir', dir, '--run', 'cand', '--baseline', 'base'], { encoding: 'utf8' });
      // Made when q1 asked for Sem 2: F (Sem 2) -> G (Sem 1) is a bad swap there.
      await writeFile(join(dir, 'runs', 'base.json'), run('NGN2001F', 'old'));
      await writeFile(join(dir, 'runs', 'cand.json'), run('NGN2001G', 'old'));
      const stale = cli();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toMatch(/not made on the fixture set's current queries/);
      // On the current queries the same swap is right for Sem 1.
      const { createHash } = await import('node:crypto');
      const sha = createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex');
      await writeFile(join(dir, 'runs', 'base.json'), run('NGN2001F', sha));
      await writeFile(join(dir, 'runs', 'cand.json'), run('NGN2001G', sha));
      const ok = cli();
      expect(ok.stderr).toBe('');
      expect(ok.stdout).toContain('lists 1, lists with a changed representative 1, codes changed 1, problems 0');
      expect(ok.status).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
