// @ts-check
// Temporary clones for tests that take looks: the clone's holdout ledger starts
// empty, committed at the clone's HEAD and origin/main, so its look limits and
// its tamper check (eval/lib/ledger.mjs, against those refs) never depend on how
// many looks this checkout's real ledger holds.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_HEADER } from '../../eval/lib/ledger.mjs';

const LEDGER = 'eval/holdout-ledger.md';

/** Writes and commits an empty ledger in `clone`, and points its origin/main there. @param {string} clone */
export function emptyCloneLedger(clone) {
  resetCloneLedger(clone);
  const steps = [
    ['add', '--', LEDGER],
    ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'test: empty ledger'],
    ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
  ];
  for (const args of steps) {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: clone, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]} in the test clone failed: ${r.stderr}`);
  }
}

/** Puts the clone's ledger back to the empty one emptyCloneLedger committed. @param {string} clone */
export function resetCloneLedger(clone) {
  writeFileSync(join(clone, LEDGER), LEDGER_HEADER);
}
