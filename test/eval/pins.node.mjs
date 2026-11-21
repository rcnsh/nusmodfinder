// @ts-check
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../eval/lib/workspace.mjs';

/** @typedef {{ ref: string, sha: string }} Pin */

/** @type {Pin} */
export const TEST_SET_PIN = { ref: 'eval-v0', sha: '5c5cce441bd33c8f66bb2857e4d7f5584cbc20ed' };

/** @type {Pin} */
export const SHIPPED_PIN = (() => {
  const adr = readFileSync(join(REPO, 'docs', 'decisions', '0003-eval-holdout-and-gate.md'), 'utf8');
  const section = adr.split(/^## /m).find((/** @type {string} */ s) => s.startsWith('Shipped-ranker pin')) ?? '';
  const last = [...section.matchAll(/^- shipped pin: `([^`]+)` ([0-9a-f]{40})\b/gm)].at(-1);
  if (!last) throw new Error('ADR 0003 lists no shipped pin');
  return { ref: last[1], sha: last[2] };
})();

/** @param {Pin} pin */
export const labelOf = (pin) => (pin.ref === pin.sha ? pin.sha.slice(0, 7) : `${pin.ref} ${pin.sha.slice(0, 7)}`);

/** @param {Pin} pin */
export const labelRe = (pin) => labelOf(pin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} sha */
export async function archiveTree(sha) {
  const dir = await mkdtemp(join(tmpdir(), 'vnm-pin-tree-'));
  try {
    const present = HASHED.filter((p) => spawnSync('git', ['cat-file', '-e', `${sha}:${p}`], { cwd: REPO }).status === 0);
    const tar = spawnSync('git', ['archive', '--format=tar', sha, '--', ...present], { cwd: REPO, maxBuffer: 1 << 30 });
    if (tar.status !== 0) throw new Error(`git archive ${sha.slice(0, 7)} failed`);
    if (spawnSync('tar', ['-x', '-C', dir], { input: tar.stdout }).status !== 0) throw new Error(`extracting ${sha.slice(0, 7)} failed`);
    return await treeHash(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {Pin} pin
 * @param {string} tree
 */
export const rankerAt = (pin, tree) => ({ ref: pin.ref, sha: pin.sha, dirty: false, treeHash: tree, runner: { sha: pin.sha, dirty: false } });
