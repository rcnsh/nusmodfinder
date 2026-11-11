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
//    `wrangler dev --remote` session holding a one-off secret: no production
//    secret is ever bound, so the deployed Worker's admin routes stay 404.
// 4. The startup gate (B-4): `wrangler check startup` locally, then
//    `wrangler versions upload --tag <short sha> --message "<sha> <subject>"`
//    with the bundle aliased in; refuses if the reported startup time is
//    missing or above 200 ms (the version is then uploaded but serves no
//    traffic); only then `wrangler versions deploy <id>@100%`, then
//    `wrangler triggers deploy` for the Custom Domain in wrangler.jsonc.
// The Worker reports the tag as `x-app-version` and in GET /health.
// Before any of that, it refuses a wrangler.jsonc whose `vars` hold anything
// but DENSE_BACKEND (Phase 4: test-only switches such as SC1_TRACE never ship).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dataVersion } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';

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
 * Whether `port` on 127.0.0.1 can be bound now; 0 asks the OS for a free one.
 * @param {number} port
 * @returns {Promise<number | null>} the bound port, or null when it is in use
 */
const tryBind = (port) => new Promise((resolve) => {
  const server = createServer();
  server.once('error', () => resolve(null));
  server.listen(port, '127.0.0.1', () => {
    const bound = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    server.close(() => resolve(bound));
  });
});

/** A port free on 127.0.0.1 now, for the guard's own `wrangler dev`. */
export async function freePort() {
  return /** @type {number} */ (await tryBind(0));
}

/**
 * GET /admin/hashes through a local `wrangler dev --remote` session (B2-2):
 * the session gets a one-off INGEST_SECRET from a 0600 env file in a fresh
 * temp directory (so .dev.vars is not read), is polled on /health until it
 * answers, asked once, and stopped. The port is a free one unless given; a
 * given port already in use is refused, since another dev server on it could
 * answer the guard's /health poll.
 * @param {{ port?: number, log?: (line: string) => void, fetchImpl?: typeof fetch, timeoutMs?: number }} [o]
 * @returns {Promise<D1Hashes>}
 */
export async function remoteHashes({ port: given, log = console.log, fetchImpl = fetch, timeoutMs = 120_000 } = {}) {
  if (given !== undefined && (await tryBind(given)) === null) throw new Error(`port ${given} is in use; the guard needs its own wrangler dev`);
  const port = given ?? await freePort();
  const dir = await mkdtemp(join(tmpdir(), 'vnm-deploy-'));
  const secret = randomBytes(24).toString('hex');
  const envFile = join(dir, 'guard.env');
  await writeFile(envFile, `INGEST_SECRET=${secret}\n`, { mode: 0o600 });
  const child = spawn('npx', ['wrangler', 'dev', '--remote', '--ip', '127.0.0.1', '--port', String(port), '--env-file', envFile],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + timeoutMs;
    log(`deploy: guard: waiting for wrangler dev --remote on ${base} (D1 read: /admin/hashes, ~6.8k rows)`);
    for (;;) {
      if (child.exitCode !== null) throw new Error(`wrangler dev --remote exited (${child.exitCode}) before answering`);
      const ok = await fetchImpl(`${base}/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (Date.now() > deadline) throw new Error(`wrangler dev --remote did not answer /health within ${timeoutMs / 1000}s`);
      // Polls the dev server's own readiness, which nothing can notify.
      await new Promise((r) => { setTimeout(r, 1000); });
    }
    const res = await fetchImpl(`${base}/admin/hashes`, { headers: { authorization: `Bearer ${secret}` } });
    if (!res.ok) throw new Error(`GET /admin/hashes -> HTTP ${res.status}`);
    const body = /** @type {any} */ (await res.json());
    if (!body?.modules) throw new Error('GET /admin/hashes returned no modules (schema check failed?)');
    return body;
  } finally {
    child.kill('SIGTERM');
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {{
 *   exec?: Exec, log?: (msg: string) => void, error?: (msg: string) => void,
 *   bundle?: () => Promise<DeployBundle>, d1Hashes?: () => Promise<D1Hashes>, committedDataVersion?: () => Promise<string>,
 *   vars?: () => Promise<Record<string, unknown>>,
 * }} [deps]
 * @returns {Promise<number>} The process exit code.
 */
export async function deploy({
  exec = run, log = console.log, error = console.error, bundle = productionBundle, d1Hashes = () => remoteHashes({ log }),
  committedDataVersion = async () => String(JSON.parse(await readFile(DATA_VERSION_PATH, 'utf8')).version),
  vars = wranglerVars,
} = {}) {
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
  if (status.out !== '') {
    error(`deploy: refusing, the working tree is not clean:\n${status.out}\nCommit (via a PR to main) or discard these first.`);
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
    hashes = await d1Hashes();
  } catch (err) {
    error(`deploy: refusing, could not read D1's hashes: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
  const rows = Object.entries(hashes.modules);
  const d1Key = await rowsKey(rows.map(([code, h]) => ({ code, textHash: h.textHash })));
  const d1Version = rows.every(([, h]) => typeof h.rowHash === 'string')
    ? await dataVersion(rows.map(([code, h]) => ({ code, rowHash: /** @type {string} */ (h.rowHash) })))
    : null;
  log(`deploy: guard read ${rows.length} D1 rows through /admin/hashes; log the read in remote-ops.md.`);
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
  const upload = await exec('npx', ['wrangler', 'versions', 'upload', '--tag', short, '--message', message, '--alias', alias], { stream: true });
  if (upload.code !== 0) { error(`deploy: wrangler versions upload failed (exit ${upload.code}).`); return upload.code; }
  const versionId = upload.stdout.match(/Worker Version ID:\s*([0-9a-f-]{36})/i)?.[1];
  const startup = upload.stdout.match(/Worker Startup Time:\s*(\d+(?:\.\d+)?)\s*ms/i)?.[1];
  if (!versionId) { error('deploy: refusing to promote, no version id in wrangler versions upload output.'); return 1; }
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
  log(`deploy: version ${versionId} (tag ${short}) is live. Record it in remote-ops.md (the rollback target list).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await deploy();
}
