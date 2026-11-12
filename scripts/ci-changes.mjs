#!/usr/bin/env node
// @ts-check
// CI's one diff rule (Phase 7 7A). The `changes` job runs it and sets four outputs the heavy jobs
// skip by, by steps, never by a job-level `if`:
//   code      full-corpus and sc1: anything outside docs/** and the root *.md files;
//   ui        the UI suite: the paths it covers (UI below);
//   grid      full-corpus's lexical grid in full, else its fixed sample: the paths it covers;
//   rollover  7E's rehearsal job (none yet): as code.
// The base: a PR's base sha; a push to main, the newest main commit whose CI run succeeded and
// which HEAD contains. A workflow_dispatch, an API error, no green run, an unreachable base or a
// failed diff runs everything. A change to this file or to ci.yml runs everything too.
//
//   node scripts/ci-changes.mjs              outputs code, ui, grid, rollover, full and base
//   node scripts/ci-changes.mjs --base-only  outputs base (empty when there is none)
//
// Reads GITHUB_EVENT_NAME, PR_BASE (the PR's base sha), GITHUB_REPOSITORY and GH_TOKEN, and
// writes to GITHUB_OUTPUT. Needs only Node, git and gh.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** A change to the decision itself. */
const SELF = ['.github/workflows/ci.yml', 'scripts/ci-changes.mjs'];
/** What the UI suite covers (the ui job's former diff step). */
const UI = [
  'public', 'src', 'test/ui', 'test/fakes.js', 'scripts/ui-server.mjs', 'scripts/lib.mjs', 'wrangler.jsonc',
  'test/wrangler.ui.jsonc', 'playwright.config.mjs', 'migrations', 'test/fixtures', 'data', 'package.json',
  'package-lock.json', '.nvmrc',
];
/** What the lexical grid covers (full-corpus's former grid step). */
const GRID = ['src', 'migrations', 'scripts', 'test/full', 'vitest.config.mjs', 'test/wrangler.test.jsonc', 'package-lock.json'];

/** @param {string} file @param {string[]} paths */
const under = (file, paths) => paths.some((p) => file === p || file.startsWith(`${p}/`));
/** Docs no heavy suite reads (npm test, which reads some, is in `check`, which never skips). @param {string} file */
const isDocs = (file) => file.startsWith('docs/') || /^[^/]+\.md$/.test(file);

/**
 * @typedef {{ code: boolean, ui: boolean, grid: boolean, rollover: boolean }} Needs
 */

/**
 * Which heavy jobs a list of changed files needs.
 * @param {string[]} files
 * @returns {Needs}
 */
export function decide(files) {
  if (files.some((f) => SELF.includes(f))) return { code: true, ui: true, grid: true, rollover: true };
  const code = files.some((f) => !isDocs(f));
  return { code, ui: files.some((f) => under(f, UI)), grid: files.some((f) => under(f, GRID)), rollover: code };
}

/**
 * @typedef {{
 *   event: string,
 *   prBase?: string,
 *   listGreen: () => string[],
 *   reachable: (sha: string) => boolean,
 *   diff: (base: string) => string[],
 * }} Inputs `listGreen`: head shas of successful CI push runs on main, newest first;
 *   `reachable`: the commit is in the clone and HEAD contains it
 */

/**
 * @param {Inputs} i
 * @returns {{ base: string } | { base: null, reason: string }}
 */
export function resolveBase(i) {
  if (i.event === 'workflow_dispatch') return { base: null, reason: 'a manual run runs everything' };
  if (i.event === 'pull_request') return i.prBase ? { base: i.prBase } : { base: null, reason: 'the PR event names no base sha' };
  let shas;
  try {
    shas = i.listGreen();
  } catch (err) {
    return { base: null, reason: `listing main's green CI runs failed (${/** @type {Error} */ (err).message})` };
  }
  const base = shas.find((s) => i.reachable(s));
  return base ? { base } : { base: null, reason: 'no green CI run on main that HEAD contains' };
}

/**
 * @param {Inputs} i
 * @returns {Needs & { full: boolean, base: string | null, reason: string }}
 */
export function changes(i) {
  const all = { code: true, ui: true, grid: true, rollover: true };
  const r = resolveBase(i);
  if (r.base === null) return { full: true, base: null, reason: r.reason, ...all };
  const { base } = r;
  if (!i.reachable(base)) return { full: true, base, reason: `the base ${base.slice(0, 7)} is not in this clone or not an ancestor of HEAD`, ...all };
  let files;
  try {
    files = i.diff(base);
  } catch (err) {
    return { full: true, base, reason: `git diff against ${base.slice(0, 7)} failed (${/** @type {Error} */ (err).message})`, ...all };
  }
  return { full: false, base, reason: `${files.length} file(s) changed since ${base.slice(0, 7)}`, ...decide(files) };
}

/** @param {string} cmd @param {string[]} args */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} exited ${r.status ?? r.signal}: ${(r.stderr || '').trim().split('\n').pop()}`);
  return r.stdout;
}

/** @returns {Inputs} */
function fromEnvironment() {
  return {
    event: process.env.GITHUB_EVENT_NAME ?? 'workflow_dispatch',
    prBase: process.env.PR_BASE || undefined,
    listGreen: () => {
      const repo = process.env.GITHUB_REPOSITORY;
      if (!repo) throw new Error('GITHUB_REPOSITORY is unset');
      const out = run('gh', ['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', '50', '--json', 'headSha']);
      return JSON.parse(out).map((/** @type {{ headSha: string }} */ x) => x.headSha);
    },
    reachable: (sha) => spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`]).status === 0
      && spawnSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0,
    diff: (base) => run('git', ['diff', '--name-only', base, 'HEAD']).split('\n').filter(Boolean),
  };
}

/** @param {Record<string, string>} values */
function output(values) {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  for (const l of lines) console.log(l);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = fromEnvironment();
  if (process.argv.includes('--base-only')) {
    const r = resolveBase(i);
    const base = r.base && i.reachable(r.base) ? r.base : '';
    console.log(base ? `base ${base}` : `no base: ${'reason' in r ? r.reason : 'not in this clone'}`);
    output({ base });
  } else {
    const r = changes(i);
    console.log(`ci-changes: ${r.full ? `full run: ${r.reason}` : r.reason}`);
    output({ code: String(r.code), ui: String(r.ui), grid: String(r.grid), rollover: String(r.rollover), full: String(r.full), base: r.base ?? '' });
  }
}
