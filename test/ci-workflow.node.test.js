// @ts-check
// The CI workflow's shape, read as text (the repo has no YAML parser and needs none for this).
// - The UI job runs in Playwright's own image, whose browsers must be the ones the locked
//   @playwright/test drives: bump one without the other and every UI test fails to launch.
// - Phase 7 7A: every job always starts. `check` and `eval-gate` carry only the draft guard;
//   the heavy jobs skip by steps, on scripts/ci-changes.mjs's outputs, and run in full when
//   `changes` failed; `main`'s runs never cancel each other.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/ci.yml');

/** The text of one job: from `  <name>:` to the next job at the same indent. @param {string} name */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`ci.yml has no job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
/** The job-level `if:` (two-space job, four-space key). @param {string} text */
const jobIf = (text) => text.match(/^ {4}if: (.+)$/m)?.[1];
/** Each step's text. @param {string} text */
const steps = (text) => text.slice(text.indexOf('\n    steps:\n')).split(/\n {6}- /).slice(1);

const DRAFT = 'github.event.pull_request.draft != true';
const HEAVY = ['full-corpus', 'sc1', 'ui', 'rollover'];

describe('the ui CI job', () => {
  const ui = job('ui');

  it('runs in the Playwright image of the locked @playwright/test version', () => {
    const locked = JSON.parse(read('package-lock.json')).packages['node_modules/@playwright/test'].version;
    expect(ui).toMatch(new RegExp(`image: mcr\\.microsoft\\.com/playwright:v${locked.replaceAll('.', '\\.')}-noble\\n`));
  });

  it('installs nothing with apt', () => {
    expect(ui).not.toMatch(/--with-deps|apt-get/);
  });
});

describe('the workflow is valid YAML', () => {
  // A plain (unquoted) scalar may not hold ": " or " #": GitHub then rejects the whole file and the
  // push shows one failed run with no jobs. The repo has no YAML parser, so this checks the one-line
  // keys that carry shell or text.
  it('no unquoted one-line run, name or if value holds ": " or " #"', () => {
    const bad = workflow.split('\n').map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => {
        const m = line.match(/^\s*(?:- )?(?:run|name|if): (.+)$/);
        if (!m || /^['"|>]/.test(m[1])) return false;
        return /: | #/.test(m[1].replace(/\$\{\{.*?\}\}/g, ''));
      });
    expect(bad.map(({ n, line }) => `${n}: ${line.trim()}`)).toEqual([]);
  });
});

describe('every CI job always starts (Phase 7 7A)', () => {
  it('has no paths-ignore or paths filter on any trigger', () => {
    expect(workflow).not.toMatch(/paths-ignore|^\s+paths:/m);
  });

  it('check and eval-gate carry the draft guard and no path-based if', () => {
    for (const name of ['check', 'eval-gate']) {
      const text = job(name);
      expect(jobIf(text), name).toBe(DRAFT);
      expect(text, name).not.toMatch(/needs:/);
      // No step of theirs is skipped by a diff either.
      for (const step of steps(text)) expect(step, `${name}: ${step.split('\n')[0]}`).not.toMatch(/needs\.changes|outputs\.(code|ui|grid)/);
    }
  });

  it('heavy jobs start whatever `changes` did, and skip only by steps', () => {
    for (const name of HEAVY) {
      const text = job(name);
      expect(jobIf(text), name).toBe(`\${{ !cancelled() && ${DRAFT} }}`);
      expect(text, name).toMatch(/^ {4}needs: changes$/m);
      // A missing output (a failed `changes`) is not 'false', so the job runs.
      const run = text.match(/^ {6}RUN: \$\{\{ needs\.changes\.outputs\.(\w+) != 'false' \}\}$/m);
      expect(run, `${name} has no RUN from a changes output`).not.toBeNull();
      const all = steps(text);
      // A step's `if:` is its first line (`- if: …`) or an indented key.
      const gated = all.filter((s) => /^\s*if: .*\benv\.RUN == 'true'/m.test(s));
      // Every step but the one that says what it decided waits on RUN.
      expect(gated.length, name).toBe(all.length - 1);
      expect(all.filter((s) => !gated.includes(s))[0], name).toMatch(/RUN/);
    }
  });

  it('the ui job reads the ui output and full-corpus its grid from the grid output', () => {
    expect(job('ui')).toMatch(/RUN: \$\{\{ needs\.changes\.outputs\.ui != 'false' \}\}/);
    expect(job('sc1')).toMatch(/RUN: \$\{\{ needs\.changes\.outputs\.code != 'false' \}\}/);
    expect(job('full-corpus')).toMatch(/RUN: \$\{\{ needs\.changes\.outputs\.code != 'false' \}\}/);
    expect(job('full-corpus')).toMatch(/needs\.changes\.outputs\.grid != 'false'/);
  });

  it('`changes` runs scripts/ci-changes.mjs and exports code, ui, grid and rollover', () => {
    const text = job('changes');
    expect(jobIf(text)).toBe(DRAFT);
    expect(text).toMatch(/node scripts\/ci-changes\.mjs/);
    for (const out of ['code', 'ui', 'grid', 'rollover']) expect(text).toMatch(new RegExp(`\\n {6}${out}: \\$\\{\\{ steps\\.\\w+\\.outputs\\.${out} \\}\\}`));
  });

  it('the workflow can list its own runs (actions: read)', () => {
    const permissions = workflow.slice(workflow.indexOf('\npermissions:\n'), workflow.indexOf('\nconcurrency:\n'));
    expect(permissions).toMatch(/\n {2}actions: read\n/);
    expect(permissions).toMatch(/\n {2}contents: read\n/);
  });

  it('runs on main are grouped per sha, so none cancels another; PRs cancel superseded runs', () => {
    const concurrency = workflow.slice(workflow.indexOf('\nconcurrency:\n'), workflow.indexOf('\nenv:\n'));
    const group = concurrency.match(/group: (.+)/)?.[1] ?? '';
    expect(group).toContain('github.sha');
    expect(group).toContain("github.event_name == 'pull_request'");
    expect(concurrency).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it('eval-gate checks the ranking lock against the base, with a tight timeout', () => {
    const text = job('eval-gate');
    expect(text).toMatch(/npm run eval:lock -- --check/);
    const minutes = Number(text.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(15);
  });
});

describe('Phase 7 7E: the rollover job', () => {
  const rollover = job('rollover');

  it('reads the rollover output and runs the rehearsal over the pinned corpus, sha-checked', () => {
    expect(rollover).toMatch(/RUN: \$\{\{ needs\.changes\.outputs\.rollover != 'false' \}\}/);
    expect(rollover).toMatch(/run: node scripts\/rollover\.mjs\n/);
    expect(rollover).toMatch(/sha256sum -c -/);
    expect(rollover).toMatch(/path: \.data\/emb\n/);
    const minutes = Number(rollover.match(/timeout-minutes: (\d+)/)?.[1]);
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('holds no secret but the workflow token, and makes no remote Cloudflare call', () => {
    expect(rollover.match(/\$\{\{ secrets\.\w+ \}\}/g)).toBeNull();
    expect(rollover).not.toMatch(/--remote|wrangler deploy|npm run deploy|CLOUDFLARE_/);
  });
});

describe('Phase 7 7D: CI on the live year', () => {
  const sc1 = job('sc1');
  const full = job('full-corpus');

  it('sc1 restores `current` from its release asset, with no pinned corpus, and the production bundle', () => {
    expect(sc1).toMatch(/npm run corpus -- restore/);
    expect(sc1).not.toMatch(/PINNED_RELEASE|data-2026-2027-20260904|MODULE_INFO/);
    expect(sc1).toMatch(/vectors\.mjs fetch --corpus production/);
    expect(sc1).not.toMatch(/fetch --corpus pinned/);
  });

  it('sc1 checks the data version and the catalogueKey against the asset before its tests', () => {
    const names = steps(sc1);
    const check = names.findIndex((s) => /npm run corpus -- check/.test(s));
    const tests = names.findIndex((s) => /--project sc1 --project sc1-node/.test(s));
    expect(check).toBeGreaterThan(0);
    expect(tests).toBeGreaterThan(check);
  });

  it('sc1 runs both projects into one report, and fails unless every test passed (none skipped)', () => {
    expect(sc1).toMatch(/npx vitest run --project sc1 --project sc1-node --reporter=default --reporter=json --outputFile="\$RUNNER_TEMP\/sc1\.json"/);
    expect(sc1).toMatch(/r\.numPassedTests === 0 \|\| r\.numPassedTests !== r\.numTotalTests/);
  });

  it('full-corpus keeps the pinned corpus and bundle (the eval\'s)', () => {
    expect(full).toMatch(/PINNED_RELEASE: data-2026-2027-20260904/);
    expect(full).toMatch(/vectors\.mjs fetch --corpus pinned/);
  });

  it('npm run test:sc1 runs both projects', () => {
    expect(JSON.parse(read('package.json')).scripts['test:sc1']).toBe('vitest run --project sc1 --project sc1-node');
  });
});
