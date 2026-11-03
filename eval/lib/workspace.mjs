// @ts-check
// Builds the directory a run executes in: the ranker under test (src/,
// migrations/, scripts/lib.mjs and data/ — the embedding text is part of the
// ranker) from a git ref or the working tree, overlaid with the HEAD runner
// (eval/runner/, test/helpers.js, test/fakes.js and what they import). Used
// for `--ref eval-v0`: tag + overlaid runner, as the plan's r3 requires.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, rm } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { REPO } from './sets.mjs';

/** Ranker files taken from the ref (or working tree). */
export const RANKER = ['src', 'migrations', 'scripts/lib.mjs', 'data'];
/** Test-only Worker config: from the ref if it has one (its own compat date), else HEAD's. */
export const TEST_CONFIG = 'test/wrangler.test.jsonc';
/** What `ranker.treeHash` covers: the ranker plus the Worker config it runs under. */
export const HASHED = [...RANKER, TEST_CONFIG];

/**
 * Content hash of the ranker files under `root` (HASHED paths: RANKER and
 * the test Worker config, whose compatibility date and flags change what
 * runs): sha256 over
 * the sorted lines "<posix path>\0<kind>\0<sha256 of content or link target>".
 * Recorded as `ranker.treeHash`, so a run file says which ranker code actually
 * ran, whatever `git rev-parse` said about the ref.
 * @param {string} root
 * @param {string[]} [paths]
 */
export async function treeHash(root, paths = HASHED) {
  /** @type {string[]} */
  const entries = [];
  /** @param {string} abs */
  const visit = async (abs) => {
    const st = await lstat(abs);
    const rel = relative(root, abs).split(sep).join('/');
    if (st.isSymbolicLink()) {
      entries.push(`${rel}\0link\0${createHash('sha256').update(await readlink(abs)).digest('hex')}`);
    } else if (st.isDirectory()) {
      for (const name of await readdir(abs)) await visit(join(abs, name));
    } else if (st.isFile()) {
      entries.push(`${rel}\0file\0${createHash('sha256').update(await readFile(abs)).digest('hex')}`);
    }
  };
  for (const p of paths) if (existsSync(join(root, p))) await visit(join(root, p));
  entries.sort();
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}
/** Runner files always taken from the working tree. */
const RUNNER = ['eval/runner/retrieval.eval.js', 'eval/runner/lookup-ai.js', 'test/helpers.js', 'test/fakes.js', 'test/fixtures/corpus.json'];

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
 * `treeHash` is treeHash() of the ranker files as extracted into the workspace.
 * @typedef {{ ref: string, sha: string, dirty: boolean, treeHash: string, runner: { sha: string, dirty: boolean } }} RankerInfo
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
      dirty: ref ? false : dirty(HASHED),
      treeHash: await treeHash(root),
      runner: { sha: head, dirty: dirty(['eval/runner', 'eval/lib', 'test/helpers.js', 'test/fakes.js', 'vitest.eval.config.mjs']) },
    },
  };
}
