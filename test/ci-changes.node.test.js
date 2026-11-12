// @ts-check
// scripts/ci-changes.mjs, the one diff rule CI's heavy jobs skip by. Every case is a
// table row over injected git and GitHub answers; nothing here calls GitHub, and git only in a temp repo.
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { changedFiles, changes, decide, resolveBase } from '../scripts/ci-changes.mjs';
import { DEFAULT_ACAD_YEAR } from '../scripts/lib.mjs';

const ALL = { code: true, ui: true, grid: true, rollover: true };
const NONE = { code: false, ui: false, grid: false, rollover: false };

describe('decide: which heavy jobs a diff needs', () => {
  it.each([
    ['a docs-only diff', ['docs/incidents.md', 'docs/year-refresh/README.md'], NONE],
    ['a docs/ diff (npm test reads it, and check always runs)', ['docs/operations.md'], NONE],
    ['a root markdown diff', ['README.md', 'EVAL.md'], NONE],
    ['a public/ diff', ['public/app.js'], { code: true, ui: true, grid: false, rollover: true }],
    ['a data/ diff', [`data/ng-courses-${DEFAULT_ACAD_YEAR}.json`], { code: true, ui: true, grid: false, rollover: true }],
    ['a file the UI suite imports from test/web', ['test/web/rfc4180.node.mjs'], { code: true, ui: true, grid: false, rollover: true }],
    ['the exchange oracle, which the UI suite imports', [`test/oracle/oracle-${DEFAULT_ACAD_YEAR}.node.mjs`], { code: true, ui: true, grid: false, rollover: true }],
    ['a src/ diff', ['src/search.js'], ALL],
    ['a test/full diff', ['test/full/lexical.test.js'], { code: true, ui: false, grid: true, rollover: true }],
    ['an eval/ diff', ['eval/lib/sets.mjs'], { code: true, ui: false, grid: false, rollover: true }],
    ['a change to the workflow itself', ['.github/workflows/ci.yml'], ALL],
    ['a change to this rule', ['scripts/ci-changes.mjs'], ALL],
    ['no change at all', [], NONE],
  ])('%s', (_name, files, want) => {
    expect(decide(files)).toEqual(want);
  });
});

/** @type {(o?: Partial<Parameters<typeof changes>[0]>) => Parameters<typeof changes>[0]} */
const inputs = (o = {}) => ({
  event: 'pull_request',
  prBase: 'b'.repeat(40),
  listGreen: () => { throw new Error('a PR never lists runs'); },
  reachable: () => true,
  diff: () => ['docs/operations.md'],
  ...o,
});

describe('changes: the base, and when everything runs', () => {
  it('a PR diffs against its base sha', () => {
    /** @type {string[]} */
    const asked = [];
    const r = changes(inputs({ diff: (base) => { asked.push(base); return ['public/app.js']; } }));
    expect(asked).toEqual(['b'.repeat(40)]);
    expect(r).toMatchObject({ full: false, base: 'b'.repeat(40), code: true, ui: true, grid: false });
  });

  it('a push to main diffs against the newest green main commit that HEAD contains', () => {
    const r = changes(inputs({
      event: 'push', prBase: undefined,
      listGreen: () => ['1'.repeat(40), '2'.repeat(40)],
      reachable: (sha) => sha === '2'.repeat(40),
      diff: () => ['docs/x.md'],
    }));
    expect(r).toMatchObject({ full: false, base: '2'.repeat(40), ...NONE });
  });

  it.each([
    ['no green base', inputs({ event: 'push', prBase: undefined, listGreen: () => [] })],
    ['an unreachable base', inputs({ reachable: () => false })],
    ['an API error', inputs({ event: 'push', prBase: undefined, listGreen: () => { throw new Error('HTTP 502'); } })],
    ['a failed diff', inputs({ diff: () => { throw new Error('bad object'); } })],
    ['workflow_dispatch', inputs({ event: 'workflow_dispatch', prBase: undefined })],
  ])('%s runs everything', (_name, given) => {
    const r = changes(given);
    expect(r).toMatchObject({ full: true, ...ALL });
    expect(r.reason).toBeTruthy();
  });

  it('resolveBase names the PR base, the last green push, or none', () => {
    expect(resolveBase(inputs())).toEqual({ base: 'b'.repeat(40) });
    expect(resolveBase(inputs({ event: 'push', prBase: undefined, listGreen: () => ['3'.repeat(40)] }))).toEqual({ base: '3'.repeat(40) });
    expect(resolveBase(inputs({ event: 'push', prBase: undefined, listGreen: () => [] }))).toMatchObject({ base: null, reason: expect.stringMatching(/no green/) });
  });
});

describe('changedFiles', () => {
  it('names a moved file at its old path too, so moving code out of a suite\'s paths still runs it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vnm-ci-changes-'));
    try {
      const git = (/** @type {string[]} */ ...args) => {
        const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(r.stderr);
        return r.stdout.trim();
      };
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      git('config', 'commit.gpgsign', 'false');
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/search.js'), `${'export const line = 1;\n'.repeat(20)}`);
      git('add', '-A');
      git('commit', '-q', '-m', 'base');
      const base = git('rev-parse', 'HEAD');
      await mkdir(join(dir, 'docs'), { recursive: true });
      git('mv', 'src/search.js', 'docs/search.js');
      git('commit', '-q', '-m', 'move');
      const files = changedFiles(base, dir);
      expect(files.sort()).toEqual(['docs/search.js', 'src/search.js']);
      expect(decide(files)).toMatchObject({ code: true, ui: true, grid: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
