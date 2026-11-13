#!/usr/bin/env node
// @ts-check
// `node scripts/uptime.mjs [--url <url>] [--dry-run]` (ADR 0012, ADR 0019): the uptime check, run
// by hand. The uptime Worker (workers/uptime/) runs the same check every 15 minutes; both call
// checkAndReport() in scripts/uptime-check.mjs, which says what is checked and reported.
//
// `--dry-run` checks the site and prints what it would ping, pinging nothing, so it needs no
// HC_UPTIME_URL. Without it the run pings the healthchecks.io check like a Worker run.
// The site is wrangler.jsonc's Custom Domain unless --url is given; the module code is drawn from
// this checkout's data/groups.json. The exit code is checkAndReport()'s: 0 once the report reached
// healthchecks.io (or on a dry run), up or down; 1 when the ping failed; 2 on a usage or
// configuration error, before any request. No run record: healthchecks.io keeps the history.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workerUrl } from './remote-session.mjs';
import { checkAndReport, moduleCodes } from './uptime-check.mjs';

export {
  GAP_MS, PERIOD_MS, QUERIES, RETRY_MS, SCHEDULE, TRIES, moduleCodes, queryIndex,
} from './uptime-check.mjs';

const USAGE = 'usage: node scripts/uptime.mjs [--url <url>] [--dry-run]';

/** The site wrangler.jsonc routes to (its first route pattern), or null. @param {string} text */
export function siteUrl(text) {
  const pattern = /"pattern"\s*:\s*"([^"/]+)"/.exec(text)?.[1];
  return pattern ? `https://${pattern}` : null;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ url?: string, dryRun: boolean, bad: boolean }} */
  const out = { dryRun: false, bad: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--url' && argv[i + 1] && !argv[i + 1].startsWith('--')) { out.url = argv[i + 1]; i += 1; } else out.bad = true;
  }
  return out;
}

/**
 * @typedef {{
 *   argv?: string[], env?: Record<string, string | undefined>, fetchImpl?: typeof fetch,
 *   ping?: (url: string, body?: string) => Promise<{ ok: boolean, status: number }>,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, log?: (m: string) => void, error?: (m: string) => void,
 *   codes?: () => string[], wrangler?: () => string,
 * }} UptimeDeps
 */

/**
 * One run from the command line.
 * @param {UptimeDeps} [deps]
 * @returns {Promise<number>} the exit code
 */
export async function uptime({
  argv = process.argv.slice(2), env = process.env, fetchImpl, ping, sleep, now, log = console.log, error = console.error,
  codes = () => moduleCodes(JSON.parse(readFileSync(fileURLToPath(new URL('../data/groups.json', import.meta.url)), 'utf8'))),
  wrangler = () => readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8'),
} = {}) {
  const args = parseArgs(argv);
  if (args.bad) { error(USAGE); return 2; }
  const given = args.url ?? siteUrl(wrangler());
  if (!given) { error('uptime: no --url, and wrangler.jsonc names no route pattern.'); return 2; }
  const site = workerUrl(given, {});
  if (!('base' in site) || !site.base) { error(`uptime: ${site.error}`); return 2; }
  return checkAndReport({
    base: site.base, codes: codes(), pingUrl: env.HC_UPTIME_URL, dryRun: args.dryRun,
    fetchImpl, ping, sleep, now, log, error,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await uptime();
}
