// @ts-check
// A `wrangler dev --remote` session for the admin routes, used
// by `npm run remote` (scripts/remote.mjs). The deploy guard reads D1 over its
// REST query instead (scripts/d1-rest.mjs), so it starts none:
//
// - wrangler dev --remote --ip 127.0.0.1 on a free port (never 8787 or 8799,
//   which belong to other projects on the dev Mac);
// - a one-off INGEST_SECRET in a 0600 env file in a fresh temp dir. With
//   --env-file, wrangler loads that file and not .dev.vars (wrangler
//   4.157 getVarsForDev: .dev.vars is read only when no env file is given),
//   and this module never opens .dev.vars itself. No production secret is
//   ever bound, so the deployed Worker's admin routes stay 404;
// - waits for /health. Cloudflare's `code 10021` ("binding DB of type d1
//   failed to generate") is retried for up to 30 minutes from the first try,
//   each try logged (the ADR 0009 deploy took 8 tries over 25 minutes);
// - runs the caller's function with the URL and the secret;
// - always stops the session (its whole process group, SIGKILL after a
//   grace period) and deletes the dir, on success, a throw, SIGINT, SIGTERM
//   or SIGHUP (the session runs detached, in its own process group, so a
//   closed terminal reaches it only through this), and at process exit.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESERVED_PORTS } from './ui-server.mjs';

export { RESERVED_PORTS };
const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The Cloudflare error a fresh preview session sometimes answers with, retried. */
export const RETRY_CODE = '10021';
/** How long 10021 is retried, from the first try's start. */
export const RETRY_LIMIT_MS = 30 * 60_000;
/** Between tries: a backoff before restarting the session, not a wait on work. */
export const RETRY_DELAY_MS = 30_000;
/** How long one try may take to answer /health. */
export const HEALTH_TIMEOUT_MS = 120_000;
/** What the session binds, for run records and the command's VNM_REMOTE_TARGET. */
export const SESSION_TARGET = 'wrangler dev --remote (production D1, Vectorize and Workers AI bindings)';

/** @param {number} port */
export function reservedPortError(port) {
  return RESERVED_PORTS.includes(port) ? `port ${port} is reserved (another project's on the dev Mac); never use ${RESERVED_PORTS.join(' or ')}` : null;
}

/**
 * The Worker URL a script talks to: --url, else WORKER_URL. There is no default: a
 * script run without either would send the INGEST_SECRET bearer to whatever listens.
 * @param {string | undefined} url
 * @param {Record<string, string | undefined>} envVars
 * @returns {{ base: string, error?: undefined } | { error: string, base?: undefined }}
 */
export function workerUrl(url, envVars) {
  const given = url ?? envVars.WORKER_URL;
  if (!given) return { error: 'no --url and no WORKER_URL. Run it through `npm run remote -- …`, which starts a session and sets both.' };
  /** @type {URL} */
  let parsed;
  try { parsed = new URL(given); } catch { return { error: `${given} is not a URL` }; }
  const reserved = parsed.port ? reservedPortError(Number(parsed.port)) : null;
  if (reserved) return { error: `refusing ${given}: ${reserved}` };
  return { base: given.replace(/\/$/, '') };
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

/** A port free on 127.0.0.1 now, never a reserved one. */
export async function freePort() {
  for (;;) {
    const port = /** @type {number} */ (await tryBind(0));
    if (!RESERVED_PORTS.includes(port)) return port;
  }
}

/**
 * @typedef {{ url: string, secret: string, port: number, tries: number }} Session
 * @typedef {{
 *   port?: number, log?: (line: string) => void, fetchImpl?: typeof fetch,
 *   wrangler?: string[], cwd?: string, env?: NodeJS.ProcessEnv,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   limitMs?: number, retryDelayMs?: number, healthTimeoutMs?: number, pollMs?: number, pollTimeoutMs?: number, killGraceMs?: number,
 *   record?: import('./run-record.mjs').RunRecord,
 *   proc?: Pick<NodeJS.Process, 'on' | 'off'>, deferSignals?: boolean,
 *   onSignal?: (signal: NodeJS.Signals, phase: 'deferred' | 'stopping') => void,
 * }} SessionOptions
 *   `wrangler`: the command and its leading args (default node_modules/.bin/wrangler); `now` and
 *   `sleep` time the retries; `record`: a run record that gets the port and each try.
 *   `deferSignals`: once `fn` runs, the first SIGINT or SIGTERM is left to `fn`'s own child (which
 *   got it too, from the terminal) and the session stays up until `fn` ends; a second one stops it.
 *   Before `fn` runs, and without it, a signal stops the session at once. SIGHUP is never deferred.
 *   `onSignal` hears each signal and what the session did with it (`scripts/remote.mjs` passes
 *   SIGTERM on to its command, which a `kill` of this pid alone would not reach).
 *   `pollTimeoutMs`: one /health request's limit, so a request wrangler holds (its proxy queues
 *   requests until the session is ready) never stalls the 10021 and deadline checks.
 */

/**
 * Stops a detached child's process group: SIGTERM, then SIGKILL after `graceMs`.
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} graceMs
 */
async function stop(child, graceMs) {
  if (child.pid === undefined) return;
  const pid = child.pid;
  /** The group too: wrangler's own children (workerd) outlive it otherwise. @param {NodeJS.Signals} sig */
  const kill = (sig) => { try { process.kill(-pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
  if (child.exitCode !== null || child.signalCode !== null) { kill('SIGKILL'); return; }
  const exited = new Promise((resolve) => { child.once('exit', resolve); });
  kill('SIGTERM');
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const grace = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), graceMs); });
  if (await Promise.race([exited, grace]) === 'timeout') {
    kill('SIGKILL');
    await exited;
  }
  clearTimeout(timer);
}

/**
 * Runs `fn` against a fresh session, retrying 10021, and always stops the session.
 * @template T
 * @param {(session: Session) => Promise<T>} fn
 * @param {SessionOptions} [o]
 * @returns {Promise<T>}
 */
export async function withRemoteSession(fn, o = {}) {
  const {
    port: given, log = console.log, fetchImpl = fetch, wrangler = [join(ROOT, 'node_modules/.bin/wrangler')], cwd = ROOT, env = process.env,
    now = Date.now, sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), limitMs = RETRY_LIMIT_MS, retryDelayMs = RETRY_DELAY_MS,
    healthTimeoutMs = HEALTH_TIMEOUT_MS, pollMs = 1000, pollTimeoutMs = 5000, killGraceMs = 5000, record, proc = process, deferSignals = false,
    onSignal: hook = () => {},
  } = o;
  if (given !== undefined) {
    const reserved = reservedPortError(given);
    if (reserved) throw new Error(reserved);
    if ((await tryBind(given)) === null) throw new Error(`port ${given} is in use; the session needs its own wrangler dev`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'vnm-remote-'));
  const secret = randomBytes(24).toString('hex');
  const envFile = join(dir, 'session.env');
  writeFileSync(envFile, `INGEST_SECRET=${secret}\n`, { mode: 0o600 });
  // The child never inherits a secret, and wrangler loads the env file (and only it).
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' };
  delete childEnv.INGEST_SECRET;
  delete childEnv.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV;

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {(err: Error) => void} */
  let abort = () => {};
  const aborted = new Promise((_, reject) => { abort = reject; });
  aborted.catch(() => {});
  const killNow = () => {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  };
  let running = false;
  let deferred = false;
  const onSignal = (/** @type {NodeJS.Signals} */ sig) => {
    if (deferSignals && running && !deferred && sig !== 'SIGHUP') {
      deferred = true;
      log(`remote: ${sig}: the session stays up until the command stops; signal again to stop it now`);
      hook(sig, 'deferred');
      return;
    }
    log(`remote: ${sig}: stopping the session`);
    killNow();
    hook(sig, 'stopping');
    abort(new Error(`${sig}: the session was stopped`));
  };
  /** @type {[NodeJS.Signals, () => void][]} */
  const handlers = /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP']).map((sig) => [sig, () => onSignal(sig)]);
  for (const [sig, h] of handlers) proc.on(sig, h);
  proc.on('exit', killNow);

  /** @type {{ n: number, port: number, result: string, startedAt: string }[]} */
  const tries = [];
  record?.detail('tries', tries);
  const first = now();
  try {
    for (let n = 1; ; n++) {
      const port = n === 1 && given !== undefined ? given : await freePort();
      const startedAt = now();
      const base = `http://127.0.0.1:${port}`;
      record?.detail('port', port);
      // Each try's session start is Cloudflare API calls (a preview session, its bindings).
      record?.request('wrangler dev --remote');
      log(`remote: try ${n}: wrangler dev --remote on ${base}`);
      const c = spawn(wrangler[0], [...wrangler.slice(1), 'dev', '--remote', '--ip', '127.0.0.1', '--port', String(port), '--env-file', envFile],
        { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
      child = c;
      let output = '';
      const closed = new Promise((resolve) => { c.once('close', resolve); });
      const has10021 = () => output.includes(`code: ${RETRY_CODE}`) || output.includes(`code ${RETRY_CODE}`);
      /** @type {() => void} */
      let saw = () => {};
      const sawRetry = new Promise((resolve) => { saw = () => resolve(false); });
      const keep = (/** @type {Buffer} */ b) => {
        output = (output + b.toString('utf8')).slice(-65_536);
        if (has10021()) saw();
      };
      c.stdout?.on('data', keep);
      c.stderr?.on('data', (/** @type {Buffer} */ b) => { keep(b); process.stderr.write(b); });
      const spawnError = new Promise((_, reject) => { c.once('error', reject); });
      spawnError.catch(() => {});

      /** @type {'answered' | '10021' | string} */
      let result;
      const deadline = Date.now() + healthTimeoutMs;
      for (;;) {
        // Each poll ends at its own timeout, the 10021 line, the child's exit or a signal,
        // whichever comes first: a request wrangler holds never stalls the checks below.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), Math.max(1, Math.min(pollTimeoutMs, deadline - Date.now())));
        const ok = await Promise.race([
          fetchImpl(`${base}/health`, { signal: ctl.signal }).then((r) => r.ok, () => false), aborted, spawnError, sawRetry, closed.then(() => false),
        ]).finally(() => { clearTimeout(timer); ctl.abort(); });
        if (ok) { result = 'answered'; break; }
        if (has10021()) { result = RETRY_CODE; break; }
        if (c.exitCode !== null) {
          // Its last output may still be in the pipe: read it all before deciding.
          await closed;
          result = has10021() ? RETRY_CODE : `exited (${c.exitCode}) before answering`;
          break;
        }
        if (Date.now() > deadline) { result = `did not answer /health within ${healthTimeoutMs / 1000}s`; break; }
        // Polls the dev server's readiness, which nothing can notify.
        await Promise.race([new Promise((r) => { setTimeout(r, pollMs); }), aborted]);
      }
      tries.push({ n, port, result: result === 'answered' || result === RETRY_CODE ? result : 'error', startedAt: new Date(startedAt).toISOString() });
      if (result === 'answered') {
        log(`remote: ${base} answered /health on try ${n}`);
        running = true;
        return await Promise.race([fn({ url: base, secret, port, tries: n }), aborted]);
      }
      await stop(c, killGraceMs);
      if (result !== RETRY_CODE) throw new Error(`wrangler dev --remote ${result}`);
      const next = startedAt + retryDelayMs;
      if (next - first > limitMs) {
        throw new Error(`wrangler dev --remote failed with code ${RETRY_CODE} on ${n} tries over ${Math.round((startedAt - first) / 60_000)} min; giving up`);
      }
      log(`remote: try ${n} failed with code ${RETRY_CODE}; retrying in ${Math.round(retryDelayMs / 1000)} s (${Math.round((limitMs - (next - first)) / 60_000)} min left of ${limitMs / 60_000})`);
      await Promise.race([sleep(Math.max(0, next - now())), aborted]);
    }
  } finally {
    for (const [sig, h] of handlers) proc.off(sig, h);
    proc.off('exit', killNow);
    if (child) await stop(child, killGraceMs);
    rmSync(dir, { recursive: true, force: true });
  }
}
