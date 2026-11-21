// @ts-check
import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULTS, runIngest } from './ingest-core.mjs';
import { workerUrl } from './remote-session.mjs';
import { newestRecord, startRun } from './run-record.mjs';
import {
  EMBEDDING_MODEL, catalogueOnlyRecords, facetsPayload, loadNgCourses, offeredModules,
} from './lib.mjs';
import { CORPUS_MANIFEST_PATH, PROD_DIR, loadCurrentCorpus } from './corpus-manifest.mjs';

export const DATA_VERSION_PATH = fileURLToPath(new URL('../src/data-version.json', import.meta.url));
export const STATE_PATH = fileURLToPath(new URL('../.data/ingest-state.json', import.meta.url));
export const D1_ONLY_DELETES = fileURLToPath(new URL('../.data/d1-only-deletes.json', import.meta.url));

/**
 * @param {string} path
 * @param {string} base
 * @returns {import('./ingest-core.mjs').PendingMutationStore}
 */
export function fileStateStore(path, base) {
  /** @returns {Promise<Record<string, { pendingMutationId: string, sentAt?: number | null, earlier?: string[] }>>} */
  const load = async () => {
    const text = await readFile(path, 'utf8').catch((err) => { if (err.code === 'ENOENT') return '{}'; throw err; });
    return JSON.parse(text);
  };
  return {
    read: async () => {
      const entry = (await load())[base];
      return entry?.pendingMutationId
        ? { id: entry.pendingMutationId, sentAt: entry.sentAt ?? null, earlier: Array.isArray(entry.earlier) ? entry.earlier : [] }
        : null;
    },
    write: async (p) => {
      const all = await load();
      if (p) all[base] = { pendingMutationId: p.id, sentAt: p.sentAt, earlier: p.earlier ?? [] };
      else delete all[base];
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`);
        await rename(tmp, path);
      } finally {
        await rm(tmp, { force: true });
      }
    },
  };
}

/**
 * @param {string} statePath
 * @param {string} base
 * @returns {Promise<RunLock | { refused: string }>}
 */
export async function acquireRunLock(statePath, base) {
  const lock = `${statePath}.lock`;
  const nonce = randomUUID();
  await mkdir(dirname(lock), { recursive: true });
  try {
    const fh = await open(lock, 'wx');
    try {
      await fh.writeFile(`${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString(), url: base })}\n`);
    } finally {
      await fh.close();
    }
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'EEXIST') throw err;
    /** @type {{ pid?: number, startedAt?: string, url?: string }} */
    let holder = {};
    try { holder = JSON.parse(await readFile(lock, 'utf8')); } catch {}
    const pid = Number.isInteger(holder.pid) ? /** @type {number} */ (holder.pid) : null;
    let alive = null;
    if (pid !== null) {
      try { process.kill(pid, 0); alive = true; } catch (e) { alive = /** @type {NodeJS.ErrnoException} */ (e).code === 'EPERM'; }
    }
    const who = pid === null ? 'an unknown process (the lock file is unreadable)'
      : `pid ${pid}${holder.startedAt ? `, started ${holder.startedAt}` : ''}${holder.url ? `, --url ${holder.url}` : ''}`;
    const state = alive === true ? `pid ${pid} is running, though pids are reused: check it is an ingest` : alive === false ? `pid ${pid} is not running on this machine, so the lock looks stale` : 'its owner is unknown';
    return { refused: `Another ingest holds ${lock} (${who}). Two runs at once would race on the state file and Vectorize. `
      + `If no ingest is running (${state}: a run that crashed or was killed leaves it behind), delete ${lock} and rerun. Nothing was sent.` };
  }
  /** @param {string} text */
  const ours = (text) => { try { return JSON.parse(text).nonce === nonce; } catch { return false; } };
  return {
    release: async () => {
      const text = await readFile(lock, 'utf8').catch(() => null);
      if (text !== null && ours(text)) await unlink(lock).catch(() => {});
    },
    releaseSync: () => {
      try { if (ours(readFileSync(lock, 'utf8'))) unlinkSync(lock); } catch {}
    },
  };
}

/** @typedef {{ release: () => Promise<void>, releaseSync: () => void }} RunLock */

/**
 * @param {RunLock} lock
 * @param {AbortController} controller
 * @param {Pick<NodeJS.Process, 'on' | 'off' | 'exit'>} [proc]
 * @param {(line: string) => void} [log]
 * @returns {{ off: () => void, exitCode: () => number | null }}
 */
export function handleSignals(lock, controller, proc = process, log = console.error) {
  /** @type {number | null} */
  let code = null;
  /** @type {[NodeJS.Signals, number][]} */
  const signals = [['SIGINT', 130], ['SIGTERM', 143]];
  const handlers = signals.map(([signal, c]) => {
    const h = () => {
      if (code === null) {
        code = c;
        controller.abort();
        log(`${signal}: stopping after the requests in flight, recording their mutation ids. Signal again to stop at once `
          + '(a mutation in flight may then go unrecorded; run npm run verify after the rerun).');
        return;
      }
      lock.releaseSync();
      proc.exit(code);
    };
    proc.on(signal, h);
    return /** @type {const} */ ([signal, h]);
  });
  return { off: () => { for (const [signal, h] of handlers) proc.off(signal, h); }, exitCode: () => code };
}

/** @param {string} text */
export function parseDuration(text) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(text.trim());
  if (!m) throw new Error(`not a duration: "${text}" (use e.g. 90s, 30m, 24h, 2d)`);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[/** @type {'s' | 'm' | 'h' | 'd'} */ (m[2] ?? 'h')];
  return Number(m[1]) * unit;
}

/** @param {string} name @param {string} text */
function positiveInt(name, text) {
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer, got "${text}"`);
  return n;
}

/**
 * @param {string[]} argv
 * @param {Record<string, string | undefined>} [envVars]
 */
export function parseIngestArgs(argv, envVars = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' }, force: { type: 'boolean' }, from: { type: 'string' },
      'write-budget': { type: 'string' }, 'allow-mass-delete': { type: 'boolean' },
      'allow-year-change': { type: 'boolean' }, batch: { type: 'string' }, concurrency: { type: 'string' },
      'wait-timeout': { type: 'string' }, 'd1-only': { type: 'boolean' },
    },
    strict: true,
  });
  const batchSize = values.batch ? positiveInt('batch', values.batch) : DEFAULTS.batchSize;
  if (batchSize > 100) throw new Error('--batch must be at most 100 (the /admin/ingest limit)');
  return {
    worker: workerUrl(values.url, envVars),
    /** @type {import('./ingest-core.mjs').IngestOptions} */
    options: {
      force: values.force ?? false,
      from: values.from ?? null,
      writeBudget: values['write-budget'] ? positiveInt('write-budget', values['write-budget']) : DEFAULTS.writeBudget,
      allowMassDelete: values['allow-mass-delete'] ?? false,
      allowYearChange: values['allow-year-change'] ?? false,
      batchSize,
      concurrency: values.concurrency ? positiveInt('concurrency', values.concurrency) : DEFAULTS.concurrency,
      waitTimeoutMs: values['wait-timeout'] ? parseDuration(values['wait-timeout']) : DEFAULTS.waitTimeoutMs,
      embeddingModel: EMBEDDING_MODEL,
      d1Only: values['d1-only'] ?? false,
    },
  };
}

/**
 * @param {string} base
 * @param {string} secret
 * @param {typeof fetch} [fetchImpl]
 * @returns {import('./ingest-core.mjs').AdminApi}
 */
export function httpAdminApi(base, secret, fetchImpl = fetch) {
  const headers = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };
  /** @param {string} path @param {RequestInit} init */
  const send = async (path, init) => {
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, { ...init, headers });
    } catch (err) {
      return { status: 599, body: { error: 'network', message: /** @type {Error} */ (err).message } };
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
  };
  return {
    get: (path) => send(path, { method: 'GET' }),
    post: (path, body) => send(path, { method: 'POST', body: JSON.stringify(body) }),
  };
}

/** @param {string} version */
export const dataVersionFile = (version) => `${JSON.stringify({ version }, null, 2)}\n`;

/**
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {(line: string) => void} log
 */
function noteBookmarkAndPreflight(record, log) {
  const mark = newestRecord(record.dir, (r) => r.script === 'd1:bookmark' && r.outcome === 'ok' && typeof r.bookmark === 'string' && r.bookmark);
  if (mark) {
    record.setBookmark(mark.record.bookmark);
    record.detail('bookmarkRecord', mark.file);
    log(`ingest: D1's bookmark before this run: ${mark.record.bookmark} (${mark.file}); \`npm run d1:restore\` returns to it.`);
  } else {
    log('ingest: warning: no d1:bookmark record; the runbook takes `npm run d1:bookmark` before any D1 write.');
  }
  const sha = record.data.commit.sha;
  const pre = sha ? newestRecord(record.dir, (r) => r.script === 'deploy:preflight' && r.outcome === 'ok' && r.commit?.sha === sha) : null;
  record.detail('preflight', pre?.file ?? null);
  if (!pre) log(`ingest: warning: no \`npm run deploy -- --preflight\` record for HEAD ${sha?.slice(0, 7) ?? '(unknown)'}; the runbook runs the preflight before any D1 write.`);
}

/** @type {Record<number, import('./run-record.mjs').Outcome>} */
const OUTCOME_BY_CODE = { 0: 'ok', 2: 'partial', 3: 'partial', 130: 'interrupted', 143: 'interrupted' };

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, log?: (line: string) => void, dataVersionPath?: string,
 *   envVars?: Record<string, string | undefined>, manifestPath?: string, corpusDir?: string, statePath?: string, deletesPath?: string,
 *   proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>, runsDir?: string, ngDataDir?: URL }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const {
    fetchImpl = fetch, log = console.log, dataVersionPath = DATA_VERSION_PATH, envVars = process.env, statePath = STATE_PATH, proc = process,
    deletesPath = D1_ONLY_DELETES, runsDir, manifestPath = CORPUS_MANIFEST_PATH, corpusDir = PROD_DIR, ngDataDir,
  } = deps;
  const secret = envVars.INGEST_SECRET;
  if (!secret) {
    log('INGEST_SECRET is not set. Run it through `npm run remote -- ingest …`, or export the value the Worker is bound to.');
    return 1;
  }
  const args = parseIngestArgs(argv, envVars);
  if (args.worker.error !== undefined) {
    log(`ingest: ${args.worker.error} Nothing was sent.`);
    return 1;
  }
  const base = args.worker.base;
  const lock = await acquireRunLock(statePath, base);
  if ('refused' in lock) {
    log(lock.refused);
    return 1;
  }
  const record = startRun('ingest', { target: envVars.VNM_REMOTE_TARGET ? `${base} (${envVars.VNM_REMOTE_TARGET})` : base, args: argv, dir: runsDir });
  const stopGuard = record.guardExit(proc, { signals: false });
  noteBookmarkAndPreflight(record, log);
  const controller = new AbortController();
  const signals = handleSignals(lock, controller, proc, log);
  try {
    const result = await ingestLocked({ ...args, base, options: { ...args.options, signal: controller.signal } },
      { fetchImpl: record.countingFetch(fetchImpl), log, dataVersionPath, manifestPath, corpusDir, statePath, secret, deletesPath, record, ngDataDir });
    const code = result.code === 130 ? (signals.exitCode() ?? result.code) : result.code;
    record.finish(OUTCOME_BY_CODE[code] ?? (result.status === 'refused' ? 'refused' : 'failed'), { exitCode: code, message: result.message });
    return code;
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    stopGuard();
    signals.off();
    await lock.release();
  }
}

/**
 * @param {Omit<ReturnType<typeof parseIngestArgs>, 'worker'> & { base: string }} args
 * @param {{ fetchImpl: typeof fetch, log: (line: string) => void, dataVersionPath: string, manifestPath: string, corpusDir: string,
 *   statePath: string, secret: string, deletesPath: string, record: import('./run-record.mjs').RunRecord, ngDataDir?: URL }} deps
 * @returns {Promise<{ code: number, status: string | null, message: string | null }>}
 */
async function ingestLocked(args, { fetchImpl, log, dataVersionPath, manifestPath, corpusDir, statePath, secret, deletesPath, record, ngDataDir }) {
  /** @type {Awaited<ReturnType<typeof loadCurrentCorpus>>} */
  let corpus;
  try {
    corpus = await loadCurrentCorpus({ manifestPath, dir: corpusDir });
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    log(`ingest: refusing, ${message} Nothing was sent.`);
    return { code: 1, status: 'refused', message };
  }
  const acadYear = corpus.entry.year;
  record.detail('corpus', { release: corpus.entry.release, sha256: corpus.entry.sha256 });
  /** @type {Awaited<ReturnType<typeof loadNgCourses>>} */
  let ngCourses;
  try {
    ngCourses = await loadNgCourses(acadYear, ngDataDir ? { dataDir: ngDataDir } : {});
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    log(`ingest: refusing, ${message} Nothing was sent.`);
    return { code: 1, status: 'refused', message };
  }
  if (!ngCourses.available) {
    const message = ngCourses.stub
      ? `data/ng-courses-${acadYear}.json is a stub (npm run year -- next); extract the year's NG list first (docs/year-refresh/README.md).`
      : `there is no data/ng-courses-${acadYear}.json; extract the year's NG list first (scripts/extract-ng.py), or exchange mode shows every course closed.`;
    log(`ingest: refusing, ${message} Nothing was sent.`);
    return { code: 1, status: 'refused', message };
  }
  const { modules, skipped } = offeredModules(corpus.records, acadYear, ngCourses);
  const catalogue = catalogueOnlyRecords(corpus.records);

  log(`acad year          ${acadYear}`);
  log(`source             ${corpus.entry.release} (data/corpus.json current, sha256 ${corpus.entry.sha256.slice(0, 12)}, fetched ${corpus.entry.fetchedAt})`);
  log(`catalogue records  ${corpus.records.length}`);
  log(`offered & usable   ${modules.length}`);
  log(`catalogue-only     ${catalogue.length}`);
  log(`skipped            ${skipped.length}${skipped.length ? ` (${skipped.slice(0, 10).map((s) => `${s.code}: ${s.why}`).join('; ')})` : ''}`);
  const matched = modules.filter((m) => m.ng).length;
  log(`NG list            ${ngCourses.total} codes (updated ${ngCourses.updatedAsAt}); ${matched} matched this corpus, ${ngCourses.total - matched} not offered this year`);
  if (ngCourses.unpublished.length) log(`NG list            Sem ${ngCourses.unpublished.join(', ')} unpublished: last year's list, each course to confirm`);
  log(`write budget       ${args.options.writeBudget} D1 rows`);

  const facetsBody = facetsPayload(ngCourses);
  const api = httpAdminApi(args.base, secret, fetchImpl);
  const pending = fileStateStore(statePath, args.base);
  const options = args.options.d1Only
    ? { ...args.options, expectedDataVersion: String(JSON.parse(await readFile(dataVersionPath, 'utf8')).version) }
    : args.options;
  if (options.d1Only) log(`mode               D1 only (runbook step 4): no Workers AI, no Vectorize; expecting data version ${options.expectedDataVersion}`);
  const result = await runIngest({ modules, facetsBody, api, options, pending, log, catalogue });

  log(`rows read          ${result.rowsRead} (ingest and delete calls; /admin/hashes and facets not metered here)`);
  log(`rows written       ${result.rowsWritten} reported by D1; ${result.rowsCharged} charged to the budget (with FTS estimate)`);
  record.read('D1 rows (ingest and delete calls; /admin/hashes and facets not metered)', { actual: result.rowsRead });
  record.wrote('D1 rows (estimate: charged to the write budget, with FTS)', { estimate: result.rowsCharged, actual: result.rowsWritten });
  if (result.dataVersion) record.version('dataVersion', result.dataVersion);
  if (result.lastMutationId) record.version('lastMutationId', result.lastMutationId);
  record.detail('mode', options.d1Only ? 'd1-only' : 'full');
  record.detail('status', result.status);
  const message = result.message ?? null;
  if (result.status === 'done' && options.d1Only) {
    await mkdir(dirname(deletesPath), { recursive: true });
    await writeFile(deletesPath, `${JSON.stringify({ dataVersion: result.dataVersion, codes: result.deletedCodes }, null, 2)}\n`);
    log(`deleted codes      ${result.deletedCodes.length} -> ${deletesPath} (runbook step 8 deletes their vectors)`);
    log('next               npm run remote -- verify --pre-deploy, then npm run deploy (runbook steps 5-6)');
    return { code: 0, status: result.status, message };
  }
  if (result.status === 'done' && result.dataVersion) {
    await writeFile(dataVersionPath, dataVersionFile(result.dataVersion));
    log(`data version       ${result.dataVersion} -> src/data-version.json`);
    log('next               commit src/data-version.json, then npm run deploy (docs/data.md "Re-ingesting")');
    return { code: 0, status: result.status, message };
  }
  return { code: { done: 0, refused: 1, failed: 1, budget: 2, 'wait-timeout': 3, interrupted: 130 }[result.status], status: result.status, message };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
