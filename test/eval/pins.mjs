// @ts-check
// The two baseline pins as ADR 0003 states them, for tests that build a
// genuine baseline run. They are read from the ADR, not imported from the code
// under test: the SC5 pin is spelled out (it never moves), and the shipped pin
// is the last "- shipped pin:" line of the ADR's "Shipped-ranker pin" section,
// so a ship that moves the pin needs no test edits.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO } from '../../eval/lib/sets.mjs';
import { HASHED, treeHash } from '../../eval/lib/workspace.mjs';

/** @typedef {{ ref: string, sha: string }} Pin */

/** The SC5 / test-set pin. @type {Pin} */
export const SC5_PIN = { ref: 'eval-v0', sha: '7ac984174ded88cb2b6497d9835b456981acdd99' };

/** The shipped-ranker pin: the last line of ADR 0003's "Shipped-ranker pin" section. @type {Pin} */
export const SHIPPED_PIN = (() => {
  const adr = readFileSync(join(REPO, 'docs', 'decisions', '0003-eval-holdout-and-gate.md'), 'utf8');
  const section = adr.split(/^## /m).find((s) => s.startsWith('Shipped-ranker pin')) ?? '';
  const last = [...section.matchAll(/^- shipped pin: `([^`]+)` ([0-9a-f]{40})\b/gm)].at(-1);
  if (!last) throw new Error('ADR 0003 lists no shipped pin');
  return { ref: last[1], sha: last[2] };
})();

/** How a verdict prints a pin: "eval-v0 7ac9841" for a tag, the short sha for a plain sha. @param {Pin} pin */
export const labelOf = (pin) => (pin.ref === pin.sha ? pin.sha.slice(0, 7) : `${pin.ref} ${pin.sha.slice(0, 7)}`);

/** labelOf(pin), escaped for a RegExp. @param {Pin} pin */
export const labelRe = (pin) => labelOf(pin).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * treeHash of `git archive <sha>` over the hashed ranker paths, computed here
 * rather than with the code under test's pinnedTreeHash.
 * @param {string} sha
 */
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
 * The ranker block of a genuine, clean `--ref <pin.ref>` run.
 * @param {Pin} pin @param {string} tree archiveTree(pin.sha)
 */
export const rankerAt = (pin, tree) => ({ ref: pin.ref, sha: pin.sha, dirty: false, treeHash: tree, runner: { sha: pin.sha, dirty: false } });
