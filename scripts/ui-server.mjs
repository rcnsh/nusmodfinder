#!/usr/bin/env node
// @ts-check
// The UI test stack's server (Phase 5 5B): the page and the Worker on a local
// `wrangler dev` (test/wrangler.ui.jsonc: test/ui/worker.js with FakeAI and
// FakeRateLimit, public/ as static assets), over a local D1 seeded with the
// fixture. `npm run dev` runs it; the Playwright suite starts it per run.
//
//   node scripts/ui-server.mjs [--port N] [--verbose]
//
// Everything is local and temporary:
// - a fresh `--persist-to` directory, deleted on exit;
// - its own `--env-file` holding a one-off INGEST_SECRET, never .dev.vars;
// - `wrangler d1 migrations apply --local`, then seeding through the admin
//   routes as ingest does: /admin/ingest?d1Only=1 in batches of 100,
//   /admin/catalogue with the catalogue-only rows (so a not-offered code has
//   its title, A3-4), and /admin/facets with the NG list (A2-9).
// No remote binding exists in the config, so nothing here can reach Cloudflare.
// Ports 8787 and 8799 belong to other projects and are refused; by default a
// free port is picked.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { facetsPayload, loadNgCourses } from './lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = join(ROOT, 'test/wrangler.ui.jsonc');
const WRANGLER = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
/** test/wrangler.ui.jsonc's D1 database_name. */
const DATABASE = 'nusmods';
/** Ports other projects on the dev Mac own. */
export const RESERVED_PORTS = Object.freeze([8787, 8799]);
const BATCH = 100;
const READY_TIMEOUT_MS = 90_000;

/** A port nothing listens on now (the OS picks it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/**
 * Runs wrangler to completion, resolving with its output.
 * @param {string[]} args
 * @param {Record<string, string>} env
 * @param {(child: import('node:child_process').ChildProcess) => void} started
 */
function wrangler(args, env, started) {
  return new Promise((resolve, reject) => {
    // Its own process group, like wrangler dev's, so killing it takes its workerd too.
    const child = spawn(process.execPath, [WRANGLER, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    started(child);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`wrangler ${args.slice(0, 3).join(' ')} exited ${code}:\n${out}`))));
  });
}

/**
 * Starts the server and seeds it; resolves once it answers with the fixture
 * loaded. Aborting `signal` at any point stops whatever has started (the
 * migration, wrangler dev and its workerd) and deletes the temporary state, so
 * a Ctrl-C during start-up leaves nothing behind.
 * @param {{ port?: number, verbose?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<{ url: string, stop: () => Promise<void> }>}
 */
export async function startUiServer({ port, verbose = false, signal } = {}) {
  /** @type {import('node:child_process').ChildProcess | null} */
  let migrate = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let dev = null;
  /** @type {string | null} */
  let dir = null;
  let log = '';
  // Kills what is running now, each child's whole process group (wrangler
  // and its workerd), and waits for it: workerd writes into the state
  // directory until it exits. Safe to call again after a later spawn.
  const kill = () => Promise.all([migrate, dev].map(async (c) => {
    if (!c?.pid) return;
    const pid = c.pid;
    const exited = c.exitCode === null && c.signalCode === null ? new Promise((r) => c.once('exit', r)) : Promise.resolve();
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already gone */ }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
    // The group outlives its leader by a moment; wait until none of it is left.
    for (let i = 0; i < 50; i++) {
      try { process.kill(-pid, 0); } catch { return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  }));
  const stop = async () => {
    await kill();
    if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  };
  const onAbort = () => { kill(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  const live = () => signal?.throwIfAborted();

  try {
    const listen = port ?? await freePort();
    if (RESERVED_PORTS.includes(listen)) throw new Error(`port ${listen} belongs to another project; pick another or omit --port`);
    const inspector = await freePort();
    dir = await mkdtemp(join(tmpdir(), 'vnm-ui-'));
    const persist = join(dir, 'state');
    const envFile = join(dir, 'ui.env');
    const secret = randomBytes(24).toString('hex');
    await writeFile(envFile, `INGEST_SECRET=${secret}\n`, { mode: 0o600 });
    // No account, no metrics, no update check: nothing leaves the machine.
    /** @type {Record<string, string>} */
    const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', NO_UPDATE_NOTIFIER: '1' };
    delete env.CLOUDFLARE_API_TOKEN;
    delete env.CLOUDFLARE_ACCOUNT_ID;

    live();
    await wrangler(['d1', 'migrations', 'apply', DATABASE, '--local', '--persist-to', persist, '-c', CONFIG], env, (c) => { migrate = c; });
    live();
    // Its own process group, so kill() takes workerd down with it.
    dev = spawn(process.execPath, [
      WRANGLER, 'dev', '-c', CONFIG, '--local', '--persist-to', persist, '--env-file', envFile,
      '--ip', '127.0.0.1', '--port', String(listen), '--inspector-port', String(inspector),
      '--show-interactive-dev-session=false', '--log-level', verbose ? 'log' : 'warn',
    ], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    for (const stream of [dev.stdout, dev.stderr]) {
      stream?.on('data', (d) => {
        log = (log + d).slice(-20_000);
        if (verbose) process.stderr.write(d);
      });
    }
    live();
    const url = `http://127.0.0.1:${listen}`;
    await waitForHealth(url, () => dev?.exitCode ?? dev?.signalCode ?? null);
    live();
    await seed(url, secret);
    live();
    signal?.removeEventListener('abort', onAbort);
    return { url, stop };
  } catch (err) {
    await stop();
    throw new Error(`${/** @type {Error} */ (err).message}${log ? `\n--- wrangler dev output ---\n${log}` : ''}`, { cause: err });
  }
}

/**
 * @param {string} url
 * @param {() => number | string | null} exitCode
 */
async function waitForHealth(url, exitCode) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    if (exitCode() !== null) throw new Error(`wrangler dev exited (${exitCode()}) before it answered`);
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`wrangler dev did not answer ${url}/health within ${READY_TIMEOUT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * The fixture, the catalogue-only rows and the NG list, through the admin routes.
 * @param {string} url
 * @param {string} secret
 */
async function seed(url, secret) {
  /** @param {string} path @param {unknown} body */
  const post = async (path, body) => {
    const res = await fetch(`${url}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    });
    if (res.status !== 200) throw new Error(`seed: POST ${path} answered ${res.status}: ${await res.text()}`);
  };
  const fixture = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/corpus.json'), 'utf8'));
  /** @type {NormalisedModule[]} */
  const modules = fixture.modules;
  for (let i = 0; i < modules.length; i += BATCH) await post('/admin/ingest?d1Only=1', { modules: modules.slice(i, i + BATCH) });

  const catalogue = JSON.parse(readFileSync(join(ROOT, 'data/catalogue-only.json'), 'utf8'));
  const acadYear = String(catalogue.source.acadYear);
  /** @type {[string, string, string | null][]} */
  const rows = catalogue.rows;
  for (let i = 0; i < rows.length; i += BATCH) {
    await post('/admin/catalogue', { upsert: rows.slice(i, i + BATCH).map(([code, title, description]) => ({ code, title, description, acadYear })) });
  }
  await post('/admin/facets', facetsPayload(await loadNgCourses(acadYear)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--port');
  const port = at >= 0 ? Number(argv[at + 1]) : undefined;
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    console.error('usage: node scripts/ui-server.mjs [--port N] [--verbose]');
    process.exit(2);
  }
  const started = Date.now();
  // Armed before anything starts: a signal during start-up aborts it, and
  // startUiServer cleans up; after it, stop() does.
  const abort = new AbortController();
  /** @type {{ url: string, stop: () => Promise<void> } | null} */
  let server = null;
  let stopping = false;
  for (const sig of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      if (server) server.stop().finally(() => process.exit(0));
      else abort.abort();
    });
  }
  try {
    server = await startUiServer({ port, verbose: argv.includes('--verbose'), signal: abort.signal });
  } catch (err) {
    if (!abort.signal.aborted) console.error(`ui-server: ${/** @type {Error} */ (err).message}`);
    process.exit(abort.signal.aborted ? 130 : 1);
  }
  console.log(`ui-server: ${server.url} (fixture seeded in ${((Date.now() - started) / 1000).toFixed(1)} s; Ctrl-C stops it and deletes its state)`);
}
