// @ts-check
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaselineError } from './errors.mjs';
import { REPO, studyMapSha256 } from './sets.mjs';
import { HASHED, treeHash } from './workspace.mjs';

/** @typedef {Readonly<{ ref: string, sha: string }>} Pin */

/** @type {Pin} */
export const PINNED_BASELINE = Object.freeze({ ref: 'eval-v0', sha: '5c5cce441bd33c8f66bb2857e4d7f5584cbc20ed' });

/** @type {Pin} */
export const SHIPPED_BASELINE = Object.freeze({ ref: 'b75ac19016a2073e77d37c2c44485c9a5d8c99a2', sha: 'b75ac19016a2073e77d37c2c44485c9a5d8c99a2' });

/** @param {Pin} pin */
export const pinLabel = (pin) => (pin.ref === pin.sha ? pin.sha.slice(0, 7) : `${pin.ref} ${pin.sha.slice(0, 7)}`);

/**
 * @param {string} gate
 * @returns {Pin}
 */
export const baselinePinFor = (gate) => (gate === 'test' ? PINNED_BASELINE : SHIPPED_BASELINE);

/** @type {Map<string, Promise<string>>} */
const trees = new Map();

/**
 * @param {string} [repo]
 * @param {string} [sha]
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
 * @param {import('./metrics.mjs').RunFile} run
 * @param {Pin} pin
 * @param {{ repo?: string }} [options]
 */
export async function assertBaselineAt(run, pin, options = {}) {
  const repo = options.repo ?? REPO;
  const { ref, sha } = pin;
  const what = pin === PINNED_BASELINE ? 'the test-set baseline' : pin === SHIPPED_BASELINE ? 'the shipped-ranker pin' : 'the pin';
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
  const c = /** @type {any} */ (run).config ?? {};
  if (c.filters !== true) throw new BaselineError(`${name} was not run with the queries' filters (config.filters: ${JSON.stringify(c.filters)})`);
  if ((c.mode ?? 'hybrid') !== 'hybrid') throw new BaselineError(`${name} ran mode ${JSON.stringify(c.mode)}, not hybrid`);
  if (c.strip?.length) throw new BaselineError(`${name} ran with filters stripped (config.strip: ${JSON.stringify(c.strip)})`);
  if (c.studyMap !== undefined && c.studyMap !== studyMapSha256()) {
    throw new BaselineError(`${name} used study map ${short(c.studyMap)}, not the committed eval/study-map.json (${studyMapSha256().slice(0, 12)})`);
  }
  const want = await pinnedTreeHash(repo, sha);
  if (r.treeHash !== want) throw new BaselineError(`${name} has ranker treeHash ${short(r.treeHash)}, but the files of ${ref} hash to ${short(want)}`);
}
