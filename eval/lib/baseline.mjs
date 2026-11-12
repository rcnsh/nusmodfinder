// @ts-check
// The pinned baselines of the custody gates (ADR 0003). There are two:
// - PINNED_BASELINE, the SC5 / test-set baseline: `eval-v0` = 7ac9841 (the
//   production ranker at the start of Phase 2). The SC5 rule compares the
//   final ranker with it, on the test set or, under the holdout reading, with
//   `--gate sc5`. It never moves.
// - SHIPPED_BASELINE, the ranker shipped now: every per-change holdout look
//   compares the candidate with it (ADR 0003 look procedure, A3-4). It starts
//   at eval-v0 and moves only in the PR that ships a change, which also adds
//   a line to ADR 0003's "Shipped-ranker pin" section;
//   test/eval/baseline.node.test.js ties the constant to that section's last
//   line.
// A verdict on an encrypted set refuses a baseline run unless, for its pin,
// - the pin's ref (a tag, or the plain sha) still resolves to the pinned commit;
// - the run file says it ran that ref at that commit, clean, with a clean runner;
// - it was run with the queries' filters, none stripped, in hybrid mode, and
//   with the committed study map if it records one (Phase 4);
// - its `ranker.treeHash` is the hash of the pinned commit's ranker files
//   (`git archive`, the paths workspace.mjs hashes), so the files that ran
//   were the pinned commit's whatever the sha field says.
// A run file is a ciphertext the custodian made; these checks catch a
// baseline from another ranker, a hand-edited one, and a moved tag.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaselineError } from './errors.mjs';
import { REPO, studyMapSha256 } from './sets.mjs';
import { HASHED, treeHash } from './workspace.mjs';

/** @typedef {Readonly<{ ref: string, sha: string }>} Pin */

/** The SC5 / test-set baseline. @type {Pin} */
export const PINNED_BASELINE = Object.freeze({ ref: 'eval-v0', sha: '7ac984174ded88cb2b6497d9835b456981acdd99' });

/** The shipped ranker, the baseline of per-change holdout looks. @type {Pin} */
export const SHIPPED_BASELINE = Object.freeze({ ref: 'a23601de0b15934960bfef1d8b56ab3e80fa5587', sha: 'a23601de0b15934960bfef1d8b56ab3e80fa5587' });

/**
 * How a pin is printed: "eval-v0 7ac9841" for a tag, the short sha for a plain sha.
 * @param {Pin} pin
 */
export const pinLabel = (pin) => (pin.ref === pin.sha ? pin.sha.slice(0, 7) : `${pin.ref} ${pin.sha.slice(0, 7)}`);

/**
 * The pin a custody verdict's baseline must match: the SC5 pin for an SC5
 * verdict (the test set, or `--gate sc5`), else the shipped-ranker pin.
 * @param {string} gate holdout | test
 * @param {import('./gate.mjs').Change} change
 * @returns {Pin}
 */
export const baselinePinFor = (gate, change) => (gate === 'test' || change.gate === 'sc5' ? PINNED_BASELINE : SHIPPED_BASELINE);

/** @type {Map<string, Promise<string>>} */
const trees = new Map();

/**
 * treeHash() of a pinned commit's ranker files, extracted with `git archive`
 * (what buildWorkspace extracts for `--ref <pin>`). Once per process and commit.
 * @param {string} [repo]
 * @param {string} [sha] default: the SC5 pin's
 */
export function pinnedTreeHash(repo = REPO, sha = PINNED_BASELINE.sha) {
  const key = `${repo}\0${sha}`;
  if (!trees.has(key)) trees.set(key, computeTree(repo, sha));
  return /** @type {Promise<string>} */ (trees.get(key));
}

/** @param {string} repo @param {string} sha */
async function computeTree(repo, sha) {
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
 * Throws BaselineError unless `run` is a clean, filtered, hybrid run of the
 * ranker `pin` names, and the pin's ref still resolves to its commit.
 * @param {import('./metrics.mjs').RunFile} run
 * @param {Pin} pin
 * @param {{ repo?: string }} [options]
 */
export async function assertBaselineAt(run, pin, options = {}) {
  const repo = options.repo ?? REPO;
  const { ref, sha } = pin;
  const what = pin === PINNED_BASELINE ? 'the SC5 baseline' : pin === SHIPPED_BASELINE ? 'the shipped-ranker pin' : 'the pin';
  const short = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, 12) : String(v));
  const tag = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, encoding: 'utf8' });
  const resolved = tag.status === 0 ? tag.stdout.trim() : null;
  if (resolved !== sha) {
    throw new BaselineError(`${ref} resolves to ${resolved ? short(resolved) : 'nothing'}, but ADR 0003 pins ${what} at ${ref} = ${sha.slice(0, 7)}; restore it before any verdict`);
  }
  const r = /** @type {any} */ (run.ranker) ?? {};
  const name = `baseline ${run.variant}`;
  if (r.ref !== ref) throw new BaselineError(`${name} ran ranker ref ${JSON.stringify(r.ref)}, not ${ref} (${what})`);
  if (r.sha !== sha) throw new BaselineError(`${name} ran ranker sha ${short(r.sha)}, not ${sha.slice(0, 7)} (${what})`);
  if (r.dirty !== false) throw new BaselineError(`${name} does not record a clean ranker (dirty: ${JSON.stringify(r.dirty)})`);
  if (r.runner?.dirty !== false) throw new BaselineError(`${name} does not record a clean runner (runner.dirty: ${JSON.stringify(r.runner?.dirty)})`);
  // A pin is a shipped configuration: filtered, hybrid. A run of the right ranker with other
  // query parameters is a different baseline.
  const c = /** @type {any} */ (run).config ?? {};
  if (c.filters !== true) throw new BaselineError(`${name} was not run with the queries' filters (config.filters: ${JSON.stringify(c.filters)})`);
  if ((c.mode ?? 'hybrid') !== 'hybrid') throw new BaselineError(`${name} ran mode ${JSON.stringify(c.mode)}, not hybrid`);
  if (c.strip?.length) throw new BaselineError(`${name} ran with filters stripped (config.strip: ${JSON.stringify(c.strip)})`);
  // Phase 4: a run that recorded a study map must have used the committed one
  // (runs before Phase 4 sent no study, which their rankers ignore).
  if (c.studyMap !== undefined && c.studyMap !== studyMapSha256()) {
    throw new BaselineError(`${name} used study map ${short(c.studyMap)}, not the committed eval/study-map.json (${studyMapSha256().slice(0, 12)})`);
  }
  const want = await pinnedTreeHash(repo, sha);
  if (r.treeHash !== want) throw new BaselineError(`${name} has ranker treeHash ${short(r.treeHash)}, but the files of ${ref} hash to ${short(want)}`);
}
