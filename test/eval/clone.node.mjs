// @ts-check
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEDGER_HEADER } from '../../eval/lib/ledger.mjs';

const LEDGER = 'eval/holdout-ledger.md';

/** @param {string} clone */
export function emptyCloneLedger(clone) {
  resetCloneLedger(clone);
  const steps = [
    ['add', '--', LEDGER],
    ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', 'test: empty ledger'],
    ['update-ref', 'refs/remotes/origin/main', 'HEAD'],
  ];
  for (const args of steps) {
    const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: clone, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args[0]} in the test clone failed: ${r.stderr}`);
  }
}

/** @param {string} clone */
export function resetCloneLedger(clone) {
  writeFileSync(join(clone, LEDGER), LEDGER_HEADER);
}
