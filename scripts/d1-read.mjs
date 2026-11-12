// @ts-check
// Production D1, read-only, for the deploy guard, rollback and d1:restore (Phase 7 7B, G1): the
// REST client (scripts/d1-rest.mjs) with its token, account and database.
//
// - Token: CLOUDFLARE_API_TOKEN (GitHub Actions: the account-owned deploy token), else
//   `npx wrangler auth token --json` captured in-process (the Mac: wrangler's OAuth login). It
//   is never printed, logged, put in an error or recorded.
// - Account: CLOUDFLARE_ACCOUNT_ID (a repo variable in Actions), else the account wrangler
//   cached when it last chose one (node_modules/.cache/wrangler/wrangler-account.json), else a
//   refusal naming the variable.
// - Database: wrangler.jsonc's DB binding (nusmods-apac).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { d1RestClient } from './d1-rest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Where wrangler caches the account it last used. */
export const WRANGLER_ACCOUNT_CACHE = join(ROOT, 'node_modules/.cache/wrangler/wrangler-account.json');

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 */

/**
 * wrangler.jsonc's DB binding.
 * @param {string} [path]
 * @returns {Promise<{ databaseName: string, databaseId: string }>}
 */
export async function d1Config(path = join(ROOT, 'wrangler.jsonc')) {
  const text = await readFile(path, 'utf8');
  const block = /"d1_databases"\s*:\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
  const databaseName = /"database_name"\s*:\s*"([^"]+)"/.exec(block)?.[1];
  const databaseId = /"database_id"\s*:\s*"([^"]+)"/.exec(block)?.[1];
  if (!databaseName || !databaseId) throw new Error('wrangler.jsonc has no d1_databases entry with database_name and database_id');
  return { databaseName, databaseId };
}

/**
 * The API token: CLOUDFLARE_API_TOKEN, else wrangler's, captured (never streamed).
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
 * The account id: CLOUDFLARE_ACCOUNT_ID, else wrangler's cached account, else the one account
 * `wrangler whoami` lists (the Mac's login usually has no cache file; several accounts refuse).
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
    if (res?.code === 0) { try { who = JSON.parse(res.stdout.slice(res.stdout.indexOf('{'))); } catch { /* not JSON */ } }
    const accounts = Array.isArray(who?.accounts) ? who.accounts : [];
    if (accounts.length === 1 && typeof accounts[0]?.id === 'string' && accounts[0].id) return accounts[0].id;
  }
  throw new Error('no Cloudflare account id: set CLOUDFLARE_ACCOUNT_ID (the dashboard\'s Account ID; in Actions, the repo variable).');
}

/**
 * The production D1 client. Nothing is sent until the first query.
 * @param {{ env?: Record<string, string | undefined>, exec: Exec, fetchImpl?: typeof fetch, cacheFile?: string }} o
 * @returns {Promise<import('./d1-rest.mjs').D1Client>}
 */
export async function productionD1({ env = process.env, exec, fetchImpl = fetch, cacheFile }) {
  const [{ databaseId }, accountId] = await Promise.all([d1Config(), resolveAccountId({ env, exec, ...(cacheFile ? { cacheFile } : {}) })]);
  return d1RestClient({ accountId, databaseId, token: () => resolveToken({ env, exec }), fetchImpl });
}
