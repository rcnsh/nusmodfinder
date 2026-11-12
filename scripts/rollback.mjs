#!/usr/bin/env node
// @ts-check
// `npm run rollback -- [--to <version id or its first 8>] [--accept-data-mismatch] [--yes]`
// (Phase 7 7B): puts an earlier Worker version back at 100%, code only.
//
// 1. Target: --to, else the newest deployment before the live one whose version differs
//    (`wrangler deployments list --json`). Its commit, data version (and every other guard
//    field, 7D's catalogueKey among them) come from its deploy/* tag.
// 2. Data check: D1 read directly over the REST query (scripts/d1-rest.mjs; ~6.8k rows today,
//    more with 7D's catalogue), never a Worker session or the working tree's code. Every tagged
//    field must equal D1's. A mismatch refuses unless --accept-data-mismatch, which prints the
//    risk; the usual path across a data change is `npm run d1:restore`, then rollback.
// 3. `wrangler rollback <id> --message "rollback to <tag>" -y`, after a confirmation (or --yes).
// 4. An annotated `rollback/<UTC time>-<id8>` tag on the target's commit, pushed; a failed tag
//    is reported, not fatal. Then it prints `npm run smoke -- --expect <target sha>`.
//
// Needs no clean tree and no CI. The Vectorize standby is not rolled back.
//
// Why REST rather than `wrangler d1 execute --remote --command` for the reads: one read path
// for the guard, rollback and d1:restore, with the same read-only refusal in code, the same
// hashing (src/admin-hashes.js) and rows read from the API's own meta; and it works with the
// Actions token too.
import { pathToFileURL } from 'node:url';
import { askYes } from './ask.mjs';
import { productionD1 } from './d1-read.mjs';
import { run } from './deploy.mjs';
import { createAndPushTag, fetchTraceTags, findVersionTag, pushCommand, tagName } from './deploy-tag.mjs';
import { GUARD_CHECKS, compareWithTag } from './guard.mjs';
import { startRun } from './run-record.mjs';

const WORKER_NAME = 'nusmodfinder';

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {{ id: string, created_on: string, versions: { version_id: string, percentage: number }[] }} Deployment
 */

/** The version a deployment serves most. @param {Deployment} d */
const mainVersion = (d) => [...(d.versions ?? [])].sort((a, b) => b.percentage - a.percentage)[0]?.version_id ?? null;

/** @param {string[]} argv */
function parseArgs(argv) {
  const i = argv.indexOf('--to');
  const to = i >= 0 ? argv[i + 1] : undefined;
  const known = new Set(['--to', '--accept-data-mismatch', '--yes']);
  const unknown = argv.filter((a, j) => !known.has(a) && !(i >= 0 && j === i + 1));
  return { to, missingTo: i >= 0 && !to, accept: argv.includes('--accept-data-mismatch'), yes: argv.includes('--yes'), unknown };
}

/**
 * @param {{ argv?: string[], exec?: Exec, log?: (m: string) => void, error?: (m: string) => void, runsDir?: string, now?: () => Date,
 *   d1?: () => Promise<import('./d1-rest.mjs').D1Client>, checks?: import('./guard.mjs').GuardCheck[], confirm?: (q: string) => Promise<boolean> }} [o]
 * @returns {Promise<number>}
 */
export async function rollback({
  argv = process.argv.slice(2), exec: rawExec = run, log = console.log, error = console.error, runsDir, now = () => new Date(),
  d1, checks = GUARD_CHECKS, confirm = askYes,
} = {}) {
  const args = parseArgs(argv);
  if (args.missingTo || args.unknown.length) {
    error('usage: npm run rollback -- [--to <version id>] [--accept-data-mismatch] [--yes]');
    return 2;
  }
  const record = startRun('rollback', { target: WORKER_NAME, args: argv, dir: runsDir, now });
  const unguard = record.guardExit();
  /** @type {Exec} */
  const exec = (cmd, a, opts) => {
    if (cmd === 'npx' && a[0] === 'wrangler' && a[1] !== 'auth') record.request(`wrangler ${a.slice(1, 3).join(' ')}`);
    return rawExec(cmd, a, opts);
  };
  /** @param {import('./run-record.mjs').Outcome} outcome @param {number} code @param {string} message */
  const stop = (outcome, code, message) => { error(`rollback: ${message}`); record.finish(outcome, { exitCode: code, message: message.split('\n')[0] }); return code; };
  try {
    // 1. The target.
    const listed = await exec('npx', ['wrangler', 'deployments', 'list', '--json']);
    /** @type {Deployment[]} */
    let deployments;
    try {
      if (listed.code !== 0) throw new Error(`exit ${listed.code}`);
      deployments = JSON.parse(listed.stdout.slice(listed.stdout.indexOf('['))).sort((/** @type {Deployment} */ a, /** @type {Deployment} */ b) => a.created_on.localeCompare(b.created_on));
    } catch (err) {
      return stop('failed', 1, `could not list the deployments (wrangler deployments list --json: ${/** @type {Error} */ (err).message}).`);
    }
    const live = deployments.length ? mainVersion(deployments[deployments.length - 1]) : null;
    if (!live) return stop('failed', 1, 'the Worker has no live deployment to roll back from.');
    /** @type {string | null} */
    let target = null;
    if (args.to) {
      const to = args.to;
      target = deployments.flatMap((d) => d.versions.map((v) => v.version_id)).find((v) => v === to || v.startsWith(to)) ?? (/^[0-9a-f-]{36}$/.test(to) ? to : null);
      if (!target) return stop('refused', 1, `no deployed version starts with ${to}; pass the full version id.`);
    } else {
      target = [...deployments].reverse().map(mainVersion).find((v) => v && v !== live) ?? null;
      if (!target) return stop('refused', 1, 'no earlier deployment with another version; pass --to <version id>.');
    }
    if (target === live) return stop('refused', 1, `${target} is already live.`);
    record.version('versionId', target);
    record.version('previousVersionId', live);
    log(`rollback: live ${live}; target ${target}`);

    // The target's tag.
    if (!(await fetchTraceTags(exec))) log('rollback: note: could not fetch the deploy tags from origin; using the local ones.');
    const tag = await findVersionTag({ exec, versionId: target, fetch: false });
    if (tag && tag.fields.versionId && tag.fields.versionId !== target) return stop('refused', 1, `the tag ${tag.name} names ${tag.fields.versionId}, not ${target}.`);
    if (tag) log(`rollback: target tag ${tag.name} on ${tag.commit.slice(0, 7)} (data version ${tag.fields.dataVersion ?? 'unrecorded'})`);
    const risk = 'the old code and bundle will serve against D1 rows they were not built for (an old bundle against new D1 rows): '
      + 'search may drop, mis-filter or mis-rank modules until D1 or the code moves again.';
    if (!tag) {
      if (!args.accept) {
        return stop('refused', 1, `no deploy/* tag names ${target.slice(0, 8)}, so its commit and data are unknown. Pass --accept-data-mismatch `
          + 'to roll back unchecked (no rollback tag is made).');
      }
      error(`rollback: --accept-data-mismatch with no tag: rolling back unchecked; ${risk}`);
    }

    // 2. The data check.
    if (tag) {
      /** @type {import('./d1-rest.mjs').D1Client | null} */
      let client = null;
      /** @type {Awaited<ReturnType<typeof compareWithTag>>} */
      let check;
      try {
        client = await (d1 ?? (() => productionD1({ exec })))();
        check = await compareWithTag({ client, fields: tag.fields, checks });
      } catch (err) {
        record.read('D1 rows (the data check, over the REST query)', { actual: client?.rowsRead ?? null });
        return stop('failed', 1, `could not read D1: ${/** @type {Error} */ (err).message}`);
      }
      record.read('D1 rows (the data check, over the REST query)', { actual: client.rowsRead });
      record.detail('dataCheck', check.results.map((r) => ({ name: r.name, ok: r.ok, d1: r.d1, tag: r.expected })));
      for (const [k, v] of Object.entries(check.values)) record.version(k, v);
      log(`rollback: data check: ${check.results.map((r) => `${r.name} ${r.ok ? 'matches' : 'DIFFERS'}`).join(', ')} (${client.rowsRead} D1 rows read)`);
      if (!check.ok) {
        const lines = check.results.filter((r) => !r.ok).map((r) => r.message).join('\n');
        if (!args.accept) {
          return stop('refused', 1, `${lines}\nThe usual path across a data change: \`npm run d1:restore\` to the bookmark before the ingest, `
            + 'then rollback. For a deliberate mismatch, --accept-data-mismatch.');
        }
        error(`rollback: --accept-data-mismatch:\n${lines}\nRolling back anyway; ${risk}`);
      }
    }

    // 3. The rollback.
    if (!args.yes && !(await confirm(`Roll ${WORKER_NAME} back from ${live} to ${target}?`))) return stop('refused', 1, 'not confirmed; nothing rolled back.');
    const msg = `rollback to ${tag?.name ?? target.slice(0, 8)}`;
    const rolled = await exec('npx', ['wrangler', 'rollback', target, '--message', msg, '-y'], { stream: true });
    if (rolled.code !== 0) return stop('failed', rolled.code, `wrangler rollback failed (exit ${rolled.code}); check \`npx wrangler deployments status\`.`);
    log(`rollback: ${target} is live again (from ${live}).`);

    // 4. The trace.
    if (tag) {
      const name = tagName('rollback', now(), target);
      // The target's data fields (dataVersion, 7D's catalogueKey…), not its deploy's own.
      const own = new Set(['versionId', 'previousVersionId', 'commit', 'backfilled', 'source', 'startupMs', 'actionsRun', 'rolledBackFrom', 'targetTag']);
      const data = Object.fromEntries(Object.entries(tag.fields).filter(([k]) => !own.has(k)));
      const made = await createAndPushTag({
        exec, name, commit: tag.commit, title: `rollback to ${target.slice(0, 8)} (${tag.name})`,
        fields: { versionId: target, previousVersionId: live, commit: tag.commit, ...data, rolledBackFrom: live, targetTag: tag.name },
      });
      record.version('rollbackTag', name);
      record.detail('tagPushed', made.pushed);
      if (!made.created) error(`rollback: could not create the tag ${name}; the rollback stands. Create it on ${tag.commit} by hand.`);
      else if (!made.pushed) error(`rollback: pushing ${name} failed; the rollback stands. Retry:\n  ${pushCommand(name)}`);
      else log(`rollback: tagged ${name} on ${tag.commit.slice(0, 7)} and pushed it.`);
      log(`rollback: now check it: npm run smoke -- --expect ${tag.commit}`);
    } else {
      log('rollback: no tag (the target had none). Check it with `npm run smoke -- --expect <the target\'s commit>`.');
    }
    log('rollback: the Vectorize standby was not rolled back; if DENSE_BACKEND matters, rerun `npm run remote -- vectors standby` from the target commit.');
    record.finish('ok', { exitCode: 0 });
    log(`rollback: run record ${record.path}`);
    return 0;
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    unguard();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await rollback();
}
