// @ts-check
// The only supported way to deploy, from the Mac or from GitHub Actions (.github/workflows/deploy.yml):
//
//   npm run deploy                     preflight, guard, upload, startup gate, promote, tag, triggers
//   npm run deploy -- --preflight      the preflight alone (before any D1 write, per the runbook)
//   npm run deploy -- --behind-ok      deploy a HEAD behind origin/main's tip (logged)
//
// 1. The preflight (scripts/preflight.mjs, Phase 7 7B): every check but D1's. The git checks
//    (clean tree, nothing hidden, HEAD on origin/main at its tip unless --behind-ok), HEAD's own
//    CI and Findings push runs green, the vars (only DENSE_BACKEND), the production bundle at
//    the committed data version (Phase 3 3-0, B-9, B2-4), 7D's and 7E's checks when their
//    modules exist, a `year check --full` record when source-derived inputs changed, and
//    `wrangler check startup` with the bundle aliased in.
// 2. The guard (scripts/guard.mjs; B-2, B3-4): D1's (code, text_hash) pairs must hash to the
//    bundle's rowsKey, and D1's data version must be the committed one. Read over D1's REST
//    query endpoint (scripts/d1-rest.mjs; ~6.8k rows), the code GET /admin/hashes runs, so no
//    Worker session and no secret is bound anywhere. In Actions a mismatch means a data change
//    D1 doesn't hold yet: the job fails and says the re-ingest runs on the Mac.
// 3. `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`; the startup gate
//    (B-4) refuses to promote above 200 ms or with no reported time.
// 4. The intent record: the version id, the previous one (`wrangler deployments status`), the
//    data version and the startup time, in the run record and printed, before the promote.
// 5. `wrangler versions deploy <id>@100%`; then the annotated tag
//    `deploy/<UTC time>-<id8>` on HEAD with the same fields, pushed (a failed push prints the
//    retry; the version is live either way); then `wrangler triggers deploy` (ADR 0009's Custom
//    Domain). A SIGINT, SIGTERM or SIGHUP after the promote finishes the tag and the record first.
//
// Every run writes one run record (scripts/run-record.mjs) on every exit path; in Actions it
// also appends a job summary.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { productionD1 } from './d1-read.mjs';
import { createAndPushTag, pushCommand, tagArgs, tagName } from './deploy-tag.mjs';
import { GUARD_CHECKS, runGuard } from './guard.mjs';
import { ALLOWED_VARS, STARTUP_PROFILE, runPreflight } from './preflight.mjs';
import { startRun } from './run-record.mjs';

export { ALLOWED_VARS, STARTUP_PROFILE };

// Cloudflare caps version messages at 100 characters.
const MAX_MESSAGE = 100;
/** The startup gate (docs/plans/phase3.md 3-0, B-4); the platform limit is 1 s. */
export const MAX_STARTUP_MS = 200;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_VERSION_PATH = join(ROOT, 'src/data-version.json');
/** The Worker deploy acts on (wrangler.jsonc `name`), for its run record. */
const WORKER_NAME = 'nusmodfinder';
/** Exit codes for the signals deploy finishes on. */
const SIGNAL_CODES = /** @type {const} */ ({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 });

/**
 * The `vars` object of wrangler.jsonc (flat, so the first `{...}` after the key is all of it).
 * @param {string} [path]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function wranglerVars(path = join(ROOT, 'wrangler.jsonc')) {
  const text = await readFile(path, 'utf8');
  const m = /"vars"\s*:\s*(\{[^{}]*\})/.exec(text);
  return m ? JSON.parse(m[1]) : {};
}

/**
 * @typedef {{ code: number, stdout: string }} ExecResult
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<ExecResult>} Exec
 *   Runs a command without a shell. With `stream`, stdout is also echoed live.
 * @typedef {import('./preflight.mjs').DeployBundle} DeployBundle
 * @typedef {Pick<NodeJS.EventEmitter, 'on' | 'off'>} Signals
 */

/** @type {Exec} */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (opts.stream) process.stdout.write(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

/**
 * The production bundle, checked (scripts/vectors-manifest.mjs).
 * @returns {Promise<DeployBundle>}
 */
async function productionBundle() {
  const { fetchBundle, loadCheckedBundle, readVectorsManifest } = await import('./vectors-manifest.mjs');
  const manifest = await readVectorsManifest();
  const entry = manifest.bundles.production;
  if (!entry) throw new Error('data/vectors.json has no production bundle (node scripts/vectors.mjs build --corpus production, runbook step 1).');
  const shim = await fetchBundle('production', { log: () => {} });
  const { bundle, bytes } = await loadCheckedBundle(entry);
  const { createHash } = await import('node:crypto');
  return {
    entry, header: bundle.header, sha256: createHash('sha256').update(bytes).digest('hex'), shim,
    others: [manifest.bundles.fixture?.sha256, manifest.bundles.pinned?.sha256].filter((s) => typeof s === 'string'),
  };
}

/**
 * @typedef {{
 *   argv?: string[], exec?: Exec, log?: (msg: string) => void, error?: (msg: string) => void,
 *   bundle?: () => Promise<DeployBundle>, d1?: () => Promise<import('./d1-rest.mjs').D1Client>,
 *   committedDataVersion?: () => Promise<string>, vars?: () => Promise<Record<string, unknown>>, runsDir?: string,
 *   now?: () => Date, env?: Record<string, string | undefined>, signals?: Signals, exit?: (code: number) => void,
 *   guardChecks?: import('./guard.mjs').GuardCheck[],
 *   moduleExists?: (rel: string) => boolean, loadModule?: (rel: string) => Promise<any>,
 * }} DeployDeps
 * @typedef {{ uploaded: boolean, promoted: boolean, signalled: { signal: string, code: number } | null, lastError: string | null }} Stage
 */

/** @param {string[]} argv */
function parseArgs(argv) {
  const known = new Set(['--preflight', '--behind-ok']);
  const unknown = argv.filter((a) => !known.has(a));
  return { preflight: argv.includes('--preflight'), behindOk: argv.includes('--behind-ok'), unknown };
}

/**
 * The deploy, with its run record: one record on every exit path, a throw included.
 * @param {DeployDeps} [deps]
 * @returns {Promise<number>} The process exit code.
 */
export async function deploy(deps = {}) {
  const argv = deps.argv ?? process.argv.slice(2);
  const errorOut = deps.error ?? console.error;
  const args = parseArgs(argv);
  if (args.unknown.length) {
    errorOut(`deploy: unknown argument(s) ${args.unknown.join(' ')}. Usage: npm run deploy [-- --preflight] [-- --behind-ok]`);
    return 2;
  }
  const record = startRun(args.preflight ? 'deploy:preflight' : 'deploy', { target: WORKER_NAME, args: argv, dir: deps.runsDir, ...(deps.now ? { now: deps.now } : {}) });
  /** @type {Stage} */
  const stage = { uploaded: false, promoted: false, signalled: null, lastError: null };
  const signals = deps.signals ?? process;
  const exit = deps.exit ?? ((/** @type {number} */ c) => process.exit(c));
  const log = deps.log ?? console.log;
  const error = (/** @type {string} */ m) => { stage.lastError = m.split('\n')[0]; errorOut(m); };
  // Signals are handled here, not by the record's guard: after the promote they must not stop
  // the tag and the record from being written.
  const unguard = record.guardExit(/** @type {any} */ (signals), { signals: false });
  const handlers = /** @type {[keyof typeof SIGNAL_CODES, () => void][]} */ (Object.keys(SIGNAL_CODES).map((sig) => [sig, () => {
    const code = SIGNAL_CODES[/** @type {keyof typeof SIGNAL_CODES} */ (sig)];
    if (stage.signalled) return;
    stage.signalled = { signal: sig, code };
    if (!stage.promoted) {
      record.finish('interrupted', { exitCode: code, message: sig });
      exit(code);
      return;
    }
    errorOut(`deploy: ${sig} after the promote: finishing the tag and the run record before exiting.`);
  }]));
  for (const [sig, h] of handlers) signals.on(sig, h);
  /** Each wrangler command but the local startup check and the token read calls Cloudflare's API. @type {Exec} */
  const exec = (cmd, a, opts) => {
    if (cmd === 'npx' && a[0] === 'wrangler' && a[1] !== 'check' && a[1] !== 'auth') record.request(`wrangler ${a.slice(1, 3).join(' ')}`);
    return (deps.exec ?? run)(cmd, a, opts);
  };
  const env = deps.env ?? process.env;
  try {
    const code = await deployRun({ ...deps, exec, log, error, env }, args, record, stage);
    const outcome = code === 0 ? 'ok' : stage.signalled && stage.promoted ? 'interrupted' : stage.uploaded ? 'failed' : 'refused';
    record.finish(outcome, { exitCode: code, message: code === 0 ? null : stage.lastError });
    if (code === 0) log(`deploy: run record ${record.path}`);
    return code;
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    for (const [sig, h] of handlers) signals.off(sig, h);
    unguard();
    summarize(env, record);
  }
}

/**
 * GitHub Actions' job summary: the outcome, the version, the tag and the checks.
 * @param {Record<string, string | undefined>} env
 * @param {import('./run-record.mjs').RunRecord} record
 */
function summarize(env, record) {
  if (!env.GITHUB_STEP_SUMMARY || !record.finished) return;
  const d = record.data;
  const finished = record.result ?? { outcome: '?', exitCode: null, message: null };
  const v = d.versions;
  const preflight = /** @type {{ name: string, status: string }[] | undefined} */ (d.details.preflight);
  const rows = [
    ['outcome', `${finished.outcome} (exit ${finished.exitCode ?? '?'})`],
    ['message', finished.message ?? ''],
    ['commit', d.commit.sha ?? ''],
    ['version', String(v.versionId ?? '')],
    ['previous version', String(v.previousVersionId ?? '')],
    ['tag', String(v.deployTag ?? '')],
    ['data version', String(v.dataVersion ?? '')],
    ['startup', v.startupMs === undefined ? '' : `${v.startupMs} ms`],
    ['D1 rows read', d.read.map((r) => `${r.actual ?? '?'} (${r.what})`).join('; ')],
    ['preflight', (preflight ?? []).map((c) => `${c.name} ${c.status}`).join(', ')],
    ['run record', record.path ? relative(ROOT, record.path) : ''],
  ].filter(([, val]) => val);
  const text = [`### ${d.script}: ${finished.outcome}`, '', '| | |', '|---|---|', ...rows.map(([k, val]) => `| ${k} | ${String(val).replaceAll('|', '\\|')} |`), ''].join('\n');
  try { appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`); } catch { /* a summary is a convenience */ }
}

/**
 * @param {DeployDeps & { exec: Exec, log: (m: string) => void, error: (m: string) => void, env: Record<string, string | undefined> }} deps
 * @param {ReturnType<typeof parseArgs>} args
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {Stage} stage
 * @returns {Promise<number>}
 */
async function deployRun(deps, args, record, stage) {
  const { exec, log, error, env } = deps;
  const ci = env.GITHUB_ACTIONS === 'true';
  if (args.behindOk) record.detail('behindOk', true);

  // 1. The preflight.
  const pre = await runPreflight({
    exec, log, behindOk: args.behindOk,
    bundle: deps.bundle ?? productionBundle,
    committedDataVersion: deps.committedDataVersion ?? (async () => String(JSON.parse(await readFile(DATA_VERSION_PATH, 'utf8')).version)),
    vars: deps.vars ?? wranglerVars,
    ...(deps.moduleExists ? { moduleExists: deps.moduleExists } : {}), ...(deps.loadModule ? { loadModule: deps.loadModule } : {}),
  });
  record.detail('preflight', pre.results);
  if (!pre.ok) {
    const failed = /** @type {import('./preflight.mjs').CheckOutcome} */ (pre.results.find((r) => r.status === 'failed'));
    error(`deploy: refusing (preflight: ${failed.name}): ${failed.message}`);
    return 1;
  }
  if (args.preflight) {
    log(`deploy: preflight passed for ${pre.state.short}; D1 was not read (the guard runs at deploy). Run record: ${record.dir}`);
    return 0;
  }
  const { head, short, subject } = pre.state;
  const b = /** @type {DeployBundle} */ (pre.state.bundle);
  const committed = /** @type {string} */ (pre.state.committed);

  // 2. The guard, over D1's REST query.
  /** @type {import('./d1-rest.mjs').D1Client | null} */
  let client = null;
  /** @type {Awaited<ReturnType<typeof runGuard>>} */
  let guard;
  const READ = 'D1 rows (the guard, over the D1 REST query: modules and the schema check)';
  try {
    client = await (deps.d1 ?? (() => productionD1({ env, exec })))();
    guard = await runGuard({ client, bundle: b, committed, checks: deps.guardChecks ?? GUARD_CHECKS });
  } catch (err) {
    record.read(READ, { estimate: b.entry.count, actual: client?.rowsRead ?? null });
    error(`deploy: refusing, could not read D1's hashes: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
  record.read(READ, { estimate: b.entry.count, actual: client.rowsRead });
  record.detail('guard', guard.results.map((r) => ({ name: r.name, ok: r.ok, d1: r.d1, expected: r.expected })));
  log(`deploy: guard: ${guard.modules} modules, ${client.rowsRead} D1 rows read (the REST answers' meta.rows_read; in the run record).`);
  if (!guard.ok) {
    const lines = guard.results.filter((r) => !r.ok).map((r) => `deploy: refusing, ${r.message}`);
    if (ci) {
      lines.push('deploy: this is a data change D1 doesn\'t hold yet. The re-ingest runs on the Mac through the runbook (docs/REFERENCE.md '
        + '"Re-ingesting": preflight, d1:bookmark, ingest, verify --pre-deploy), and that deploy runs there. Nothing was deployed.');
    }
    error(lines.join('\n'));
    return 1;
  }

  // 3. Upload and the startup gate.
  record.version('tag', short);
  record.version('dataVersion', committed);
  const message = `${short} ${subject}`.slice(0, MAX_MESSAGE);
  const alias = `vectors-bundle:${b.shim}`;
  log(`deploy: bundle ${relative(ROOT, b.shim)} (${b.entry.count} rows, data version ${committed}, sha256 ${b.sha256.slice(0, 12)})`);
  log(`deploy: wrangler versions upload --tag ${short} --message "${message}"`);
  stage.uploaded = true;
  const upload = await exec('npx', ['wrangler', 'versions', 'upload', '--tag', short, '--message', message, '--alias', alias], { stream: true });
  if (upload.code !== 0) { error(`deploy: wrangler versions upload failed (exit ${upload.code}).`); return upload.code; }
  const versionId = upload.stdout.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1];
  const startup = upload.stdout.match(/Worker Startup Time:\s*(\d+(?:\.\d+)?)\s*ms/i)?.[1];
  if (!versionId) { error('deploy: refusing to promote, no version id in wrangler versions upload output.'); return 1; }
  record.version('versionId', versionId);
  if (startup !== undefined) record.version('startupMs', Number(startup));
  if (startup === undefined) {
    error(`deploy: refusing to promote ${versionId}: wrangler reported no startup time. It is uploaded but serves no traffic.`);
    return 1;
  }
  if (Number(startup) > MAX_STARTUP_MS) {
    error(`deploy: refusing to promote ${versionId}: startup ${startup} ms > ${MAX_STARTUP_MS} ms. It is uploaded but serves no traffic.`);
    return 1;
  }
  log(`deploy: version ${versionId} startup ${startup} ms (gate ${MAX_STARTUP_MS} ms)`);

  // 4. The intent record: what is live now is the rollback target.
  const status = await exec('npx', ['wrangler', 'deployments', 'status', '--json']);
  /** @type {string | null} */
  let previous = null;
  try {
    const versions = /** @type {{ version_id: string, percentage: number }[]} */ (JSON.parse(status.stdout.slice(status.stdout.indexOf('{'))).versions ?? []);
    previous = [...versions].sort((x, y) => y.percentage - x.percentage)[0]?.version_id ?? null;
  } catch { /* reported below */ }
  if (status.code !== 0 || !previous) {
    error(`deploy: refusing to promote ${versionId}: could not read the live deployment (wrangler deployments status, exit ${status.code}), `
      + 'so the rollback target would be unknown. It is uploaded but serves no traffic.');
    return status.code || 1;
  }
  record.version('previousVersionId', previous);
  /** @type {import('./deploy-tag.mjs').TagFields} */
  const fields = {
    versionId, previousVersionId: previous, commit: head, ...guard.values, startupMs: Number(startup),
    actionsRun: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null,
  };
  log(`deploy: intent: promote version ${versionId}, previous version ${previous}, ${Object.entries(guard.values).map(([k, v]) => `${k} ${v}`).join(', ')}, startup ${startup} ms`);
  if (stage.signalled) return stage.signalled.code;

  // 5. Promote, tag, triggers.
  stage.promoted = true;
  const promote = await exec('npx', ['wrangler', 'versions', 'deploy', `${versionId}@100%`, '--yes', '--message', message], { stream: true });
  if (promote.code !== 0) {
    error(`deploy: wrangler versions deploy failed (exit ${promote.code}); ${versionId} is uploaded, maybe not live: check \`npx wrangler deployments status\`.`);
    return promote.code;
  }
  const name = tagName('deploy', (deps.now ?? (() => new Date()))(), versionId);
  const title = `deploy ${versionId.slice(0, 8)} of ${short}`;
  const tag = await createAndPushTag({ exec, name, commit: head, title, fields });
  record.version('deployTag', name);
  record.detail('tagPushed', tag.pushed);
  if (!tag.created) {
    error(`deploy: could not create the tag ${name}; ${versionId} is live. Create and push it by hand:\n  git ${tagArgs(name, head, title, fields).map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}\n  ${pushCommand(name)}`);
  } else if (!tag.pushed) {
    error(`deploy: pushing the tag ${name} failed; ${versionId} is live and tagged locally. Retry:\n  ${pushCommand(name)}`);
  } else {
    log(`deploy: tagged ${name} on ${short} and pushed it.`);
  }
  // Set by a signal handler while the awaits above ran (TypeScript can't see that).
  const late = /** @type {Stage['signalled']} */ (stage.signalled);
  if (late) {
    error(`deploy: stopped by ${late.signal} after the promote: ${versionId} is live${tag.created ? ` and tagged ${name}` : ''}. `
      + 'The Custom Domain was not re-applied: run `npx wrangler triggers deploy`.');
    return late.code;
  }
  // `versions deploy` leaves routes alone; this applies wrangler.jsonc's Custom Domain (ADR 0009).
  const triggers = await exec('npx', ['wrangler', 'triggers', 'deploy'], { stream: true });
  if (triggers.code !== 0) { error(`deploy: wrangler triggers deploy failed (exit ${triggers.code}); ${versionId} is live, the custom domain may be stale.`); return triggers.code; }
  log(`deploy: version ${versionId} (tag ${short}) is live; ${name} and the run record name it, and ${previous} is its rollback target.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await deploy();
}
