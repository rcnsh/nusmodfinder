#!/usr/bin/env node
// @ts-check
// D1 Time Travel for the runbook (Phase 7 7B):
//
//   npm run d1:bookmark                        records D1's current bookmark (a read), before any D1 write
//   npm run d1:restore -- [--bookmark <id>] [--yes]
//                                              restores the newest recorded bookmark (a D1 write)
//
// `d1:bookmark` runs `wrangler d1 time-travel info <db> --json` and writes a run record holding
// the bookmark; the ingest that follows copies it into its own record. `d1:restore` takes the
// newest such record (or --bookmark), prints the bookmark, its age and the ingest it came
// before, asks (or takes --yes), runs `wrangler d1 time-travel restore <db> --bookmark <id>
// --json`, records the restore with the bookmark that undoes it, and re-reads D1's data version
// over the REST query. The code stays where it is: this undoes "ingest done, deploy refused".
// Bookmarks reach back 30 days. Restores rewrite the database in place but aren't billed as row
// writes (Cloudflare's docs, 7-0).
import { pathToFileURL } from 'node:url';
import { askYes } from './ask.mjs';
import { d1Config, productionD1 } from './d1-read.mjs';
import { run } from './deploy.mjs';
import { GUARD_CHECKS, readD1 } from './guard.mjs';
import { newestRecord, readRunRecords, startRun } from './run-record.mjs';

/** Time Travel's reach on Workers Paid. */
export const TIME_TRAVEL_DAYS = 30;

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {{ argv?: string[], exec?: Exec, log?: (m: string) => void, error?: (m: string) => void, runsDir?: string, now?: () => Date }} Common
 */

/** The JSON object in wrangler's output (it may print a banner first). @param {string} stdout */
function jsonOf(stdout) {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON in its output');
  return JSON.parse(stdout.slice(start, end + 1));
}

/** `3 h old`, `25 min old`, `2 d old`. @param {number} ms */
const age = (ms) => (ms >= 86_400_000 ? `${Math.floor(ms / 86_400_000)} d` : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h` : `${Math.floor(ms / 60_000)} min`);

/**
 * @param {Common} [o]
 * @returns {Promise<number>}
 */
export async function bookmark({ argv = process.argv.slice(3), exec = run, log = console.log, error = console.error, runsDir, now } = {}) {
  const { databaseName } = await d1Config();
  const record = startRun('d1:bookmark', { target: databaseName, args: argv, dir: runsDir, ...(now ? { now } : {}) });
  const unguard = record.guardExit();
  try {
    record.request('wrangler d1 time-travel info');
    const res = await exec('npx', ['wrangler', 'd1', 'time-travel', 'info', databaseName, '--json']);
    record.read('D1 Time Travel bookmark (no table rows)', { estimate: 0, actual: 0 });
    /** @type {string | null} */
    let id = null;
    try { id = res.code === 0 ? jsonOf(res.stdout)?.bookmark ?? null : null; } catch { id = null; }
    if (typeof id !== 'string' || !id) {
      error(`d1:bookmark: wrangler d1 time-travel info failed or named no bookmark (exit ${res.code}).`);
      record.finish('failed', { exitCode: 1, message: 'no bookmark read' });
      return 1;
    }
    record.setBookmark(id);
    record.finish('ok', { exitCode: 0 });
    log(`d1:bookmark: ${databaseName} is at bookmark ${id}`);
    log(`d1:bookmark: recorded in ${record.path}; the next ingest copies it, and \`npm run d1:restore\` returns to it (for ${TIME_TRAVEL_DAYS} days).`);
    return 0;
  } finally {
    unguard();
  }
}

/**
 * @param {Common & { d1?: () => Promise<import('./d1-rest.mjs').D1Client>, confirm?: (q: string) => Promise<boolean> }} [o]
 * @returns {Promise<number>}
 */
export async function restore({ argv = process.argv.slice(3), exec = run, log = console.log, error = console.error, runsDir, now = () => new Date(), d1, confirm = askYes } = {}) {
  const { databaseName } = await d1Config();
  const i = argv.indexOf('--bookmark');
  const given = i >= 0 ? argv[i + 1] : undefined;
  const unknown = argv.filter((a, j) => a !== '--bookmark' && a !== '--yes' && !(i >= 0 && j === i + 1));
  if ((i >= 0 && (!given || given.startsWith('--'))) || unknown.length) {
    error('usage: npm run d1:restore -- [--bookmark <id>] [--yes]');
    return 2;
  }
  const record = startRun('d1:restore', { target: databaseName, args: argv, dir: runsDir, now });
  const unguard = record.guardExit();
  /** @param {import('./run-record.mjs').Outcome} outcome @param {number} code @param {string} message */
  const stop = (outcome, code, message) => { (code === 0 ? log : error)(`d1:restore: ${message}`); record.finish(outcome, { exitCode: code, message }); return code; };
  try {
    /** @type {string} */
    let id;
    if (given) {
      id = given;
      log(`d1:restore: bookmark ${id} (given with --bookmark)`);
    } else {
      const hit = newestRecord(record.dir, (r) => r.script === 'd1:bookmark' && r.outcome === 'ok' && typeof r.bookmark === 'string' && r.bookmark);
      if (!hit) return stop('refused', 1, `no d1:bookmark record under ${record.dir}; pass --bookmark <id>.`);
      id = hit.record.bookmark;
      const ms = now().getTime() - Date.parse(hit.record.time);
      record.detail('bookmarkRecord', hit.file);
      log(`d1:restore: bookmark ${id}, recorded ${hit.record.time} (${age(ms)} old) in ${hit.file}`);
      if (ms > TIME_TRAVEL_DAYS * 86_400_000) return stop('refused', 1, `that bookmark is older than Time Travel's ${TIME_TRAVEL_DAYS} days; it can't be restored.`);
    }
    const ingests = readRunRecords(record.dir)
      .filter((r) => r.record?.script === 'ingest' && r.record?.bookmark === id).map((r) => r.file);
    log(ingests.length ? `d1:restore: it was taken before the ingest(s) ${ingests.join(', ')}` : 'd1:restore: no ingest record names it.');
    log(`d1:restore: this overwrites all of ${databaseName} in place with its state at that bookmark; in-flight queries are cancelled. The code stays where it is.`);
    if (!argv.includes('--yes') && !(await confirm(`Restore ${databaseName} to ${id}?`))) return stop('refused', 1, 'not confirmed; nothing restored.');

    record.request('wrangler d1 time-travel restore');
    const res = await exec('npx', ['wrangler', 'd1', 'time-travel', 'restore', databaseName, '--bookmark', id, '--json']);
    record.wrote('D1 Time Travel restore (the database rewritten in place; not billed as rows written)', { estimate: null, actual: null });
    /** @type {any} */
    let body = null;
    try { body = res.code === 0 ? jsonOf(res.stdout) : null; } catch { body = null; }
    if (!body) return stop('failed', res.code || 1, `wrangler d1 time-travel restore failed (exit ${res.code}); check \`npx wrangler d1 time-travel info ${databaseName}\`.`);
    record.setBookmark(id);
    if (body.previous_bookmark) record.detail('previousBookmark', body.previous_bookmark);
    log(`d1:restore: restored ${databaseName} to ${body.bookmark ?? id}.${body.previous_bookmark ? ` To undo: npm run d1:restore -- --bookmark ${body.previous_bookmark}` : ''}`);

    // The re-read: what D1's data version is now.
    /** @type {import('./d1-rest.mjs').D1Client | null} */
    let client = null;
    try {
      client = await (d1 ?? (() => productionD1({ exec })))();
      const ctx = await readD1(client);
      const dv = await /** @type {import('./guard.mjs').GuardCheck} */ (GUARD_CHECKS.find((c) => c.field === 'dataVersion')).d1(ctx);
      record.read('D1 rows (re-read over the REST query: modules, catalogue_only and the schema check)', { actual: client.rowsRead });
      record.version('dataVersion', dv);
      // 7D: and its catalogueKey, which rollback compares with the target's tag too.
      record.version('catalogueKey', ctx.hashes.catalogueKey ?? null);
      log(`d1:restore: D1's data version is now ${dv ?? `unknown (rows whose row_hash is not their columns' hash: ${(ctx.hashes.rowHashDrift ?? []).slice(0, 10).join(', ')})`} (${client.rowsRead} rows read).`);
    } catch (err) {
      record.read('D1 rows (re-read over the REST query)', { actual: client?.rowsRead ?? null });
      return stop('failed', 1, `restored, but re-reading D1 failed: ${/** @type {Error} */ (err).message}. Check it before deploying.`);
    }
    record.finish('ok', { exitCode: 0 });
    log(`d1:restore: run record ${record.path}`);
    return 0;
  } finally {
    unguard();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd === 'bookmark') process.exitCode = await bookmark();
  else if (cmd === 'restore') process.exitCode = await restore();
  else { console.error('usage: node scripts/d1-time-travel.mjs bookmark | restore [--bookmark <id>] [--yes]'); process.exitCode = 2; }
}
