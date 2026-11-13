// @ts-check
// The uptime Worker (ADR 0019): every 15 minutes a Cron Trigger runs the uptime check
// (scripts/uptime-check.mjs) against the live site and reports to healthchecks.io. It is its own
// Worker, not a cron on `nusmodfinder`, so it still runs, and alerts, when the site's Worker is
// broken. It has no routes, no bindings and no fetch handler. The module codes come from
// data/groups.json as it was when this Worker was deployed; a code the site no longer has is still
// a pass (the check accepts /module's named 404s).
//
// SITE is a var in wrangler.jsonc; HC_UPTIME_URL is a Worker secret
// (`npx wrangler secret put HC_UPTIME_URL -c workers/uptime/wrangler.jsonc`).
import groupsFile from '../../data/groups.json' with { type: 'json' };
import { checkAndReport, moduleCodes } from '../../scripts/uptime-check.mjs';

const codes = moduleCodes(groupsFile);

/**
 * @typedef {{ SITE?: string, HC_UPTIME_URL?: string }} UptimeEnv
 * @typedef {Omit<import('../../scripts/uptime-check.mjs').CheckOptions, 'base' | 'codes' | 'pingUrl'>} RunDeps
 */

/**
 * One cron run. Throws when the report did not reach healthchecks.io, so the invocation is marked
 * failed in Workers Logs; healthchecks.io's grace is the alert for that.
 * @param {UptimeEnv} env
 * @param {RunDeps} [deps]
 */
export async function run(env, deps = {}) {
  const base = String(env.SITE ?? '').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/.test(base)) throw new Error('uptime: SITE is not an https origin');
  const exit = await checkAndReport({ ...deps, base, codes, pingUrl: env.HC_UPTIME_URL });
  if (exit !== 0) throw new Error(`uptime: the report did not reach healthchecks.io (exit ${exit})`);
}

export default {
  /** @param {unknown} _controller @param {UptimeEnv} env */
  async scheduled(_controller, env) {
    await run(env);
  },
};
