// @ts-check
// The ops log (Phase 7 7C, docs/plans/phase7.md §2 7C): one JSON file per run
// of any script that touches a remote, written on every exit path, at
//
//   docs/evidence/ops/runs/<UTC yyyymmddThhmmssZ>-<script>-<4 hex>.json
//
// Unique names mean two worktrees never conflict and nothing is numbered at
// write time. docs/REFERENCE.md "Operations: run records" is the contract the
// writers follow; check:findings validates every file (validateRunRecord).
//
// A writer, in one line when it has nothing to add:
//
//   const run = startRun('d1:bookmark', { target: 'nusmods-apac', args: argv });
//   run.read('D1 Time Travel info', { estimate: 0, actual: 0 });
//   run.setBookmark(id);
//   run.finish('ok', { exitCode: 0 });
//
// `run.guardExit()` writes the record from a process 'exit' handler if the
// script exits (process.exit, an uncaught throw) before it finishes. Writes are
// synchronous so that handler can make them.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The records' directory, relative to the repo root. */
export const RUNS_REL = 'docs/evidence/ops/runs';
export const RUNS_DIR = join(ROOT, RUNS_REL);
export const RUN_SCHEMA = 'vnm-run/1';
/**
 * `ok` did what it was asked; `refused` stopped at a check before writing; `failed` broke or
 * found drift; `partial` stopped part-way and can resume (a write budget, an unconfirmed
 * mutation); `interrupted` by SIGINT or SIGTERM.
 */
export const OUTCOMES = /** @type {const} */ (['ok', 'refused', 'failed', 'partial', 'interrupted']);
/** A record's file name: its start time, the script's slug and 4 hex. */
export const RUN_FILE = /^(\d{8}T\d{6}Z)-([a-z0-9-]+)-([0-9a-f]{4})\.json$/;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

/**
 * @typedef {typeof OUTCOMES[number]} Outcome
 * @typedef {{ what: string, estimate: number | null, actual: number | null }} Amount
 * @typedef {{ sha: string | null, dirty: boolean, diffSha256: string | null }} CommitState
 * @typedef {{
 *   schema: string, time: string, finishedAt: string | null, script: string, args: string[],
 *   commit: CommitState, target: string, read: Amount[], written: Amount[],
 *   requests: Record<string, number>, versions: Record<string, string | number | null>,
 *   bookmark: string | null, details: Record<string, unknown>,
 *   outcome?: Outcome, exitCode: number | null, message: string | null,
 * }} RunData
 */

/** A file-name-safe form of a script name (`d1:bookmark` -> `d1-bookmark`). @param {string} script */
export const slug = (script) => script.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** `20261112T101530Z`. @param {Date} d */
const stamp = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '');

/** @param {Date} time @param {string} script @param {string} hex */
export const runFileName = (time, script, hex) => `${stamp(time)}-${slug(script)}-${hex}.json`;

/** Untracked new files under the runs dir don't make a tree dirty (the deploy exemption). @param {string} line a porcelain v1 line */
export const isNewRunRecord = (line) => {
  if (!line.startsWith('?? ')) return false;
  const path = line.slice(3);
  return path.startsWith(`${RUNS_REL}/`) && RUN_FILE.test(path.slice(RUNS_REL.length + 1));
};

/**
 * HEAD, whether the tree is dirty (new run records aside), and when it is, the sha256 of
 * `git diff HEAD --binary` (untracked files are dirt but are not in that diff).
 * @param {{ cwd?: string }} [o]
 * @returns {CommitState}
 */
export function gitState({ cwd = ROOT } = {}) {
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
  let sha = null;
  try { sha = git(['rev-parse', 'HEAD']).toString().trim(); } catch { return { sha: null, dirty: false, diffSha256: null }; }
  const status = git(['status', '--porcelain', '--untracked-files=all']).toString().split('\n').filter((l) => l && !isNewRunRecord(l));
  if (!status.length) return { sha, dirty: false, diffSha256: null };
  return { sha, dirty: true, diffSha256: createHash('sha256').update(git(['diff', 'HEAD', '--binary'])).digest('hex') };
}

/** 0 is ok; 130 and 143 (SIGINT, SIGTERM) are interrupted; anything else failed. @param {number} code @returns {Outcome} */
export const outcomeForExit = (code) => (code === 0 ? 'ok' : code === 130 || code === 143 ? 'interrupted' : 'failed');

/** Where records go: the given dir, else $VNM_RUNS_DIR, else the repo's. @param {string} [dir] */
const runsDirFor = (dir) => resolve(dir ?? process.env.VNM_RUNS_DIR ?? RUNS_DIR);

/** @param {string} url */
export function isLoopback(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * One run's record, written once by finish() (or the exit guard).
 */
export class RunRecord {
  /**
   * @param {string} script
   * @param {{ target?: string, args?: string[], dir?: string, cwd?: string, now?: () => Date, random?: () => string,
   *   commit?: CommitState }} [o]
   */
  constructor(script, { target = '', args = [], dir, cwd, now = () => new Date(), random = () => randomBytes(2).toString('hex'), commit } = {}) {
    if (!script || typeof script !== 'string') throw new Error('a run record needs a script name');
    this.dir = runsDirFor(dir);
    if (process.env.VITEST && this.dir === resolve(RUNS_DIR)) throw new Error('tests must not write run records into the repo (pass dir, or set VNM_RUNS_DIR)');
    this.now = now;
    this.random = random;
    this.started = now();
    /** @type {string | null} */
    this.path = null;
    /** What finish() wrote, once it has. @type {{ outcome: Outcome, exitCode: number | null, message: string | null } | null} */
    this.result = null;
    /** @type {RunData} */
    this.data = {
      schema: RUN_SCHEMA, time: this.started.toISOString(), finishedAt: null, script, args: [...args],
      commit: commit ?? gitState({ cwd }), target, read: [], written: [], requests: {}, versions: {}, bookmark: null, details: {},
      exitCode: null, message: null,
    };
  }

  /** @param {string} target */
  setTarget(target) { this.data.target = target; return this; }

  /** What was read. @param {string} what @param {{ estimate?: number | null, actual?: number | null }} [n] */
  read(what, { estimate = null, actual = null } = {}) { this.data.read.push({ what, estimate, actual }); return this; }

  /** What was written. @param {string} what @param {{ estimate?: number | null, actual?: number | null }} [n] */
  wrote(what, { estimate = null, actual = null } = {}) { this.data.written.push({ what, estimate, actual }); return this; }

  /** A live request sent, by path (no query string). @param {string} path @param {number} [n] */
  request(path, n = 1) {
    const p = path.split('?')[0] || '/';
    this.data.requests[p] = (this.data.requests[p] ?? 0) + n;
    return this;
  }

  /** A fetch that counts each request it sends by path. @param {typeof fetch} fetchImpl @returns {typeof fetch} */
  countingFetch(fetchImpl) {
    return (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      try { this.request(new URL(url).pathname); } catch { this.request(url); }
      return fetchImpl(input, init);
    };
  }

  /** A version id, tag or data version. @param {string} key @param {string | number | null} value */
  version(key, value) { this.data.versions[key] = value; return this; }

  /** @param {string | null} id */
  setBookmark(id) { this.data.bookmark = id; return this; }

  /** Anything else worth keeping (never a secret). @param {string} key @param {unknown} value */
  detail(key, value) { this.data.details[key] = value; return this; }

  get finished() { return this.path !== null; }

  /**
   * Writes the record; a second call returns the first file and changes nothing.
   * @param {Outcome} outcome
   * @param {{ exitCode?: number | null, message?: string | null }} [o]
   * @returns {string} the file written
   */
  finish(outcome, { exitCode = null, message = null } = {}) {
    if (this.path) return this.path;
    if (!OUTCOMES.includes(outcome)) throw new Error(`run record outcome "${outcome}" is not one of ${OUTCOMES.join(', ')}`);
    const record = { ...this.data, finishedAt: this.now().toISOString(), outcome, exitCode, message };
    mkdirSync(this.dir, { recursive: true });
    const text = `${JSON.stringify(record, null, 2)}\n`;
    for (let i = 0; ; i++) {
      const hex = i < 3 ? this.random() : randomBytes(2).toString('hex');
      const path = join(this.dir, runFileName(this.started, this.data.script, hex));
      try {
        writeFileSync(path, text, { flag: 'wx' });
        this.path = path;
        this.result = { outcome, exitCode, message };
        return path;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST' || i > 64) throw err;
      }
    }
  }

  /**
   * Writes the record at process exit if nothing finished it, outcome from the exit code. A
   * signal's default action exits without an 'exit' event, so with `signals` (the default) it
   * also takes SIGINT, SIGTERM and SIGHUP: the record is finished `interrupted` and the process
   * exits 130, 143 or 129 (its 'exit' handlers, a session's cleanup among them, still run). A
   * script with its own graceful signal handling (ingest) passes `signals: false`.
   * @param {Pick<NodeJS.Process, 'on' | 'off' | 'exit'>} [proc]
   * @param {{ signals?: boolean }} [o]
   * @returns {() => void} removes the handlers
   */
  guardExit(proc = process, { signals = true } = {}) {
    const onExit = (/** @type {number} */ code) => {
      if (!this.finished) this.finish(outcomeForExit(code), { exitCode: code, message: 'exited before the record was finished' });
    };
    proc.on('exit', onExit);
    /** @type {[NodeJS.Signals, () => void][]} */
    const handlers = signals ? /** @type {[NodeJS.Signals, number][]} */ ([['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]).map(([sig, code]) => [sig, () => {
      if (!this.finished) this.finish('interrupted', { exitCode: code, message: sig });
      proc.exit(code);
    }]) : [];
    for (const [sig, h] of handlers) proc.on(sig, h);
    return () => {
      proc.off('exit', onExit);
      for (const [sig, h] of handlers) proc.off(sig, h);
    };
  }
}

/**
 * Starts a run record (the commit is read now).
 * @param {string} script
 * @param {ConstructorParameters<typeof RunRecord>[1]} [o]
 */
export const startRun = (script, o) => new RunRecord(script, o);

/**
 * p5-live and p6-live: a record for a run against a live URL (none for a local server), with
 * every request the run sends by path, on success, failure and a throw alike.
 * @template {{ pass: boolean }} T
 * @template {{ url: string }} O
 * @param {string} script
 * @param {O} opts
 * @param {(opts: O & { onSend?: (path: string) => void }) => Promise<T[]>} runFn
 * @param {ConstructorParameters<typeof RunRecord>[1]} [o]
 * @returns {Promise<T[]>}
 */
export async function recordedLiveRun(script, opts, runFn, o = {}) {
  if (isLoopback(opts.url)) return runFn(opts);
  const run = startRun(script, { target: opts.url, args: process.argv.slice(2), ...o });
  const unguard = run.guardExit();
  try {
    const outcomes = await runFn({ ...opts, onSend: (path) => { run.request(path); } });
    const failed = outcomes.filter((x) => !x.pass).length;
    run.finish(failed ? 'failed' : 'ok', { exitCode: failed ? 1 : 0, message: `${outcomes.length - failed} of ${outcomes.length} checks pass` });
    return outcomes;
  } catch (err) {
    run.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    unguard();
  }
}

/** @param {unknown} v */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v */
const isCount = (v) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/**
 * The checks check:findings runs on one record.
 * @param {any} record
 * @param {{ file: string, now?: Date }} o
 * @returns {string[]}
 */
export function validateRunRecord(record, { file, now = new Date() }) {
  if (!isObject(record)) return ['not a JSON object'];
  /** @type {string[]} */
  const errors = [];
  if (record.schema !== RUN_SCHEMA) errors.push(`schema is ${JSON.stringify(record.schema)}, not ${RUN_SCHEMA}`);
  const timeOk = typeof record.time === 'string' && ISO_UTC.test(record.time) && !Number.isNaN(Date.parse(record.time));
  if (!timeOk) errors.push(`time ${JSON.stringify(record.time)} is not an ISO UTC time`);
  else if (Date.parse(record.time) > now.getTime()) errors.push(`time ${record.time} is in the future`);
  if (typeof record.script !== 'string' || !record.script) errors.push('no script');
  if (!OUTCOMES.includes(record.outcome)) errors.push(`outcome ${JSON.stringify(record.outcome)} is missing or not one of ${OUTCOMES.join(', ')}`);
  const m = RUN_FILE.exec(file);
  if (!m) errors.push('the file name is not <yyyymmddThhmmssZ>-<script>-<4 hex>.json');
  else if (timeOk && typeof record.script === 'string' && (m[1] !== stamp(new Date(record.time)) || m[2] !== slug(record.script))) {
    errors.push(`the file name does not match the record's time and script (${stamp(new Date(record.time))}-${slug(record.script)})`);
  }
  // Every field the spec says a record holds.
  const c = record.commit;
  if (!isObject(c) || !(c.sha === null || /^[0-9a-f]{40}$/.test(c.sha))) errors.push('commit.sha is missing, or not a 40-hex sha or null');
  if (isObject(c) && (typeof c.dirty !== 'boolean' || (c.dirty ? !/^[0-9a-f]{64}$/.test(c.diffSha256) : c.diffSha256 !== null))) {
    errors.push('commit.dirty must be a boolean, with diffSha256 a sha256 when dirty and null when clean');
  }
  if (typeof record.target !== 'string') errors.push('target is missing or not a string');
  if (!Array.isArray(record.args) || !record.args.every((/** @type {unknown} */ a) => typeof a === 'string')) errors.push('args must be a list of strings');
  for (const key of ['read', 'written']) {
    if (!(Array.isArray(record[key]) && record[key].every((/** @type {any} */ a) => isObject(a) && typeof a.what === 'string' && isCount(a.estimate) && isCount(a.actual)))) {
      errors.push(`${key} must be a list of { what, estimate, actual }`);
    }
  }
  if (!(isObject(record.requests) && Object.values(record.requests).every((n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0))) {
    errors.push('requests must map paths to counts');
  }
  if (!(isObject(record.versions) && Object.values(record.versions).every((v) => v === null || typeof v === 'string' || typeof v === 'number'))) {
    errors.push('versions must map names to strings, numbers or null');
  }
  if (!(record.bookmark === null || typeof record.bookmark === 'string')) errors.push('bookmark must be a string or null');
  if (!isObject(record.details)) errors.push('details must be an object');
  if (!(record.exitCode === null || Number.isInteger(record.exitCode))) errors.push('exitCode must be an integer or null');
  if (!(record.message === null || typeof record.message === 'string')) errors.push('message must be a string or null');
  const finishedOk = typeof record.finishedAt === 'string' && ISO_UTC.test(record.finishedAt) && !Number.isNaN(Date.parse(record.finishedAt));
  if (!finishedOk) errors.push(`finishedAt ${JSON.stringify(record.finishedAt)} is not an ISO UTC time`);
  else if (Date.parse(record.finishedAt) > now.getTime()) errors.push(`finishedAt ${record.finishedAt} is in the future`);
  else if (timeOk && Date.parse(record.finishedAt) < Date.parse(record.time)) errors.push('finishedAt is before time');
  return errors;
}

/**
 * Every file in the runs dir, parsed (a missing dir has none).
 * @param {string} [dir]
 * @returns {{ file: string, record: any, error: string | null }[]}
 */
export function readRunRecords(dir = RUNS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f !== '.gitkeep').sort().map((file) => {
    if (!file.endsWith('.json')) return { file, record: null, error: 'not a run record (records are .json)' };
    try {
      return { file, record: JSON.parse(readFileSync(join(dir, file), 'utf8')), error: null };
    } catch {
      return { file, record: null, error: 'not JSON' };
    }
  });
}

/**
 * check:findings' run-record check: `<file>: <problem>` for each problem.
 * @param {string} [dir]
 * @param {Date} [now]
 */
export function checkRunRecords(dir = RUNS_DIR, now = new Date()) {
  return readRunRecords(dir).flatMap(({ file, record, error }) => (error ? [`${file}: ${error}`]
    : validateRunRecord(record, { file, now }).map((e) => `${file}: ${e}`)));
}

/**
 * The newest record in `dir` (by its start time) that `match` accepts, with its file name.
 * @param {string} dir
 * @param {(record: any) => boolean} match
 * @returns {{ file: string, record: any } | null}
 */
export function newestRecord(dir, match) {
  const hits = readRunRecords(dir).filter((r) => r.error === null && match(r.record));
  hits.sort((a, b) => String(b.record.time).localeCompare(String(a.record.time)) || b.file.localeCompare(a.file));
  return hits[0] ? { file: hits[0].file, record: hits[0].record } : null;
}
