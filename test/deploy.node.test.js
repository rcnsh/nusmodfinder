// @ts-check
// scripts/deploy.mjs: refuses a dirty tree or an unpushed HEAD, and otherwise
// tags the version with the commit. git and wrangler are a fake exec, so
// nothing here deploys or touches the repo.
import { describe, expect, it } from 'vitest';
import { deploy } from '../scripts/deploy.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '9b1c2d3e-4f50-4a6b-8c7d-0e1f2a3b4c5d';

/**
 * A fake exec answering git and wrangler from a table; records every call.
 * @param {Record<string, { code?: number, stdout?: string }>} [over] keyed by `cmd args…`
 */
function fakeExec(over = {}) {
  /** @type {Record<string, { code?: number, stdout?: string }>} */
  const table = {
    'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: '' },
    'git ls-files -v': { stdout: 'H src/index.js\nH package.json\n' },
    'git fetch --quiet origin main': {},
    'git rev-parse HEAD': { stdout: `${SHA}\n` },
    'git rev-parse refs/remotes/origin/main': { stdout: `${SHA}\n` },
    'git merge-base --is-ancestor HEAD refs/remotes/origin/main': {},
    'git rev-parse --short HEAD': { stdout: '0123456\n' },
    'git log -1 --format=%s': { stdout: 'feat(search): add Server-Timing\n' },
    ...over,
  };
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'npx') {
      const w = over.wrangler ?? { stdout: `Uploaded vector-nusmods\nDeployed vector-nusmods triggers\nCurrent Version ID: ${VERSION}\n` };
      return { code: w.code ?? 0, stdout: w.stdout ?? '' };
    }
    const hit = table[[cmd, ...args].join(' ')];
    if (!hit) throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    return { code: hit.code ?? 0, stdout: hit.stdout ?? '' };
  };
  return { exec, calls };
}

/** @param {import('../scripts/deploy.mjs').Exec} exec */
async function runDeploy(exec) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await deploy({ exec, log: (m) => out.push(m), error: (m) => err.push(m) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const ranWrangler = (/** @type {string[][]} */ calls) => calls.some((c) => c[0] === 'npx');

describe('npm run deploy', () => {
  it('refuses a dirty working tree and never runs wrangler', async () => {
    const { exec, calls } = fakeExec({ 'git status --porcelain --untracked-files=all --ignore-submodules=none': { stdout: ' M src/index.js\n?? scratch.txt\n' } });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(1);
    expect(err).toContain('not clean');
    expect(err).toContain('M src/index.js');
    expect(ranWrangler(calls)).toBe(false);
  });

  it('refuses when HEAD is not on origin/main', async () => {
    const { exec, calls } = fakeExec({
      'git rev-parse HEAD': { stdout: 'feedface\n' },
      'git merge-base --is-ancestor HEAD refs/remotes/origin/main': { code: 1 },
    });
    const { code, err } = await runDeploy(exec);
    expect(code).toBe(1);
    expect(err).toContain('not on origin/main');
    expect(ranWrangler(calls)).toBe(false);
  });

  it('refuses when files are hidden by assume-unchanged or skip-worktree', async () => {
    for (const line of ['h src/index.js', 'S src/search.js']) {
      const { exec, calls } = fakeExec({ 'git ls-files -v': { stdout: `H package.json\n${line}\n` } });
      const { code, err } = await runDeploy(exec);
      expect(code).toBe(1);
      expect(err).toContain('assume-unchanged or skip-worktree');
      expect(ranWrangler(calls)).toBe(false);
    }
  });

  it('refuses when origin/main cannot be fetched', async () => {
    const { exec, calls } = fakeExec({ 'git fetch --quiet origin main': { code: 128 } });
    expect((await runDeploy(exec)).code).toBe(1);
    expect(ranWrangler(calls)).toBe(false);
  });

  it('deploys a clean, pushed HEAD tagged with its short SHA and prints the version id', async () => {
    const { exec, calls } = fakeExec();
    const { code, out } = await runDeploy(exec);
    expect(code).toBe(0);
    expect(calls.find((c) => c[0] === 'npx')).toEqual([
      'npx', 'wrangler', 'deploy', '--tag', '0123456', '--message', '0123456 feat(search): add Server-Timing',
    ]);
    expect(out).toContain(`version ${VERSION} (tag 0123456)`);
  });

  it('caps the version message at 100 characters', async () => {
    const { exec, calls } = fakeExec({ 'git log -1 --format=%s': { stdout: `${'x'.repeat(150)}\n` } });
    await runDeploy(exec);
    const args = /** @type {string[]} */ (calls.find((c) => c[0] === 'npx'));
    expect(args[args.indexOf('--message') + 1]).toHaveLength(100);
  });

  it('passes a wrangler failure through as the exit code', async () => {
    const { exec } = fakeExec({ wrangler: { code: 2, stdout: '' } });
    expect((await runDeploy(exec)).code).toBe(2);
  });
});
