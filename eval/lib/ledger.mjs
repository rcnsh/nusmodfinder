// @ts-check
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
by \`npm run eval\` and \`npm run eval:report\` on those sets. A look past the limit is refused.

| date | set | commit | variant | baseline | verdict | ΔnDCG@10 [95% CI] | ΔP@5 [95% CI] | rule | baseline ranker |
|---|---|---|---|---|---|---|---|---|---|
`;

const KNOWN_SETS = ['holdout', 'test', 'selftest'];

export const COUNT_CELL = /^count:\s/;

const COMMITTED_REFS = ['HEAD', 'origin/main'];

/** @param {string} line */
const isSeparator = (line) => /^\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line);

/**
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
 * @returns {Promise<{ set: string, variant: string, verdict: string, rule: string }[]>}
 */
export async function readLedger(path) {
  if (!existsSync(path)) return [];
  return ledgerRows(await readFile(path, 'utf8')).map((cells) => ({ set: cells[1] ?? '', variant: cells[3] ?? '', verdict: cells[5] ?? '', rule: cells[8] ?? '' }));
}

/**
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
 * @param {string} text
 * @returns {Record<string, number>}
 */
function lookCounts(text) {
  const rows = ledgerRows(text).map((cells) => ({ set: cells[1] ?? '' }));
  return Object.fromEntries(KNOWN_SETS.map((s) => [s, countLooks(rows, s)]));
}

/**
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
  const rows = ledgerRows(text);
  const counted = rows.findIndex((cells) => cells.some((c) => COUNT_CELL.test(c)));
  if (counted >= 0) {
    throw new LedgerTamperError(`row ${counted + 1} of the ledger ${path} is an eval:count count-log row ("count: …"); counts are not looks and are logged only in their own count log`);
  }
  const local = rows.length;
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
 * @param {string} path
 * @param {string} set
 * @param {number} max
 * @param {{ repo?: string }} [options]
 */
export async function assertLookAllowed(path, set, max, options = {}) {
  await assertLedgerIntact(path, options.repo);
  const n = await looks(path, set);
  if (n >= max) {
    throw new LookLimitError(`refusing look ${n + 1} at the ${set} set: the ledger (${path}) already records ${n} of the allowed ${max}`);
  }
  return n;
}

/** @typedef {{ date: string, set: string, commit: string, variant: string, baseline: string, verdict: string, ndcg: string, p5: string, rule?: string, baselineRanker?: string }} LedgerRow */

/** @param {LedgerRow} row */
export function formatRow(row) {
  const clean = (/** @type {string} */ s) => s.replace(/[|\n]/g, ' ');
  return `| ${[row.date, row.set, row.commit, row.variant, row.baseline, row.verdict, row.ndcg, row.p5, row.rule ?? '—', row.baselineRanker ?? '—'].map(clean).join(' | ')} |`;
}

/**
 * @param {string} path
 * @param {Omit<LedgerRow, 'verdict' | 'ndcg' | 'p5'> & Partial<LedgerRow>} row
 * @param {string} [line]
 */
export async function appendLook(path, row, line) {
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, HEADER);
  }
  appendFileSync(path, `${line ?? formatRow(/** @type {LedgerRow} */ (row))}\n`);
}

export const LEDGER_HEADER = HEADER;

export const LOCK_STALE_MS = 30 * 60 * 1000;
const BREAK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 120_000;

/** @typedef {{ assertHeld: () => void }} LockHandle */

/** @param {string} file @returns {string | null} */
function readToken(file) {
  try { return readFileSync(file, 'utf8').trim(); } catch { return null; }
}

/**
 * @param {string} lock
 * @returns {boolean}
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
    } catch {}
    return false;
  }
  try {
    let st;
    try { st = statSync(lock); } catch { return true; }
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
 * @template T
 * @param {string} path
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
    try { held = statSync(lock); } catch { continue; }
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
 * @param {string} path
 * @param {number} max
 * @param {Omit<LedgerRow, 'verdict' | 'ndcg' | 'p5'>} row
 * @param {{ repo?: string, waitMs?: number }} [options]
 * @returns {Promise<string>}
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
 * @param {string} path
 * @param {string} reserved
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
