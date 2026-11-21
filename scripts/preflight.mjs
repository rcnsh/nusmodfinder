// @ts-check
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchTraceTags, listTraceTags, newestTag } from './deploy-tag.mjs';
import { pushRuns, runStates } from './github-runs.mjs';
import { RUNS_REL, isNewRunRecord } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const ALLOWED_VARS = ['DENSE_BACKEND'];
export const STARTUP_PROFILE = join(tmpdir(), 'nusmodfinder-startup.cpuprofile');

export const OPTIONAL_CHECKS = /** @type {const} */ ([
  { name: 'corpus manifest', module: 'scripts/corpus.mjs' },
  { name: 'year check', module: 'scripts/year.mjs' },
]);

export const PER_CORPUS_NG_FILE = 'data/ng-unscheduled.json';

/** @param {string} path */
export const isSourceInput = (path) => (path.startsWith('data/ng-') && path !== PER_CORPUS_NG_FILE) || path.startsWith('scripts/ng-overlay/');

export const FULL_RECORD = { script: 'year check', mode: 'full' };

/**
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<{ code: number, stdout: string }>} Exec
 * @typedef {import('./vectors-manifest.mjs').ManifestEntry} ManifestEntry
 * @typedef {{ entry: ManifestEntry, header: import('../src/vector-bundle.js').BundleHeader, sha256: string, shim: string,
 *   others: string[] }} DeployBundle
 * @typedef {{ name: string, status: 'ok' | 'failed' | 'skipped' | 'not run', message: string }} CheckOutcome
 * @typedef {{ head: string, tip: string, short: string, subject: string, bundle: DeployBundle | null, committed: string | null, behind: boolean }} PreflightState
 * @typedef {{
 *   exec: Exec, log: (m: string) => void, behindOk: boolean,
 *   bundle: () => Promise<DeployBundle>, committedDataVersion: () => Promise<string>, vars: () => Promise<Record<string, unknown>>,
 *   moduleExists?: (rel: string) => boolean, loadModule?: (rel: string) => Promise<any>,
 * }} PreflightDeps
 */

/**
 * @param {Exec} exec
 * @param {string} [rev]
 */
export async function sourceInputsHash(exec, rev = 'HEAD') {
  const r = await exec('git', ['ls-tree', '-r', rev]);
  if (r.code !== 0) throw new Error(`git ls-tree failed (exit ${r.code})`);
  const lines = r.stdout.split('\n').filter((l) => l && isSourceInput(l.slice(l.indexOf('\t') + 1))).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * @param {boolean} ok
 * @param {string} message
 */
const answer = (ok, message) => ({ ok, message });

/**
 * @param {Exec} exec
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function sourceInputsCheck(exec) {
  /** @param {string[]} args */
  const git = async (args) => { const r = await exec('git', args); return { ...r, out: r.stdout.trim() }; };
  if (!(await fetchTraceTags(exec))) return answer(false, 'could not fetch the deploy/* and rollback/* tags from origin, so what is live is unknown.');
  const live = newestTag(await listTraceTags(exec));
  if (!live) return answer(false, 'no deploy/* or rollback/* tag says what is live, so a change to source-derived inputs can\'t be told apart (docs/operations.md "Deploying").');
  const diff = await git(['diff', '--name-only', '--no-renames', live.commit, 'HEAD']);
  if (diff.code !== 0) return answer(false, `git diff against the live tag ${live.name} failed.`);
  const changed = diff.out.split('\n').filter((p) => p && isSourceInput(p));
  if (!changed.length) return answer(true, `no source-derived input changed since ${live.name}`);
  const hash = await sourceInputsHash(exec);
  const listed = await git(['ls-tree', '-r', '--name-only', 'HEAD', '--', RUNS_REL]);
  const candidates = listed.code === 0 ? listed.out.split('\n').filter((p) => p.includes('-year-check-')) : [];
  for (const path of candidates) {
    const shown = await git(['show', `HEAD:${path}`]);
    /** @type {any} */
    let r = null;
    try { r = JSON.parse(shown.out); } catch { continue; }
    if (r?.script === FULL_RECORD.script && r?.outcome === 'ok' && r?.details?.mode === FULL_RECORD.mode && r?.details?.sourceInputsHash === hash
      && r?.details?.ngList?.result === 'byte-identical') {
      return answer(true, `${changed.length} source-derived input(s) changed since ${live.name}; ${path} covers them`);
    }
  }
  return answer(false, `HEAD changes source-derived inputs since ${live.name} (${changed.join(', ')}), so it needs a committed \`year check --full\` `
    + `run record (on the Mac with the sources key) for their hash ${hash.slice(0, 12)}…; none at HEAD matches.`);
}

/**
 * @param {PreflightDeps} deps
 * @returns {Promise<{ ok: boolean, results: CheckOutcome[], state: PreflightState }>}
 */
export async function runPreflight(deps) {
  const { exec, log } = deps;
  const moduleExists = deps.moduleExists ?? ((rel) => existsSync(join(ROOT, rel)));
  const loadModule = deps.loadModule ?? ((rel) => import(pathToFileURL(join(ROOT, rel)).href));
  /** @type {PreflightState} */
  const state = { head: '', tip: '', short: '', subject: '', bundle: null, committed: null, behind: false };
  /** @param {string[]} args */
  const git = async (args) => { const r = await exec('git', args); return { ...r, out: r.stdout.trim() }; };

  /** @type {{ name: string, run: () => Promise<{ ok: boolean, message: string, skipped?: boolean }> }[]} */
  const checks = [
    { name: 'git', run: async () => {
      const status = await git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
      if (status.code !== 0) return answer(false, '`git status` failed.');
      const dirt = status.out.split('\n').filter((l) => l && !isNewRunRecord(l));
      if (dirt.length) return answer(false, `the working tree is not clean:\n${dirt.join('\n')}\nCommit (via a PR to main) or discard these first.`);
      const flags = await git(['ls-files', '-v']);
      if (flags.code !== 0) return answer(false, '`git ls-files` failed.');
      const hidden = flags.out.split('\n').filter((l) => /^([a-z]|S) /.test(l));
      if (hidden.length) return answer(false, `files are marked assume-unchanged or skip-worktree, so local edits may be hidden:\n${hidden.join('\n')}`);
      const fetched = await git(['fetch', '--quiet', 'origin', 'main']);
      if (fetched.code !== 0) return answer(false, 'could not fetch origin/main to check HEAD is pushed.');
      const head = await git(['rev-parse', 'HEAD']);
      const tip = await git(['rev-parse', 'refs/remotes/origin/main']);
      if (head.code !== 0 || tip.code !== 0) return answer(false, '`git rev-parse` failed.');
      state.head = head.out;
      state.tip = tip.out;
      const onMain = await git(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']);
      if (onMain.code === 1) return answer(false, `HEAD ${head.out} is not on origin/main. Merge it to main first.`);
      if (onMain.code !== 0) return answer(false, '`git merge-base` failed.');
      state.short = (await git(['rev-parse', '--short', 'HEAD'])).out;
      state.subject = (await git(['log', '-1', '--format=%s'])).out;
      if (head.out !== tip.out) {
        state.behind = true;
        if (!deps.behindOk) {
          return answer(false, `HEAD ${head.out} is behind origin/main (${tip.out}). Deploy the tip; or, when D1 was already written `
            + 'for HEAD and an unrelated PR merged since, pass --behind-ok (it is logged).');
        }
        log(`deploy: note: HEAD ${head.out} is behind origin/main (${tip.out}); deploying it under --behind-ok.`);
      }
      return answer(true, `HEAD ${state.short} is on origin/main${state.behind ? ' (behind the tip, --behind-ok)' : ', at its tip'}`);
    } },
    { name: 'ci', run: async () => {
      /** @type {import('./github-runs.mjs').WorkflowRun[]} */
      let runs;
      try { runs = await pushRuns({ sha: state.head, exec }); } catch (err) { return answer(false, /** @type {Error} */ (err).message); }
      const { ok, states } = runStates(runs, state.head);
      return answer(ok, ok ? `CI run ${states[0].run?.id} succeeded`
        : states.filter((s) => s.state !== 'green').map((s) => s.message).join(' '));
    } },
    { name: 'vars', run: async () => {
      /** @type {Record<string, unknown>} */
      let vars;
      try { vars = await deps.vars(); } catch (err) { return answer(false, `could not read wrangler.jsonc's vars, so what ships is unknown: ${/** @type {Error} */ (err).message}`); }
      const extra = Object.keys(vars).filter((k) => !ALLOWED_VARS.includes(k));
      return extra.length ? answer(false, `wrangler.jsonc vars hold ${extra.join(', ')}; only ${ALLOWED_VARS.join(', ')} may ship (test-only switches never deploy).`)
        : answer(true, `only ${ALLOWED_VARS.join(', ')}`);
    } },
    { name: 'bundle', run: async () => {
      /** @type {DeployBundle} */
      let b;
      try { b = await deps.bundle(); } catch (err) { return answer(false, /** @type {Error} */ (err).message); }
      if (b.entry.corpus !== 'production' || b.header.corpus !== 'production' || b.others.includes(b.sha256)) {
        return answer(false, `the bundle is the ${b.header.corpus} bundle (sha256 ${b.sha256.slice(0, 12)}); only the production bundle deploys.`);
      }
      if (/\s/.test(b.shim)) return answer(false, `the bundle path has whitespace (${b.shim}); wrangler check startup --args splits on spaces.`);
      const committed = await deps.committedDataVersion();
      if (b.entry.dataVersion !== committed || b.header.dataVersion !== committed) {
        return answer(false, `the production bundle is for data version ${b.entry.dataVersion}, src/data-version.json says ${committed}.`);
      }
      state.bundle = b;
      state.committed = committed;
      return answer(true, `production, ${b.entry.count} rows, data version ${committed}, sha256 ${b.sha256.slice(0, 12)}`);
    } },
    ...OPTIONAL_CHECKS.map((c) => ({ name: c.name, run: async () => {
      if (!moduleExists(c.module)) return { ok: true, skipped: true, message: `${c.module} is absent` };
      try {
        const mod = await loadModule(c.module);
        if (typeof mod?.preflight !== 'function') return answer(false, `${c.module} exports no preflight() check.`);
        const r = await mod.preflight({ exec, head: state.head, log });
        return answer(r?.ok === true, String(r?.message ?? ''));
      } catch (err) {
        return answer(false, `${c.module}: ${/** @type {Error} */ (err).message}`);
      }
    } })),
    { name: 'source inputs', run: () => sourceInputsCheck(exec) },
    { name: 'startup', run: async () => {
      const b = /** @type {DeployBundle} */ (state.bundle);
      const check = await exec('npx', ['wrangler', 'check', 'startup', '--outfile', STARTUP_PROFILE, `--args=--alias vectors-bundle:${b.shim}`], { stream: true });
      return check.code === 0 ? answer(true, 'wrangler check startup passed') : answer(false, `wrangler check startup failed (exit ${check.code}).`);
    } },
  ];

  /** @type {CheckOutcome[]} */
  const results = [];
  let ok = true;
  for (const c of checks) {
    if (!ok) { results.push({ name: c.name, status: 'not run', message: '' }); continue; }
    const r = await c.run();
    const status = r.skipped ? 'skipped' : r.ok ? 'ok' : 'failed';
    results.push({ name: c.name, status, message: r.message });
    if (status === 'failed') ok = false;
    else log(`deploy: preflight: ${c.name}: ${status === 'skipped' ? `skipped (${r.message})` : `ok (${r.message})`}`);
  }
  return { ok, results, state };
}
