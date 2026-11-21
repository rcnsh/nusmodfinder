// @ts-check
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { gateDecision } from '../scripts/deploy-gate.mjs';

const workflow = readFileSync(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const steps = workflow.slice(workflow.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1);
/** @param {RegExp} re */
const step = (re) => {
  const s = steps.filter((x) => re.test(x));
  if (s.length !== 1) throw new Error(`${s.length} steps match ${re}`);
  return s[0];
};

describe('deploy.yml', () => {
  it('runs on workflow_run for CI, completed, on main only', () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n/m);
    expect(workflow).not.toMatch(/^\s+(push|pull_request|pull_request_target|schedule):/m);
  });

  it('has exactly contents: write and actions: read', () => {
    const perms = workflow.match(/^permissions:\n((?: {2}.+\n)+)/m)?.[1];
    expect(perms?.trim().split('\n').map((l) => l.trim()).filter((l) => !l.startsWith('#'))).toEqual(['contents: write', 'actions: read']);
    expect(workflow.match(/permissions:/g)).toHaveLength(1);
  });

  it('runs one deploy at a time and never cancels one in progress', () => {
    expect(workflow).toMatch(/^concurrency:\n {2}group: deploy-production\n {2}cancel-in-progress: false\n/m);
  });

  it('is off unless DEPLOY_FROM_ACTIONS is \'true\', and only for a successful push run of this repo', () => {
    const jobIf = workflow.match(/^ {4}if: (.+)$/m)?.[1] ?? '';
    expect(jobIf).toContain("vars.DEPLOY_FROM_ACTIONS == 'true'");
    expect(jobIf).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(jobIf).toContain("github.event.workflow_run.event == 'push'");
    expect(jobIf).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
  });

  it('gates on both runs, the tip and the tags, then checks out exactly that sha', () => {
    const gate = step(/deploy-gate\.mjs/);
    expect(gate).toContain('github.event.workflow_run.head_sha');
    const checkout = step(/actions\/checkout@/);
    expect(checkout).toMatch(/ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
    expect(checkout).toMatch(/fetch-depth: 0/);
    expect(steps.indexOf(gate)).toBeLessThan(steps.indexOf(step(/npm run deploy/)));
    for (const s of steps.slice(steps.indexOf(gate) + 1)) {
      if (/upload-artifact|GITHUB_STEP_SUMMARY/.test(s)) continue;
      expect(s, s.split('\n')[0]).toMatch(/steps\.gate\.outputs\.deploy == 'true'/);
    }
  });

  it('runs `npm run deploy`, the only deploy path, with the Cloudflare token and account in that step\'s env alone', () => {
    const deployStep = step(/npm run deploy/);
    expect(deployStep).toMatch(/CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
    expect(deployStep).toMatch(/CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    const lines = (/** @type {string} */ name) => workflow.split('\n').filter((l) => l.includes(name));
    expect(lines('CLOUDFLARE_API_TOKEN')).toHaveLength(1);
    expect(lines('CLOUDFLARE_ACCOUNT_ID')).toHaveLength(1);
    expect(lines('secrets.')).toHaveLength(1);
    expect(deployStep).toContain(lines('CLOUDFLARE_API_TOKEN')[0].trim());
    expect(workflow).not.toMatch(/wrangler (deploy|dev)|--remote/);
  });

  it('smokes the deployed sha after the deploy and before the run record is kept, with no secret and no token', () => {
    const smoke = step(/npm run smoke/);
    expect(smoke).toMatch(/run: npm run smoke -- --expect "\$\{\{ github\.event\.workflow_run\.head_sha \}\}"/);
    expect(smoke).toMatch(/if: steps\.gate\.outputs\.deploy == 'true'/);
    expect(smoke).not.toMatch(/always\(\)|continue-on-error/);
    expect(steps.indexOf(smoke)).toBe(steps.indexOf(step(/npm run deploy/)) + 1);
    expect(steps.indexOf(step(/upload-artifact@/))).toBe(steps.indexOf(smoke) + 1);
    expect(smoke).not.toMatch(/secrets\.|CLOUDFLARE_|GH_TOKEN|github\.token|env:/);
    const above = workflow.slice(0, workflow.indexOf(smoke)).split('\n').slice(0, -1).reverse();
    const comment = above.slice(0, above.findIndex((l) => !/^ {6}#/.test(l))).reverse().map((l) => l.replace(/^ {6}# ?/, '')).join(' ');
    expect(comment).toMatch(/no token/i);
    expect(comment).toMatch(/GH_TOKEN/);
  });

  it('uploads the run records and writes a summary on every outcome, and never commits to main', () => {
    const upload = step(/upload-artifact@/);
    expect(upload).toMatch(/if: \$\{\{ always\(\) && steps\.gate\.outputs\.deploy == 'true' \}\}/);
    expect(upload).toContain('path: ops/runs/');
    expect(workflow).not.toMatch(/git commit|git push origin (main|HEAD)|git push(?! origin refs\/tags)/);
  });

  it('every one-line run, name or if value is valid YAML (no ": " or " #" unquoted)', () => {
    const bad = workflow.split('\n').filter((line) => {
      const m = line.match(/^\s*(?:- )?(?:run|name|if): (.+)$/);
      if (!m || /^['"|>]/.test(m[1])) return false;
      return /: | #/.test(m[1].replace(/\$\{\{.*?\}\}/g, ''));
    });
    expect(bad).toEqual([]);
  });
});

describe('the gate (scripts/deploy-gate.mjs)', () => {
  const SHA = 'a'.repeat(40);
  /** @param {string} name @param {string} status @param {string | null} conclusion */
  const r = (name, status = 'completed', conclusion = 'success') => ({ id: name === 'CI' ? 1 : 2, name, status, conclusion, head_sha: SHA, event: 'push', run_number: 1 });

  it.each([
    ['CI green, the tip, not deployed', [r('CI')], SHA, [], true, /deploying/],
    ['CI still running', [r('CI', 'in_progress', null)], SHA, [], false, /CI.*not finished/],
    ['CI failed', [r('CI', 'completed', 'failure')], SHA, [], false, /CI.*failure/],
    ['CI cancelled', [r('CI', 'completed', 'cancelled')], SHA, [], false, /CI.*cancelled/],
    ['no CI run', [], SHA, [], false, /no CI push run/],
    ['main moved on', [r('CI')], 'b'.repeat(40), [], false, /not main's tip.*newer commit/],
    ['already deployed (a re-run CI saw it green again)', [r('CI')], SHA, [SHA], false, /already deployed/],
  ])('%s', (_name, runs, tip, deployed, deploy, reason) => {
    const d = gateDecision({ sha: SHA, tip, runs, deployed });
    expect(d.deploy).toBe(deploy);
    expect(d.reason).toMatch(reason);
  });
});
