// @ts-check
// The deploy's preflight: every check but D1's, for HEAD, in order, stopping at the
// first that fails. `npm run deploy -- --preflight` runs it alone (before any D1 write, per the
// runbook) and `npm run deploy` runs it first. It writes nothing remote: it reads git, GitHub's
// runs for HEAD and the release asset of the bundle, and runs `wrangler check startup` locally.
//
//   git             clean tree (new run records aside), nothing hidden, HEAD on origin/main and
//                   at its tip (or --behind-ok)
//   ci              HEAD's own CI push run succeeded
//   vars            wrangler.jsonc's vars hold only DENSE_BACKEND
//   bundle          the production bundle, sha-checked, at the committed data version
//   corpus manifest scripts/corpus.mjs `preflight()`: restores `current` (gh, sha-checked), then
//                   `npm run corpus -- check`: the data version, catalogueKey and catalogue files follow it
//   year check      the CI mode of scripts/year.mjs (`preflight()`): the year's sources agree, no
//                   stub, an oracle; the sources archive may still be pending
//   source inputs   when HEAD changes a source-derived input since the live tag, a committed
//                   `year check --full` record for those inputs' hash (sourceInputsCheck)
//   startup         `wrangler check startup` with the bundle aliased in
//
// A module check's module exports `preflight({ exec, head, log })`, answering
// `{ ok, message }`; a missing module is skipped and said so.
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchTraceTags, listTraceTags, newestTag } from './deploy-tag.mjs';
import { pushRuns, runStates } from './github-runs.mjs';
import { RUNS_REL, isNewRunRecord } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The only var the deployed Worker may have: test-only switches never deploy. */
export const ALLOWED_VARS = ['DENSE_BACKEND'];
/** Where the local startup pre-check writes its CPU profile (not the clean working tree). */
export const STARTUP_PROFILE = join(tmpdir(), 'nusmodfinder-startup.cpuprofile');

/** The checks that live in another script's module; absent, they are skipped and said so. */
export const OPTIONAL_CHECKS = /** @type {const} */ ([
  { name: 'corpus manifest', module: 'scripts/corpus.mjs' },
  { name: 'year check', module: 'scripts/year.mjs' },
]);

/** The one data/ng-* file built from the corpus, not from NUS's documents. */
export const PER_CORPUS_NG_FILE = 'data/ng-unscheduled.json';

/**
 * Source-derived inputs: what NUS's documents decide. A change to one needs a committed
 * `year check --full` record. The quoted NUS sentences in src/ and public/ count through the quote
 * index in data/ng-sources-<year>.json: `year check` fails when a quote is no longer in its file, so
 * changing one means changing the index, a source-derived input.
 *
 * Not data/ng-unscheduled.json: it follows the production corpus (rebuilt with the bundle), so
 * a corpus-only refresh changes it with no source changing, and `year check --full` doesn't check
 * it (`npm run corpus -- check` and `build-ng-unscheduled.mjs --check` do).
 * @param {string} path
 */
export const isSourceInput = (path) => (path.startsWith('data/ng-') && path !== PER_CORPUS_NG_FILE) || path.startsWith('scripts/ng-overlay/');

/** The run record script that `year check --full` writes, and the mode it records. */
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
 * object, path), so it names exactly the committed bytes. `year check --full` records it.
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
 * The "source inputs" check: when HEAD changes a source-derived input since what is live (the
 * newest deploy/* or rollback/* tag), a `year check --full` run record committed at HEAD must
 * carry an ok outcome, HEAD's sourceInputsHash and a byte-identical NG list (`details.ngList`; a
 * record without it never re-extracted the NG list). A hand-edited rules file has a hash no
 * record names, so it can't pass.
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
    // A record without details.ngList never re-extracted the NG list, so it vouches for nothing.
    if (r?.script === FULL_RECORD.script && r?.outcome === 'ok' && r?.details?.mode === FULL_RECORD.mode && r?.details?.sourceInputsHash === hash
      && r?.details?.ngList?.result === 'byte-identical') {
      return answer(true, `${changed.length} source-derived input(s) changed since ${live.name}; ${path} covers them`);
    }
  }
  return answer(false, `HEAD changes source-derived inputs since ${live.name} (${changed.join(', ')}), so it needs a committed \`year check --full\` `
    + `run record (on the Mac with the sources key) for their hash ${hash.slice(0, 12)}…; none at HEAD matches.`);
}

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
      // New run records (this run's own and earlier ones not yet committed) are not dirt.
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
