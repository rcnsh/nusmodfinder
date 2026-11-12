// @ts-check
// The deploy's preflight (Phase 7 7B): every check but D1's, for HEAD, in order, stopping at the
// first that fails. `npm run deploy -- --preflight` runs it alone (before any D1 write, per the
// runbook) and `npm run deploy` runs it first. It writes nothing remote: it reads git, GitHub's
// runs for HEAD and the release asset of the bundle, and runs `wrangler check startup` locally.
//
//   git             clean tree (new run records aside), nothing hidden, HEAD on origin/main and
//                   at its tip (or --behind-ok)
//   ci              HEAD's own CI and Findings push runs succeeded
//   vars            wrangler.jsonc's vars hold only DENSE_BACKEND
//   bundle          the production bundle, sha-checked, at the committed data version
//   corpus manifest 7D's check (scripts/corpus.mjs), skipped while that module is absent
//   year check      7E's CI mode (scripts/year.mjs), skipped while that module is absent
//   source inputs   when HEAD changes a source-derived input since the live tag, a committed
//                   `year check --full` record (7E) for those inputs' hash
//   startup         `wrangler check startup` with the bundle aliased in
//
// An optional check's module exports `preflight({ exec, head, log })`, answering
// `{ ok, message }`. 7D and 7E add their modules; nothing here changes.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchTraceTags, listTraceTags, newestTag } from './deploy-tag.mjs';
import { pushRuns, runStates } from './github-runs.mjs';
import { RUNS_REL, isNewRunRecord } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The only var the deployed Worker may have (docs/plans/phase4.md §4, gate 2). */
export const ALLOWED_VARS = ['DENSE_BACKEND'];
/** Where the local startup pre-check writes its CPU profile (not the clean working tree). */
export const STARTUP_PROFILE = join(tmpdir(), 'nusmodfinder-startup.cpuprofile');

/** The checks whose module another workstream adds; absent, they are skipped and said so. */
export const OPTIONAL_CHECKS = /** @type {const} */ ([
  { name: 'corpus manifest', module: 'scripts/corpus.mjs', owner: '7D' },
  { name: 'year check', module: 'scripts/year.mjs', owner: '7E' },
]);

/**
 * Source-derived inputs (7E): what NUS's documents decide. A change to one needs a committed
 * `year check --full` record. 7E's quote index adds the quoted NUS sentences.
 * @param {string} path
 */
export const isSourceInput = (path) => path.startsWith('data/ng-') || path.startsWith('scripts/ng-overlay/');

/** The run record script that `year check --full` writes (7E), and the mode it records. */
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
 * The hash of HEAD's source-derived inputs: sha256 over their `git ls-tree` lines (mode, type,
 * object, path), so it names exactly the committed bytes. 7E's `year check --full` records it.
 * @param {Exec} exec @param {string} [rev]
 */
export async function sourceInputsHash(exec, rev = 'HEAD') {
  const r = await exec('git', ['ls-tree', '-r', rev]);
  if (r.code !== 0) throw new Error(`git ls-tree failed (exit ${r.code})`);
  const lines = r.stdout.split('\n').filter((l) => l && isSourceInput(l.slice(l.indexOf('\t') + 1))).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** A check's answer. @param {boolean} ok @param {string} message */
const answer = (ok, message) => ({ ok, message });

/**
 * Runs the checks. Stops at the first failure; the rest are `not run`.
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
      // --untracked-files=all overrides status.showUntrackedFiles; ls-files -v catches files
      // hidden by assume-unchanged (lower-case tag) or skip-worktree (S).
      const status = await git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
      if (status.code !== 0) return answer(false, '`git status` failed.');
      // Phase 7 7C: new run records (this run's own and earlier ones not yet committed) are not dirt.
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
      return answer(ok, ok ? `CI run ${states[0].run?.id} and Findings run ${states[1].run?.id} succeeded`
        : states.filter((s) => s.state !== 'green').map((s) => s.message).join(' '));
    } },
    { name: 'vars', run: async () => {
      const extra = Object.keys(await deps.vars()).filter((k) => !ALLOWED_VARS.includes(k));
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
      if (!moduleExists(c.module)) return { ok: true, skipped: true, message: `${c.module} is absent; ${c.owner} adds it` };
      try {
        const mod = await loadModule(c.module);
        if (typeof mod?.preflight !== 'function') return answer(false, `${c.module} exports no preflight() check.`);
        const r = await mod.preflight({ exec, head: state.head, log });
        return answer(r?.ok === true, String(r?.message ?? ''));
      } catch (err) {
        return answer(false, `${c.module}: ${/** @type {Error} */ (err).message}`);
      }
    } })),
    { name: 'source inputs', run: async () => {
      if (!(await fetchTraceTags(exec))) return answer(false, 'could not fetch the deploy/* and rollback/* tags from origin, so what is live is unknown.');
      const live = newestTag(await listTraceTags(exec));
      if (!live) return answer(false, 'no deploy/* or rollback/* tag says what is live, so a change to source-derived inputs can\'t be told apart; push the back-filled tags (docs/REFERENCE.md "Deploying").');
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
        if (r?.script === FULL_RECORD.script && r?.outcome === 'ok' && r?.details?.mode === FULL_RECORD.mode && r?.details?.sourceInputsHash === hash) {
          return answer(true, `${changed.length} source-derived input(s) changed since ${live.name}; ${path} covers them`);
        }
      }
      return answer(false, `HEAD changes source-derived inputs since ${live.name} (${changed.join(', ')}), so it needs a committed \`year check --full\` `
        + `run record (7E, on the Mac with the sources key) for their hash ${hash.slice(0, 12)}…; none at HEAD matches.`);
    } },
    { name: 'startup', run: async () => {
      const b = /** @type {DeployBundle} */ (state.bundle);
      // `--args=…` as one argv entry: given as two, wrangler parses the value's `--alias` as its
      // own flag and fails with "Unknown arguments".
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
