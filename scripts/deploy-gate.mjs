#!/usr/bin/env node
// @ts-check
// The Actions deploy's gate (.github/workflows/deploy.yml). The workflow runs once per completed
// CI run on main; this decides whether that sha deploys:
//
// - its CI push run succeeded;
// - it is still main's tip (otherwise the newer commit's own run deploys it);
// - no deploy/* tag names it yet (a re-run of CI completes again; the concurrency group runs
//   deploys one after the other, and a later one finds the earlier one's tag).
//
//   node scripts/deploy-gate.mjs --sha <sha>   writes deploy=true|false and reason to GITHUB_OUTPUT
//
// Reads GitHub with gh (GH_TOKEN) and origin with git ls-remote; writes nothing.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pushRuns, runStates } from './github-runs.mjs';

/**
 * @param {{ sha: string, tip: string, runs: import('./github-runs.mjs').WorkflowRun[], deployed: string[] }} o
 * @returns {{ deploy: boolean, reason: string }}
 */
export function gateDecision({ sha, tip, runs, deployed }) {
  const { ok, states } = runStates(runs, sha);
  if (!ok) {
    const s = states.filter((x) => x.state !== 'green');
    const reason = s.map((x) => (x.state === 'pending' ? `${x.name} run ${x.run?.id} has not finished (${x.run?.status}); its own completion event decides.` : x.message)).join(' ');
    return { deploy: false, reason };
  }
  if (sha !== tip) return { deploy: false, reason: `${sha.slice(0, 7)} is not main's tip (${tip.slice(0, 7)}); the newer commit's own runs deploy it.` };
  if (deployed.includes(sha)) return { deploy: false, reason: `${sha.slice(0, 7)} is already deployed (a deploy/* tag names it).` };
  return { deploy: true, reason: `CI succeeded on ${sha.slice(0, 7)}, main's tip; deploying.` };
}

/** @type {import('./github-runs.mjs').Exec} */
async function exec(cmd, args) {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'inherit'] });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--sha');
  const sha = i >= 0 ? process.argv[i + 1] ?? '' : '';
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    console.error('usage: node scripts/deploy-gate.mjs --sha <40-hex sha>');
    process.exit(2);
  }
  const tip = (await exec('git', ['ls-remote', 'origin', 'refs/heads/main'])).stdout.split('\t')[0].trim();
  const tags = await exec('git', ['ls-remote', '--tags', 'origin', 'refs/tags/deploy/*']);
  // Annotated tags: the peeled line (`<commit>\trefs/tags/deploy/…^{}`) names the commit.
  const deployed = tags.stdout.split('\n').filter((l) => l.endsWith('^{}')).map((l) => l.split('\t')[0]);
  if (!/^[0-9a-f]{40}$/.test(tip) || tags.code !== 0) {
    console.error('::error title=Deploy gate::could not read main\'s tip or the deploy tags from origin; nothing deployed.');
    process.exit(1);
  }
  let decision;
  try {
    decision = gateDecision({ sha, tip, runs: await pushRuns({ sha, exec }), deployed });
  } catch (err) {
    // A failed read is a red job, not a quiet skip: nothing deployed, and someone should look.
    console.error(`::error title=Deploy gate::${/** @type {Error} */ (err).message}; nothing deployed.`);
    process.exit(1);
  }
  console.log(`${decision.deploy ? '' : '::notice title=No deploy::'}${decision.reason}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${decision.deploy}\nreason=${decision.reason.replace(/\n/g, ' ')}\n`);
}
