// @ts-check
// The only supported way to deploy:
//
//   npm run deploy
//
// 1. Refuses unless the working tree is clean and HEAD is already on
//    origin/main, so every deployed version maps to a pushed commit.
// 2. The vectors bundle (Phase 3 3-0, docs/plans/phase3.md "Deploy guard",
//    B-2, B2-2, B3-4): the production bundle data/vectors.json records,
//    downloaded from its release asset if absent and sha256-checked. Refuses
//    the fixture and the pinned bundle, and a manifest data version that is
//    not src/data-version.json.
// 3. The guard: D1's (code, text_hash) pairs must hash to the manifest's
//    rowsKey, and D1's data version (from its row_hashes) must equal the
//    committed one. Read from /admin/hashes (~6.8k rows) through a local
//    `wrangler dev --remote` session holding a one-off secret
//    (scripts/remote-session.mjs, which `npm run remote` shares): no
//    production secret is ever bound, so the deployed Worker's admin routes
//    stay 404.
// 4. The startup gate (B-4): `wrangler check startup` locally, then
//    `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`
//    with the bundle aliased in; refuses if the reported startup time is
//    missing or above 200 ms (the version is then uploaded but serves no
//    traffic); only then `wrangler versions deploy <id>@100%`, then
//    `wrangler triggers deploy` for the Custom Domain in wrangler.jsonc.
// The Worker reports the tag as `x-app-version` and in GET /health.
// Before any of that, it refuses a wrangler.jsonc whose `vars` hold anything
// but DENSE_BACKEND (Phase 4: test-only switches such as SC1_TRACE never ship).
//
// Phase 7 7C: every run writes a run record (scripts/run-record.mjs) on every
// exit path: the guard's read, the version id and tag, the outcome. The clean
// tree check exempts only new, untracked run records under
// docs/evidence/ops/runs/ (docs/ is neither bundled nor an asset).
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataVersion } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';
import { freePort, withRemoteSession } from './remote-session.mjs';
import { isNewRunRecord, startRun } from './run-record.mjs';

export { freePort };

// Cloudflare caps version messages at 100 characters.
const MAX_MESSAGE = 100;
/** The startup gate (docs/plans/phase3.md 3-0, B-4); the platform limit is 1 s. */
export const MAX_STARTUP_MS = 200;
/** Where the local startup pre-check writes its CPU profile. */
export const STARTUP_PROFILE = join(tmpdir(), 'nusmodfinder-startup.cpuprofile');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The only var the deployed Worker may have (docs/plans/phase4.md §4, gate 2). */
export const ALLOWED_VARS = ['DENSE_BACKEND'];

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
const DATA_VERSION_PATH = join(ROOT, 'src/data-version.json');

/**
 * @typedef {{ code: number, stdout: string }} ExecResult
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<ExecResult>} Exec
 *   Runs a command without a shell. With `stream`, stdout is also echoed live.
 * @typedef {import('./vectors-manifest.mjs').ManifestEntry} ManifestEntry
 * @typedef {{ entry: ManifestEntry, header: import('../src/vector-bundle.js').BundleHeader, sha256: string, shim: string,
 *   others: string[] }} DeployBundle `shim`: the module the `vectors-bundle` alias points at; `others`: the
 *   sha256s of the fixture and pinned bundles, which a deploy must never ship.
 * @typedef {{ modules: Record<string, { textHash: string, rowHash: string | null }> }} D1Hashes
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
 * GET /admin/hashes through a `wrangler dev --remote` session (B2-2, Phase 7 7C): the
 * session (scripts/remote-session.mjs) holds a one-off INGEST_SECRET from a 0600 env file in a
 * fresh temp dir (so .dev.vars is not read), retries Cloudflare's code 10021, is asked once,
 * and stopped. The port is a free one unless given; a given port already in use is refused,
 * since another dev server on it could answer the guard's /health poll.
 * @param {{ port?: number, log?: (line: string) => void, fetchImpl?: typeof fetch,
 *   record?: import('./run-record.mjs').RunRecord, session?: import('./remote-session.mjs').SessionOptions }} [o]
 * @returns {Promise<D1Hashes>}
 */
export async function remoteHashes({ port, log = console.log, fetchImpl = fetch, record, session = {} } = {}) {
  return withRemoteSession(async ({ url, secret }) => {
    log(`deploy: guard: asking ${url}/admin/hashes (D1 read, ~6.8k rows)`);
    record?.request('/admin/hashes');
    const res = await fetchImpl(`${url}/admin/hashes`, { headers: { authorization: `Bearer ${secret}` } });
    if (!res.ok) throw new Error(`GET /admin/hashes -> HTTP ${res.status}`);
    const body = /** @type {any} */ (await res.json());
    if (!body?.modules) throw new Error('GET /admin/hashes returned no modules (schema check failed?)');
    return body;
  }, { log, fetchImpl, ...(record ? { record } : {}), ...session, ...(port !== undefined ? { port } : {}) });
}

/** The Worker deploy acts on (wrangler.jsonc `name`), for its run record. */
const WORKER_NAME = 'nusmodfinder';

/**
 * @typedef {{
 *   exec?: Exec, log?: (msg: string) => void, error?: (msg: string) => void,
 *   bundle?: () => Promise<DeployBundle>, d1Hashes?: (record: import('./run-record.mjs').RunRecord) => Promise<D1Hashes>,
 *   committedDataVersion?: () => Promise<string>, vars?: () => Promise<Record<string, unknown>>, runsDir?: string,
 * }} DeployDeps
 */

/**
 * The deploy, with its run record: one record on every exit path, a throw included.
 * @param {DeployDeps} [deps]
 * @returns {Promise<number>} The process exit code.
 */
export async function deploy(deps = {}) {
  const record = startRun('deploy', { target: WORKER_NAME, args: process.argv.slice(2), dir: deps.runsDir });
  /** How far it got: a failure after the upload is `failed`, before it `refused`. */
  const stage = { uploaded: false };
  const unguard = record.guardExit();
  /** Each wrangler command but the local startup check makes Cloudflare API calls. @type {Exec} */
  const exec = (cmd, args, opts) => {
    if (cmd === 'npx' && args[0] === 'wrangler' && args[1] !== 'check') record.request(`wrangler ${args.slice(1, 3).join(' ')}`);
    return (deps.exec ?? run)(cmd, args, opts);
  };
  try {
    const code = await deployRun({ ...deps, exec }, record, stage);
    record.finish(code === 0 ? 'ok' : stage.uploaded ? 'failed' : 'refused', { exitCode: code });
    if (code === 0) (deps.log ?? console.log)(`deploy: run record ${record.path}`);
    return code;
  } catch (err) {
    record.finish('failed', { exitCode: 1, message: String(/** @type {Error} */ (err)?.message ?? err).split('\n')[0] });
    throw err;
  } finally {
    unguard();
  }
}

/**
 * @param {DeployDeps} deps
 * @param {import('./run-record.mjs').RunRecord} record
 * @param {{ uploaded: boolean }} stage
 * @returns {Promise<number>}
 */
async function deployRun({
  exec = run, log = console.log, error = console.error, bundle = productionBundle, d1Hashes = (r) => remoteHashes({ log, record: r }),
  committedDataVersion = async () => String(JSON.parse(await readFile(DATA_VERSION_PATH, 'utf8')).version),
  vars = wranglerVars,
}, record, stage) {
  const extra = Object.keys(await vars()).filter((k) => !ALLOWED_VARS.includes(k));
  if (extra.length) {
    error(`deploy: refusing, wrangler.jsonc vars hold ${extra.join(', ')}; only ${ALLOWED_VARS.join(', ')} may ship (test-only switches never deploy).`);
    return 1;
  }
  /** @param {string[]} args */
  const git = async (args) => {
    const res = await exec('git', args);
    return { ...res, out: res.stdout.trim() };
  };

  // --untracked-files=all overrides status.showUntrackedFiles; ls-files -v catches files
  // hidden by assume-unchanged (lower-case tag) or skip-worktree (S).
  const status = await git(['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']);
  if (status.code !== 0) { error('deploy: `git status` failed.'); return 1; }
  // Phase 7 7C: new run records (this run's own and earlier ones not yet committed) are not dirt.
  const dirt = status.out.split('\n').filter((l) => l && !isNewRunRecord(l));
  if (dirt.length) {
    error(`deploy: refusing, the working tree is not clean:\n${dirt.join('\n')}\nCommit (via a PR to main) or discard these first.`);
    return 1;
  }
  const flags = await git(['ls-files', '-v']);
  if (flags.code !== 0) { error('deploy: `git ls-files` failed.'); return 1; }
  const hidden = flags.out.split('\n').filter((l) => /^([a-z]|S) /.test(l));
  if (hidden.length) {
    error(`deploy: refusing, files are marked assume-unchanged or skip-worktree, so local edits may be hidden:\n${hidden.join('\n')}`);
    return 1;
  }

  const fetched = await git(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.code !== 0) { error('deploy: refusing, could not fetch origin/main to check HEAD is pushed.'); return 1; }

  const head = await git(['rev-parse', 'HEAD']);
  const tip = await git(['rev-parse', 'refs/remotes/origin/main']);
  if (head.code !== 0 || tip.code !== 0) { error('deploy: `git rev-parse` failed.'); return 1; }
  const onMain = await git(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']);
  if (onMain.code === 1) {
    error(`deploy: refusing, HEAD ${head.out} is not on origin/main. Merge it to main first.`);
    return 1;
  }
  if (onMain.code !== 0) { error('deploy: `git merge-base` failed.'); return 1; }
  if (head.out !== tip.out) {
    log(`deploy: note: HEAD ${head.out} is behind origin/main (${tip.out}); deploying the older commit.`);
  }

  // The bundle and its manifest entry.
  /** @type {DeployBundle} */
  let b;
  try {
    b = await bundle();
  } catch (err) {
    error(`deploy: refusing, ${/** @type {Error} */ (err).message}`);
    return 1;
  }
  if (b.entry.corpus !== 'production' || b.header.corpus !== 'production' || b.others.includes(b.sha256)) {
    error(`deploy: refusing, the bundle is the ${b.header.corpus} bundle (sha256 ${b.sha256.slice(0, 12)}); only the production bundle deploys.`);
    return 1;
  }
  if (/\s/.test(b.shim)) { error(`deploy: refusing, the bundle path has whitespace (${b.shim}); wrangler check startup --args splits on spaces.`); return 1; }
  const committed = await committedDataVersion();
  if (b.entry.dataVersion !== committed || b.header.dataVersion !== committed) {
    error(`deploy: refusing, the production bundle is for data version ${b.entry.dataVersion}, src/data-version.json says ${committed}.`);
    return 1;
  }

  // The guard: D1 must already hold the rows the bundle embeds (runbook step 4).
  /** @type {D1Hashes} */
  let hashes;
  try {
    hashes = await d1Hashes(record);
  } catch (err) {
    record.read('D1 rows (/admin/hashes, the guard)', { estimate: b.entry.count });
    error(`deploy: refusing, could not read D1's hashes: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
  const rows = Object.entries(hashes.modules);
  const d1Key = await rowsKey(rows.map(([code, h]) => ({ code, textHash: h.textHash })));
  const d1Version = rows.every(([, h]) => typeof h.rowHash === 'string')
    ? await dataVersion(rows.map(([code, h]) => ({ code, rowHash: /** @type {string} */ (h.rowHash) })))
    : null;
  record.read('D1 rows (/admin/hashes, the guard)', { estimate: b.entry.count, actual: rows.length });
  log(`deploy: guard read ${rows.length} D1 rows through /admin/hashes (in the run record).`);
  if (d1Key !== b.entry.rowsKey) {
    error(`deploy: refusing, D1's (code, text_hash) pairs (rowsKey ${d1Key.slice(0, 12)}, ${rows.length} rows) are not the bundle's `
      + `(${b.entry.rowsKey.slice(0, 12)}, ${b.entry.count} rows). Run the D1-only ingest (runbook step 4) first.`);
    return 1;
  }
  if (d1Version !== committed) {
    error(`deploy: refusing, D1's data version is ${d1Version ?? 'unknown (rows without row_hash)'}, the committed one ${committed}.`);
    return 1;
  }

  const short = (await git(['rev-parse', '--short', 'HEAD'])).out;
  record.version('tag', short);
  record.version('dataVersion', committed);
  const subject = (await git(['log', '-1', '--format=%s'])).out;
  const message = `${short} ${subject}`.slice(0, MAX_MESSAGE);
  const alias = `vectors-bundle:${b.shim}`;
  log(`deploy: bundle ${relative(ROOT, b.shim)} (${b.entry.count} rows, data version ${committed}, sha256 ${b.sha256.slice(0, 12)})`);

  // Startup: the local pre-check, then the gate on the uploaded version.
  log('deploy: wrangler check startup (local)');
  // `--args=…` as one argv entry: given as two, wrangler parses the value's
  // `--alias` as its own flag and fails with "Unknown arguments". The profile
  // goes to the temp dir, not the (clean) working tree.
  const check = await exec('npx', ['wrangler', 'check', 'startup', '--outfile', STARTUP_PROFILE, `--args=--alias ${alias}`], { stream: true });
  if (check.code !== 0) { error(`deploy: refusing, wrangler check startup failed (exit ${check.code}).`); return check.code; }

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

  const promote = await exec('npx', ['wrangler', 'versions', 'deploy', `${versionId}@100%`, '--yes', '--message', message], { stream: true });
  if (promote.code !== 0) { error(`deploy: wrangler versions deploy failed (exit ${promote.code}); ${versionId} is uploaded, not live.`); return promote.code; }
  // `versions deploy` leaves routes alone; this applies wrangler.jsonc's Custom Domain (ADR 0009).
  const triggers = await exec('npx', ['wrangler', 'triggers', 'deploy'], { stream: true });
  if (triggers.code !== 0) { error(`deploy: wrangler triggers deploy failed (exit ${triggers.code}); ${versionId} is live, the custom domain may be stale.`); return triggers.code; }
  log(`deploy: version ${versionId} (tag ${short}) is live; the run record names it (the rollback target).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await deploy();
}
