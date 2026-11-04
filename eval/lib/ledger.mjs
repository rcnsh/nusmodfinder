// @ts-check
// eval/holdout-ledger.md: one row per look at the holdout (or sealed test)
// set, so the number of looks is visible in git history. A look is any run
// that prints a verdict. Append-only; the CLI refuses a look past the limit.
// Each row records the rule the verdict applied (`general`, `targeted:
// <shapes>`, `cutoff`, `sc5`) and the baseline's ranker sha.
//
// Tamper resistance (honour system, but not trivially editable):
// - every table row except the header and separator lines counts, whatever
//   its spacing or contents; a row whose set cell is not a known set counts
//   against every set;
// - a look is refused if, for any known set, the ledger records fewer looks
//   than git's copy at HEAD or origin/main (so moving a row to another set
//   is caught), if it has fewer rows in total, or if the file is missing
//   while git has it.
//
// Concurrency: check-then-append runs under an exclusive lock file
// (`<ledger>.lock`, created with O_EXCL and holding a random token), so
// parallel looks cannot all pass the limit. `run` reserves its look (a
// `reserved` row, which counts) before retrieval starts and finalises that
// row with the verdict afterwards. A holder writes, and releases the lock,
// only while the lock still holds its token; a lock older than 30 minutes is
// broken under a second lock (`<ledger>.lock.break`), so two processes
// cannot both break it and one remove the other's fresh lock.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { LedgerLockError, LedgerTamperError, LookLimitError } from './errors.mjs';
import { REPO } from './sets.mjs';

const HEADER = `# Holdout ledger

Append-only. One row per look at an encrypted set (\`holdout\` max 12, \`test\` max 1), written
by \`npm run eval -- --holdout\`. Phase 3 tuning stops at 12 holdout looks.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |
|---|---|---|---|---|---|---|---|---|---|
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
  return countLooks(await readLedger(path), set);
}

/**
 * @param {{ set: string }[]} rows
 * @param {string} set
 */
const countLooks = (rows, set) => rows.filter((r) => r.set === set || !KNOWN_SETS.includes(r.set)).length;

/**
 * Looks per known set, by the same rule as `looks`.
 * @param {string} text a ledger's contents
 * @returns {Record<string, number>}
 */
function lookCounts(text) {
  const rows = ledgerRows(text).map((cells) => ({ set: cells[1] ?? '' }));
  return Object.fromEntries(KNOWN_SETS.map((s) => [s, countLooks(rows, s)]));
}

/**
 * Row and per-set look counts of the ledger as committed at HEAD and
 * origin/main, for those refs that have it. Empty when the path is outside
 * `repo` or untracked.
 * @param {string} path
 * @param {string} [repo]
 * @returns {{ ref: string, rel: string, rows: number, looks: Record<string, number> }[]}
 */
export function committedLedgers(path, repo = REPO) {
  const rel = relative(repo, path);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];
  const spec = rel.split(sep).join('/');
  /** @type {{ ref: string, rel: string, rows: number, looks: Record<string, number> }[]} */
  const out = [];
  for (const ref of COMMITTED_REFS) {
    const r = spawnSync('git', ['show', `${ref}:${spec}`], { cwd: repo, encoding: 'utf8' });
    if (r.status === 0) out.push({ ref, rel: spec, rows: ledgerRows(r.stdout).length, looks: lookCounts(r.stdout) });
  }
  return out;
}

/**
 * Throws if the ledger is missing while git has it, or has fewer rows, or
 * fewer looks for any known set, than git's copy at HEAD or origin/main.
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
  const text = await readFile(path, 'utf8');
  const local = ledgerRows(text).length;
  const localLooks = lookCounts(text);
  for (const c of committed) {
    if (local < c.rows) {
      throw new LedgerTamperError(`the ledger ${path} has ${local} look rows but ${c.ref}:${c.rel} has ${c.rows}; rows may only be appended`);
    }
    for (const set of KNOWN_SETS) {
      if (localLooks[set] < c.looks[set]) {
        throw new LedgerTamperError(`the ledger ${path} records ${localLooks[set]} ${set} looks but ${c.ref}:${c.rel} records ${c.looks[set]}; rows may only be appended, not edited`);
      }
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
 * `rule` is gate.mjs `ruleOf`; `baselineRanker` the baseline run's ranker sha (7 characters).
 * @typedef {{ date: string, set: string, commit: string, variant: string, baseline: string, verdict: string, ndcg: string, p5: string, rule?: string, baselineRanker?: string }} LedgerRow
 */

/** @param {LedgerRow} row */
export function formatRow(row) {
  const clean = (/** @type {string} */ s) => s.replace(/[|\n]/g, ' ');
  return `| ${[row.date, row.set, row.commit, row.variant, row.baseline, row.verdict, row.ndcg, row.p5, row.rule ?? '—', row.baselineRanker ?? '—'].map(clean).join(' | ')} |`;
}

/**
 * Appends a row. Callers that enforce the limit hold the lock (eval:report,
 * reserveLook) and call `lock.assertHeld()` immediately before; the write is
 * synchronous so nothing runs between that check and the append. This alone
 * does not check anything.
 * @param {string} path
 * @param {Omit<LedgerRow, 'verdict' | 'ndcg' | 'p5'> & Partial<LedgerRow>} row
 * @param {string} [line] a preformatted line
 */
export async function appendLook(path, row, line) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, HEADER);
  }
  appendFileSync(path, `${line ?? formatRow(/** @type {LedgerRow} */ (row))}\n`);
}

export const LEDGER_HEADER = HEADER;

/** A lock older than this is abandoned (its eval crashed) and is removed. */
export const LOCK_STALE_MS = 30 * 60 * 1000;
/** A break lock older than this is abandoned (its holder crashed mid-break). */
const BREAK_STALE_MS = 60_000;
/** How long to wait for another eval to release the lock. */
const LOCK_WAIT_MS = 120_000;

/** @typedef {{ assertHeld: () => void }} LockHandle */

/** @param {string} file @returns {string | null} */
function readToken(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/**
 * Removes `lock` if it is older than LOCK_STALE_MS, holding `<lock>.break`
 * while it re-checks and removes, so two processes that both saw the same
 * stale lock cannot have one remove the lock the other has just taken.
 * @param {string} lock
 * @returns {boolean} false if another process is breaking it (wait and retry)
 */
function breakStaleLock(lock) {
  const breaker = `${lock}.break`;
  let fd;
  try {
    fd = openSync(breaker, 'wx');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    try {
      if (Date.now() - statSync(breaker).mtimeMs > BREAK_STALE_MS) rmSync(breaker, { force: true });
    } catch { /* released in the meantime */ }
    return false;
  }
  try {
    let st;
    try { st = statSync(lock); } catch { return true; } // already gone
    const age = Date.now() - st.mtimeMs;
    if (age > LOCK_STALE_MS) {
      console.error(`eval: removing a stale ledger lock ${lock} (${Math.floor(age / 60_000)} minutes old; a lock older than 30 minutes is treated as abandoned)`);
      rmSync(lock, { force: true });
    }
    return true;
  } finally {
    closeSync(fd);
    rmSync(breaker, { force: true });
  }
}

/**
 * Runs `fn` holding the ledger's exclusive lock. Waits up to `waitMs` for
 * another holder; breaks a lock older than 30 minutes, saying so. `fn` gets a
 * handle whose `assertHeld()` throws LedgerLockError if the lock no longer
 * holds this process's token (it stalled past 30 minutes and another eval
 * broke the lock); call it right before writing. On exit the lock is removed
 * only if it still holds the token.
 * @template T
 * @param {string} path the ledger
 * @param {(lock: LockHandle) => Promise<T>} fn
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLedgerLock(path, fn, options = {}) {
  const lock = `${path}.lock`;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`;
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
    if (age > LOCK_STALE_MS && breakStaleLock(lock)) continue;
    if (Date.now() - start >= waitMs) {
      throw new LedgerLockError(`another eval holds the ledger lock ${lock} (taken ${Math.round(age / 1000)} s ago); try again when it finishes. A lock older than 30 minutes is treated as stale and removed.`);
    }
    await sleep(25 + Math.floor(Math.random() * 50));
  }
  /** @type {LockHandle} */
  const handle = {
    assertHeld() {
      if (readToken(lock) !== token) {
        throw new LedgerLockError(`this eval lost the ledger lock ${lock}: it was held past 30 minutes and another eval broke it. Nothing was written; run again.`);
      }
    },
  };
  try {
    try { writeSync(fd, `${token}\n`); } finally { closeSync(fd); }
    return await fn(handle);
  } finally {
    if (readToken(lock) === token) rmSync(lock, { force: true });
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
  return withLedgerLock(path, async (lock) => {
    await assertLookAllowed(path, row.set, max, options);
    const line = formatRow({ ...row, verdict: `reserved ${randomBytes(4).toString('hex')}`, ndcg: '—', p5: '—' });
    lock.assertHeld();
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
  return withLedgerLock(path, async (lock) => {
    const lines = existsSync(path) ? (await readFile(path, 'utf8')).split('\n') : [];
    const i = lines.findIndex((l) => l.trim() === reserved);
    lock.assertHeld();
    if (i < 0) return appendLook(path, row);
    lines[i] = formatRow(row);
    writeFileSync(path, lines.join('\n'));
  }, options);
}
