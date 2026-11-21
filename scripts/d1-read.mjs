// @ts-check
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1RestClient } from './d1-rest.mjs';
import { parseJsonc } from './jsonc.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WRANGLER_ACCOUNT_CACHE = join(ROOT, 'node_modules/.cache/wrangler/wrangler-account.json');

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 */

export const DB_BINDING = 'DB';

/**
 * @param {string} [path]
 * @returns {Promise<{ databaseName: string, databaseId: string }>}
 */
export async function d1Config(path = join(ROOT, 'wrangler.jsonc')) {
  const config = /** @type {any} */ (parseJsonc(await readFile(path, 'utf8'), 'wrangler.jsonc'));
  const list = Array.isArray(config?.d1_databases) ? config.d1_databases : [];
  const bound = list.filter((/** @type {any} */ d) => d?.binding === DB_BINDING);
  if (bound.length !== 1) {
    throw new Error(`wrangler.jsonc has ${bound.length ? `${bound.length} d1_databases entries` : 'no d1_databases entry'} bound as ${DB_BINDING}; the guard reads the one the Worker binds`);
  }
  const { database_name: databaseName, database_id: databaseId } = bound[0];
  if (typeof databaseName !== 'string' || !databaseName || typeof databaseId !== 'string' || !databaseId) {
    throw new Error(`wrangler.jsonc's ${DB_BINDING} binding has no database_name and database_id`);
  }
  return { databaseName, databaseId };
}

/**
 * @param {{ env?: Record<string, string | undefined>, exec: Exec }} o
 * @returns {Promise<string>}
 */
export async function resolveToken({ env = process.env, exec }) {
  if (env.CLOUDFLARE_API_TOKEN) return env.CLOUDFLARE_API_TOKEN;
  const res = await exec('npx', ['wrangler', 'auth', 'token', '--json']);
  const fail = (/** @type {string} */ why) => new Error(`could not get a Cloudflare token from \`wrangler auth token\` (${why}); log in with \`npx wrangler login\`, or set CLOUDFLARE_API_TOKEN.`);
  if (res.code !== 0) throw fail(`exit ${res.code}`);
  /** @type {any} */
  let parsed;
  try { parsed = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))); } catch { throw fail('its output is not JSON'); }
  if (typeof parsed?.token !== 'string' || !parsed.token) throw fail(`no token in its answer (type ${typeof parsed?.type === 'string' ? parsed.type : 'unknown'})`);
  return parsed.token;
}

/**
 * @param {{ env?: Record<string, string | undefined>, cacheFile?: string, exec?: Exec }} [o]
 * @returns {Promise<string>}
 */
export async function resolveAccountId({ env = process.env, cacheFile = WRANGLER_ACCOUNT_CACHE, exec } = {}) {
  if (env.CLOUDFLARE_ACCOUNT_ID) return env.CLOUDFLARE_ACCOUNT_ID;
  const cached = await readFile(cacheFile, 'utf8').then((t) => JSON.parse(t)?.account?.id, () => null);
  if (typeof cached === 'string' && cached) return cached;
  if (exec) {
    const res = await exec('npx', ['wrangler', 'whoami', '--json']).catch(() => null);
    /** @type {any} */
    let who = null;
    if (res?.code === 0) { try { who = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))); } catch {} }
    const accounts = Array.isArray(who?.accounts) ? who.accounts : [];
    if (accounts.length === 1 && typeof accounts[0]?.id === 'string' && accounts[0].id) return accounts[0].id;
  }
  throw new Error('no Cloudflare account id: set CLOUDFLARE_ACCOUNT_ID (the dashboard\'s Account ID; in Actions, the repo variable).');
}

/**
 * @param {{ env?: Record<string, string | undefined>, exec: Exec, fetchImpl?: typeof fetch, cacheFile?: string }} o
 * @returns {Promise<import('./d1-rest.mjs').D1Client>}
 */
export async function productionD1({ env = process.env, exec, fetchImpl = fetch, cacheFile }) {
  const [{ databaseId }, accountId] = await Promise.all([d1Config(), resolveAccountId({ env, exec, ...(cacheFile ? { cacheFile } : {}) })]);
  return d1RestClient({ accountId, databaseId, token: () => resolveToken({ env, exec }), fetchImpl });
}
