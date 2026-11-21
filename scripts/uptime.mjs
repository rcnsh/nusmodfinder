#!/usr/bin/env node
// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { workerUrl } from './remote-session.mjs';
import { checkAndReport, moduleCodes } from './uptime-check.mjs';

export {
  GAP_MS, PERIOD_MS, QUERIES, RETRY_MS, SCHEDULE, TRIES, moduleCodes, queryIndex,
} from './uptime-check.mjs';

const USAGE = 'usage: node scripts/uptime.mjs [--url <url>] [--dry-run]';

/** @param {string} text */
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
 * @param {UptimeDeps} [deps]
 * @returns {Promise<number>}
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
