// @ts-check
// eval/holdout-ledger.md: one row per look at the holdout (or sealed test)
// set, so the number of looks is visible in git history. A look is any run
// that prints a verdict. Append-only; the CLI refuses a look past the limit.
//
// Tamper resistance (honour system, but not trivially editable):
// - every table row except the header and separator lines counts, whatever
//   its spacing or contents; a row whose set cell is not a known set counts
//   against every set;
// - a look is refused if the ledger has fewer rows than git's copy at HEAD or
//   origin/main, or if the file is missing while git has it.
//
// Concurrency: check-then-append runs under an exclusive lock file
// (`<ledger>.lock`, created with O_EXCL), so parallel looks cannot all pass
// the limit. `run` reserves its look (a `reserved` row, which counts) before
// retrieval starts and finalises that row with the verdict afterwards.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, rmSync, statSync, writeSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LedgerLockError, LedgerTamperError, LookLimitError } from './errors.mjs';
import { REPO } from './sets.mjs';

const HEADER = `# Holdout ledger

Append-only. One row per look at an encrypted set (\`holdout\` max 12, \`test\` max 1), written
by \`npm run eval -- --holdout\`. Phase 3 tuning stops at 12 holdout looks.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] |
|---|---|---|---|---|---|---|---|
`;

/** Set names a row can belong to; any other set cell counts against all of them. */
const KNOWN_SETS = ['holdout', 'test', 'selftest'];

/** Refs whose committed ledger the local one may not fall behind. */
const COMMITTED_REFS = ['HEAD', 'origin/main'];

/** @param {string} line trimmed */
const isSeparator = (line) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line);

/**
 * Every table row of a ledger except the header (the first table line, when
 * a separator follows it) and separator lines, as trimmed cells.
 * @param {string} text
 * @returns {string[][]}
 */
export function ledgerRows(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('|'));
  /** @type {string[][]} */
  const rows = [];
  lines.forEach((line, i) => {
    if (isSeparator(line)) return;
    if (i === 0 && lines.length > 1 && isSeparator(lines[1])) return;
    rows.push(line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  });
  return rows;
}

/**
 * @param {string} path
 * @returns {Promise<{ set: string, variant: string, verdict: string }[]>}
 */
export async function readLedger(path) {
  if (!existsSync(path)) return [];
  return ledgerRows(await readFile(path, 'utf8')).map((cells) => ({ set: cells[1] ?? '', variant: cells[3] ?? '', verdict: cells[5] ?? '' }));
}

/**
 * Looks recorded against `set`: its own rows plus rows of no known set.
 * @param {string} path
 * @param {string} set
 */
export async function looks(path, set) {
  return (await readLedger(path)).filter((r) => r.set === set || !KNOWN_SETS.includes(r.set)).length;
}

/**
 * Row counts of the ledger as committed at HEAD and origin/main, for those
 * refs that have it. Empty when the path is outside `repo` or untracked.
 * @param {string} path
 * @param {string} [repo]
 * @returns {{ ref: string, rel: string, rows: number }[]}
 */
export function committedLedgers(path, repo = REPO) {
  const rel = relative(repo, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];
  const spec = rel.split(sep).join('/');
  /** @type {{ ref: string, rel: string, rows: number }[]} */
  const out = [];
  for (const ref of COMMITTED_REFS) {
    const r = spawnSync('git', ['show', `${ref}:${spec}`], { cwd: repo, encoding: 'utf8' });
    if (r.status === 0) out.push({ ref, rel: spec, rows: ledgerRows(r.stdout).length });
  }
  return out;
}

/**
 * Throws if the ledger is missing while git has it, or has fewer rows than
 * git's copy at HEAD or origin/main.
 * @param {string} path
 * @param {string} [repo]
 */
export async function assertLedgerIntact(path, repo = REPO) {
  const committed = committedLedgers(path, repo);
  if (!existsSync(path)) {
    const c = committed[0];
    if (c) throw new LedgerTamperError(`the ledger ${path} is missing but ${c.ref} has it (${c.rows} look rows); restore it with \`git checkout ${c.ref} -- ${c.rel}\``);
    return;
  }
  const local = ledgerRows(await readFile(path, 'utf8')).length;
  for (const c of committed) {
    if (local < c.rows) {
      throw new LedgerTamperError(`the ledger ${path} has ${local} look rows but ${c.ref}:${c.rel} has ${c.rows}; rows may only be appended`);
    }
  }
}

/**
 * Throws if another look would exceed `max`, or if the ledger was cut back.
 * @param {string} path
 * @param {string} set
 * @param {number} max
 * @param {{ repo?: string }} [options] the git repository the ledger is checked against
 */
export async function assertLookAllowed(path, set, max, options = {}) {
  await assertLedgerIntact(path, options.repo);
  const n = await looks(path, set);
  if (n >= max) {
    throw new LookLimitError(`refusing look ${n + 1} at the ${set} set: the ledger (${path}) already records ${n} of the allowed ${max}`);
  }
  return n;
}

/**
 * @typedef {{ date: string, set: string, commit: string, variant: string, baseline: string, verdict: string, ndcg: string, p5: string }} LedgerRow
 */

/** @param {LedgerRow} row */
export function formatRow(row) {
  const clean = (/** @type {string} */ s) => s.replace(/[|\n]/g, ' ');
  return `| ${[row.date, row.set, row.commit, row.variant, row.baseline, row.verdict, row.ndcg, row.p5].map(clean).join(' | ')} |`;
}

/**
 * Appends a row. Callers that enforce the limit hold the lock (eval:report,
 * reserveLook); this alone does not check anything.
 * @param {string} path
 * @param {Omit<LedgerRow, 'verdict' | 'ndcg' | 'p5'> & Partial<LedgerRow>} row
 * @param {string} [line] a preformatted line
 */
export async function appendLook(path, row, line) {
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, HEADER);
  }
  await appendFile(path, `${line ?? formatRow(/** @type {LedgerRow} */ (row))}\n`);
}

export const LEDGER_HEADER = HEADER;

/** A lock older than this is abandoned (its eval crashed) and is removed. */
export const LOCK_STALE_MS = 30 * 60 * 1000;
/** How long to wait for another eval to release the lock. */
const LOCK_WAIT_MS = 120_000;

/**
 * Runs `fn` holding the ledger's exclusive lock. Waits up to `waitMs` for
 * another holder; removes a lock older than 30 minutes, saying so.
 * @template T
 * @param {string} path the ledger
 * @param {() => Promise<T>} fn
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLedgerLock(path, fn, options = {}) {
  const lock = `${path}.lock`;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const start = Date.now();
  /** @type {number} */
  let fd;
  for (;;) {
    try {
      fd = openSync(lock, 'wx');
      break;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code;
      if (code === 'ENOENT') { await mkdir(dirname(lock), { recursive: true }); continue; }
      if (code !== 'EEXIST') throw err;
    }
    let held;
    try { held = statSync(lock); } catch { continue; } // released in the meantime
    const age = Date.now() - held.mtimeMs;
    if (age > LOCK_STALE_MS) {
      // Re-check it is the same lock file before removing it.
      let again;
      try { again = statSync(lock); } catch { continue; }
      if (again.ino === held.ino && again.mtimeMs === held.mtimeMs) {
        console.error(`eval: removing a stale ledger lock ${lock} (${Math.floor(age / 60_000)} minutes old; a lock older than 30 minutes is treated as abandoned)`);
        rmSync(lock, { force: true });
      }
      continue;
    }
    if (Date.now() - start >= waitMs) {
      throw new LedgerLockError(`another eval holds the ledger lock ${lock} (taken ${Math.round(age / 1000)} s ago); try again when it finishes. A lock older than 30 minutes is treated as stale and removed.`);
    }
    await sleep(25 + Math.floor(Math.random() * 50));
  }
  try {
    try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * Reserves a look before retrieval starts: checks the limit and appends a
 * `reserved <token>` row, atomically. The row counts as a look from now on.
 * @param {string} path
 * @param {number} max
 * @param {Omit<LedgerRow, 'verdict' | 'ndcg' | 'p5'>} row
 * @param {{ repo?: string, waitMs?: number }} [options]
 * @returns {Promise<string>} the reserved line, for finaliseLook
 */
export function reserveLook(path, max, row, options = {}) {
  return withLedgerLock(path, async () => {
    await assertLookAllowed(path, row.set, max, options);
    const line = formatRow({ ...row, verdict: `reserved ${randomBytes(4).toString('hex')}`, ndcg: '—', p5: '—' });
    await appendLook(path, row, line);
    return line;
  }, options);
}

/**
 * Replaces a reserved row with the final one (verdict, or `aborted` /
 * `unjudged`). If the reserved row has gone, the final row is appended, so the
 * look is still counted.
 * @param {string} path
 * @param {string} reserved the line reserveLook returned
 * @param {LedgerRow} row
 * @param {{ waitMs?: number }} [options]
 */
export function finaliseLook(path, reserved, row, options = {}) {
  return withLedgerLock(path, async () => {
    if (!existsSync(path)) return appendLook(path, row);
    const lines = (await readFile(path, 'utf8')).split('\n');
    const i = lines.findIndex((l) => l.trim() === reserved);
    if (i < 0) return appendLook(path, row);
    lines[i] = formatRow(row);
    await writeFile(path, lines.join('\n'));
  }, options);
}
