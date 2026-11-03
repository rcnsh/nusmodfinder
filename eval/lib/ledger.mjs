// @ts-check
// eval/holdout-ledger.md: one row per look at the holdout (or sealed test)
// set, so the number of looks is visible in git history. A look is any run
// that prints a verdict. Append-only; the CLI refuses a look past the limit.
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { LookLimitError } from './errors.mjs';

const HEADER = `# Holdout ledger

Append-only. One row per look at an encrypted set (\`holdout\` max 12, \`test\` max 1), written
by \`npm run eval -- --holdout\`. Phase 3 tuning stops at 12 holdout looks.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] |
|---|---|---|---|---|---|---|---|
`;

/**
 * @param {string} path
 * @returns {Promise<{ set: string, variant: string, verdict: string }[]>}
 */
export async function readLedger(path) {
  if (!existsSync(path)) return [];
  const rows = (await readFile(path, 'utf8')).split('\n').filter((l) => /^\| \d{4}-\d\d-\d\d/.test(l));
  return rows.map((l) => {
    const cells = l.split('|').slice(1, -1).map((c) => c.trim());
    return { set: cells[1], variant: cells[3], verdict: cells[5] };
  });
}

/**
 * @param {string} path
 * @param {string} set
 */
export async function looks(path, set) {
  return (await readLedger(path)).filter((r) => r.set === set).length;
}

/**
 * Throws if another look would exceed `max`.
 * @param {string} path
 * @param {string} set
 * @param {number} max
 */
export async function assertLookAllowed(path, set, max) {
  const n = await looks(path, set);
  if (n >= max) {
    throw new LookLimitError(`refusing look ${n + 1} at the ${set} set: the ledger (${path}) already records ${n} of the allowed ${max}`);
  }
  return n;
}

/**
 * @param {string} path
 * @param {{ date: string, set: string, commit: string, variant: string, baseline: string, verdict: string, ndcg: string, p5: string }} row
 */
export async function appendLook(path, row) {
  if (!existsSync(path)) await writeFile(path, HEADER);
  const clean = (/** @type {string} */ s) => s.replace(/[|\n]/g, ' ');
  await appendFile(path, `| ${[row.date, row.set, row.commit, row.variant, row.baseline, row.verdict, row.ndcg, row.p5].map(clean).join(' | ')} |\n`);
}

export const LEDGER_HEADER = HEADER;
