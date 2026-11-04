// @ts-check
// The pinned baseline of the custody gates. ADR 0003 pins `eval-v0` =
// 7ac9841 (the production ranker): the SC5 gate compares the final ranker
// with it, and every holdout verdict is taken against it. A verdict on an
// encrypted set refuses a baseline run unless
// - the tag `eval-v0` still resolves to the pinned commit;
// - the run file says it ran ref `eval-v0` at that commit, clean;
// - its `ranker.treeHash` is the hash of the pinned commit's ranker files
//   (`git archive`, the paths workspace.mjs hashes), so the files that ran
//   were eval-v0's whatever the sha field says.
// A run file is a ciphertext the custodian made; these checks catch a
// baseline from another ranker, a hand-edited one, and a moved tag. Moving
// the holdout baseline to a later shipped ranker means changing this pin and
// ADR 0003 in the same PR.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaselineError } from './errors.mjs';
import { REPO } from './sets.mjs';
import { HASHED, treeHash } from './workspace.mjs';

export const PINNED_BASELINE = Object.freeze({ ref: 'eval-v0', sha: '7ac984174ded88cb2b6497d9835b456981acdd99' });

/** How the pin is printed and recorded: "eval-v0 7ac9841". */
export const pinnedLabel = () => `${PINNED_BASELINE.ref} ${PINNED_BASELINE.sha.slice(0, 7)}`;

/** @type {Map<string, Promise<string>>} */
const trees = new Map();

/**
 * treeHash() of the pinned commit's ranker files, extracted with `git archive`
 * (what buildWorkspace extracts for `--ref eval-v0`). Once per process.
 * @param {string} [repo]
 */
export function pinnedTreeHash(repo = REPO) {
  if (!trees.has(repo)) trees.set(repo, computeTree(repo));
  return /** @type {Promise<string>} */ (trees.get(repo));
}

/** @param {string} repo */
async function computeTree(repo) {
  const { sha } = PINNED_BASELINE;
  const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: repo }).status === 0);
  if (!present.includes('src')) throw new BaselineError(`the pinned commit ${sha.slice(0, 7)} is not in this repository, so the baseline cannot be checked`);
  const tar = spawnSync('git', ['archive', '--format=tar', sha, '--', ...present], { cwd: repo, maxBuffer: 1 << 30 });
  if (tar.status !== 0) throw new BaselineError(`git archive ${sha.slice(0, 7)} failed: ${tar.stderr.toString().trim()}`);
  const dir = await mkdtemp(join(tmpdir(), 'vnm-pinned-'));
  try {
    const x = spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout });
    if (x.status !== 0) throw new BaselineError(`extracting ${sha.slice(0, 7)} failed: ${x.stderr.toString().trim()}`);
    return await treeHash(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Throws BaselineError unless `run` is a clean run of the pinned eval-v0
 * ranker and the tag still resolves to it.
 * @param {import('./metrics.mjs').RunFile} run
 * @param {{ repo?: string }} [options]
 */
export async function assertPinnedBaseline(run, options = {}) {
  const repo = options.repo ?? REPO;
  const { ref, sha } = PINNED_BASELINE;
  const short = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, 12) : String(v));
  const tag = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, encoding: 'utf8' });
  const resolved = tag.status === 0 ? tag.stdout.trim() : null;
  if (resolved !== sha) {
    throw new BaselineError(`the tag ${ref} resolves to ${resolved ? short(resolved) : 'nothing'}, but ADR 0003 pins ${ref} = ${sha.slice(0, 7)}; restore the tag before any verdict`);
  }
  const r = /** @type {any} */ (run.ranker) ?? {};
  const name = `baseline ${run.variant}`;
  if (r.ref !== ref) throw new BaselineError(`${name} ran ranker ref ${JSON.stringify(r.ref)}, not the pinned ${ref}`);
  if (r.sha !== sha) throw new BaselineError(`${name} ran ranker sha ${short(r.sha)}, not the pinned ${sha.slice(0, 7)}`);
  if (r.dirty !== false) throw new BaselineError(`${name} does not record a clean ranker (dirty: ${JSON.stringify(r.dirty)})`);
  const want = await pinnedTreeHash(repo);
  if (r.treeHash !== want) throw new BaselineError(`${name} has ranker treeHash ${short(r.treeHash)}, but the files of ${ref} hash to ${short(want)}`);
}
