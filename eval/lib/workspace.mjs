// @ts-check
// Builds the directory a run executes in: the ranker under test (src/,
// migrations/, scripts/lib.mjs and data/ — the embedding text is part of the
// ranker) from a git ref or the working tree, overlaid with the HEAD runner
// (eval/runner/, test/helpers.js, test/fakes.js and what they import). Used
// for `--ref eval-v0`: tag + overlaid runner, as the plan's r3 requires.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { REPO } from './sets.mjs';

/** Ranker files taken from the ref (or working tree). */
const RANKER = ['src', 'migrations', 'scripts/lib.mjs', 'data'];
/** Runner files always taken from the working tree. */
const RUNNER = ['eval/runner/retrieval.eval.js', 'eval/runner/lookup-ai.js', 'test/helpers.js', 'test/fakes.js', 'test/fixtures/corpus.json'];
/** Test-only Worker config: from the ref if it has one (its own compat date), else HEAD's. */
const TEST_CONFIG = 'test/wrangler.test.jsonc';

/**
 * @param {string[]} args
 * @param {{ input?: Buffer, cwd?: string }} [options]
 */
export function git(args, options = {}) {
  const r = spawnSync('git', args, { cwd: options.cwd ?? REPO, input: options.input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

/** @param {string} ref @param {string} path */
const existsAt = (ref, path) => spawnSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd: REPO }).status === 0;

/** @param {string[]} paths */
const dirty = (paths) => git(['status', '--porcelain', '--', ...paths]).toString().trim() !== '';

/**
 * @typedef {{ ref: string, sha: string, dirty: boolean, runner: { sha: string, dirty: boolean } }} RankerInfo
 */

/**
 * @param {{ ref?: string, name: string }} options
 * @returns {Promise<{ root: string, ranker: RankerInfo }>}
 */
export async function buildWorkspace({ ref, name }) {
  const root = join(REPO, '.eval-work', `ws-${name}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const head = git(['rev-parse', 'HEAD']).toString().trim();

  /** @type {RankerInfo['sha']} */
  let sha;
  if (ref) {
    sha = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
    const present = [...RANKER, TEST_CONFIG].filter((p) => existsAt(sha, p));
    for (const need of ['src', 'migrations', 'scripts/lib.mjs']) {
      if (!present.includes(need)) throw new Error(`${ref} has no ${need}; it cannot be evaluated with this runner`);
    }
    const tar = git(['archive', '--format=tar', sha, '--', ...present]);
    const r = spawnSync('tar', ['-x', '-C', root], { input: tar });
    if (r.status !== 0) throw new Error(`extracting ${ref}: ${r.stderr.toString()}`);
  } else {
    sha = head;
    for (const p of [...RANKER, TEST_CONFIG]) {
      if (existsSync(join(REPO, p))) await cp(join(REPO, p), join(root, p), { recursive: true });
    }
  }
  for (const p of RUNNER) {
    await mkdir(dirname(join(root, p)), { recursive: true });
    await cp(join(REPO, p), join(root, p));
  }
  if (!existsSync(join(root, TEST_CONFIG))) await cp(join(REPO, TEST_CONFIG), join(root, TEST_CONFIG));

  return {
    root,
    ranker: {
      ref: ref ?? 'WORKTREE',
      sha,
      dirty: ref ? false : dirty(RANKER),
      runner: { sha: head, dirty: dirty(['eval/runner', 'eval/lib', 'test/helpers.js', 'test/fakes.js', 'vitest.eval.config.mjs']) },
    },
  };
}
