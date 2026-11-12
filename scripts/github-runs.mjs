// @ts-check
// Whether a commit's own CI push run succeeded: the deploy's preflight refuses otherwise, and
// the Actions deploy's gate (scripts/deploy-gate.mjs) waits for it. One `gh api` read of the repo's runs for that sha; `{owner}/{repo}` is filled in by
// gh from the checkout's remote (GH_TOKEN in Actions, the deployer's gh login on the Mac).

/** The workflows (by `name:`) whose push runs must have succeeded. */
export const REQUIRED_WORKFLOWS = /** @type {const} */ (['CI']);

/**
 * @typedef {{ id: number, name: string, status: string, conclusion: string | null, head_sha: string, event?: string,
 *   run_number?: number, run_attempt?: number, created_at?: string, html_url?: string }} WorkflowRun
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {{ name: string, state: 'green' | 'pending' | 'failed' | 'missing', run: WorkflowRun | null, message: string }} RunState
 */

/** @param {string} sha */
export const runsApiPath = (sha) => `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&event=push&per_page=100`;

/**
 * The push runs for `sha`, newest first.
 * @param {{ sha: string, exec: Exec }} o
 * @returns {Promise<WorkflowRun[]>}
 */
export async function pushRuns({ sha, exec }) {
  const res = await exec('gh', ['api', runsApiPath(sha)]);
  if (res.code !== 0) throw new Error(`could not list GitHub's runs for ${sha.slice(0, 7)} (gh api exit ${res.code}; is gh logged in, or GH_TOKEN set?)`);
  /** @type {any} */
  let body;
  try { body = JSON.parse(res.stdout); } catch { throw new Error('could not list GitHub\'s runs: gh api answered with something other than JSON'); }
  if (!Array.isArray(body?.workflow_runs)) throw new Error('could not list GitHub\'s runs: no workflow_runs in the answer');
  return body.workflow_runs;
}

/**
 * Each required workflow's newest push run for `sha`, and what it means for a deploy.
 * @param {WorkflowRun[]} runs
 * @param {string} sha
 * @returns {{ ok: boolean, states: RunState[] }}
 */
export function runStates(runs, sha) {
  const states = REQUIRED_WORKFLOWS.map((name) => {
    const mine = runs.filter((r) => r.name === name && r.head_sha === sha && (r.event ?? 'push') === 'push')
      .sort((a, b) => (b.run_number ?? 0) - (a.run_number ?? 0) || b.id - a.id);
    const run = mine[0] ?? null;
    /** @type {RunState} */
    const s = !run ? { name, state: 'missing', run, message: `no ${name} push run for ${sha.slice(0, 7)}: push the commit to main first, or wait for GitHub to start it.` }
      : run.status !== 'completed' ? { name, state: 'pending', run, message: `${name} run ${run.id} is ${run.status}: wait for it with \`gh run watch ${run.id} --exit-status\`.` }
        : run.conclusion === 'success' ? { name, state: 'green', run, message: `${name} run ${run.id} succeeded.` }
          : { name, state: 'failed', run, message: `${name} run ${run.id} ended ${run.conclusion ?? 'without a conclusion'}: fix it, or rerun it with \`gh run rerun ${run.id}\`.` };
    return s;
  });
  return { ok: states.every((s) => s.state === 'green'), states };
}
