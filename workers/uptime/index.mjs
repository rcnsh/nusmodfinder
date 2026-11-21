// @ts-check
import groupsFile from '../../data/groups.json' with { type: 'json' };
import { checkAndReport, moduleCodes } from '../../scripts/uptime-check.mjs';

const codes = moduleCodes(groupsFile);

/**
 * @typedef {{ SITE?: string, HC_UPTIME_URL?: string }} UptimeEnv
 * @typedef {Omit<import('../../scripts/uptime-check.mjs').CheckOptions, 'base' | 'codes' | 'pingUrl'>} RunDeps
 */

/**
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
