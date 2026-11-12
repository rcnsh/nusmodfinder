// @ts-check
// Phase 7 7C: `npm run remote` and the deploy guard share one session module
// (scripts/remote-session.mjs). `wrangler` here is a fake: a Node script that
// serves /health on the port it is given, or prints Cloudflare's code 10021 and
// fails, as told. No real `wrangler dev --remote` ever starts, and nothing
// binds 8787 or 8799.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESERVED_PORTS, RETRY_LIMIT_MS, freePort, withRemoteSession } from '../scripts/remote-session.mjs';
import { main as remoteMain } from '../scripts/remote.mjs';
import { startRun } from '../scripts/run-record.mjs';

/**
 * The fake wrangler. Each start appends a line to starts.jsonl (its pid, argv, cwd, the env
 * file's path, mode and content). `mode.json` says what it does: `serve` answers /health;
 * `fail10021` prints the 10021 error and exits; `hang10021` prints it and stays up; `other`
 * prints another error and exits; `stubborn` serves and ignores SIGTERM. `failFirst: n` makes
 * the first n starts fail with 10021 whatever the mode.
 */
const FAKE = String.raw`
import { appendFileSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
const here = process.env.FAKE_DIR;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const envFile = args.includes('--env-file') ? args[args.indexOf('--env-file') + 1] : null;
const mode = JSON.parse(readFileSync(join(here, 'mode.json'), 'utf8'));
const prior = existsSync(join(here, 'starts.jsonl')) ? readFileSync(join(here, 'starts.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
appendFileSync(join(here, 'starts.jsonl'), JSON.stringify({
  pid: process.pid, args, cwd: process.cwd(), envFile,
  envMode: envFile ? (statSync(envFile).mode & 0o777) : null,
  envText: envFile ? readFileSync(envFile, 'utf8') : null,
  inheritedSecret: process.env.INGEST_SECRET ?? null,
}) + '\n');
const what = prior < (mode.failFirst ?? 0) ? 'fail10021' : mode.what;
const err10021 = 'X [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/y/edge-preview) failed.\n  binding DB of type d1 failed to generate [code: 10021]\n';
if (what === 'fail10021') { process.stderr.write(err10021); process.exit(1); }
if (what === 'other') { process.stderr.write('X [ERROR] Authentication error [code: 10000]\n'); process.exit(1); }
// Listens and never answers, as wrangler's proxy holds requests while a session it can't start is paused.
if (what === 'hang10021') { createServer(() => {}).listen(port, '127.0.0.1', () => { setTimeout(() => process.stderr.write(err10021), 200); }); }
else {
  if (what === 'stubborn') process.on('SIGTERM', () => {});
  createServer((req, res) => { res.writeHead(req.url === '/health' ? 200 : 404); res.end('{"ok":true}'); }).listen(port, '127.0.0.1');
}
`;

/** @type {string} */
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vnm-remote-'));
  writeFileSync(join(dir, 'fake-wrangler.mjs'), FAKE);
  writeFileSync(join(dir, 'runs.keep'), '');
});
afterEach(() => {
  for (const s of starts()) { try { process.kill(s.pid, 'SIGKILL'); } catch { /* already gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

/** @returns {{ pid: number, args: string[], cwd: string, envFile: string | null, envMode: number | null, envText: string | null, inheritedSecret: string | null }[]} */
const starts = () => (existsSync(join(dir, 'starts.jsonl')) ? readFileSync(join(dir, 'starts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const alive = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** @param {Record<string, unknown>} m */
const mode = (m) => writeFileSync(join(dir, 'mode.json'), JSON.stringify(m));

/** A clock the session's waits advance, so a 30-minute retry window takes no real time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (/** @type {number} */ ms) => { t += ms; } };
}

/** @param {Partial<Parameters<typeof withRemoteSession>[1]>} [o] */
const opts = (o = {}) => {
  /** @type {string[]} */
  const lines = [];
  return {
    lines,
    o: /** @type {Parameters<typeof withRemoteSession>[1]} */ ({
      wrangler: [process.execPath, join(dir, 'fake-wrangler.mjs')], cwd: dir, env: { ...process.env, FAKE_DIR: dir },
      log: (/** @type {string} */ l) => lines.push(l), healthTimeoutMs: 20_000, pollMs: 50, ...o,
    }),
  };
};

describe('the remote session', () => {
  it('starts wrangler dev --remote on 127.0.0.1 and a free port, with a one-off INGEST_SECRET in a 0600 env file in a temp dir, and never reads .dev.vars', async () => {
    mode({ what: 'serve' });
    // A .dev.vars in the session's cwd that nobody may read: unreadable, so a read would throw.
    writeFileSync(join(dir, '.dev.vars'), 'INGEST_SECRET=from-dev-vars\n');
    chmodSync(join(dir, '.dev.vars'), 0o000);
    const { o } = opts({ env: { ...process.env, FAKE_DIR: dir, INGEST_SECRET: 'inherited' } });
    const seen = await withRemoteSession(async (s) => s, o);
    chmodSync(join(dir, '.dev.vars'), 0o600);
    expect(readFileSync(join(dir, '.dev.vars'), 'utf8')).toBe('INGEST_SECRET=from-dev-vars\n');
    const [start] = starts();
    expect(start.args.slice(0, 5)).toEqual(['dev', '--remote', '--ip', '127.0.0.1', '--port']);
    expect(Number(start.args[5])).toBe(seen.port);
    expect(RESERVED_PORTS).not.toContain(seen.port);
    expect(seen.url).toBe(`http://127.0.0.1:${seen.port}`);
    // The secret is one-off: in the env file only, never .dev.vars' and never the parent's.
    expect(start.envFile?.startsWith(dir)).toBe(false);
    expect(start.envMode).toBe(0o600);
    expect(start.envText).toBe(`INGEST_SECRET=${seen.secret}\n`);
    expect(seen.secret).toMatch(/^[0-9a-f]{48}$/);
    expect(start.inheritedSecret).toBeNull();
    // The temp dir is gone afterwards, and the child with it.
    expect(existsSync(/** @type {string} */ (start.envFile))).toBe(false);
    expect(alive(start.pid)).toBe(false);
  });

  it(`refuses the reserved ports ${RESERVED_PORTS.join(' and ')} before starting anything, and a port already in use`, async () => {
    mode({ what: 'serve' });
    for (const port of RESERVED_PORTS) {
      await expect(withRemoteSession(async () => 'ran', opts({ port }).o)).rejects.toThrow(new RegExp(`port ${port} is reserved`));
    }
    expect(starts()).toEqual([]);
    const { createServer } = await import('node:net');
    const server = await new Promise((resolve) => { const s = createServer().listen(0, '127.0.0.1', () => resolve(s)); });
    const port = /** @type {import('node:net').AddressInfo} */ (/** @type {import('node:net').Server} */ (server).address()).port;
    try {
      await expect(withRemoteSession(async () => 'ran', opts({ port }).o)).rejects.toThrow(new RegExp(`port ${port} is in use`));
    } finally {
      /** @type {import('node:net').Server} */ (server).close();
    }
    expect(starts()).toEqual([]);
  });

  it('a free port is never a reserved one', async () => {
    for (let i = 0; i < 5; i++) expect(RESERVED_PORTS).not.toContain(await freePort());
  });

  it('retries code 10021, logging each try, then runs the command once the session answers', async () => {
    mode({ what: 'serve', failFirst: 3 });
    const clock = fakeClock();
    const run = startRun('remote', { dir: join(dir) });
    const { o, lines } = opts({ ...clock, retryDelayMs: 30_000, record: run });
    const out = await withRemoteSession(async ({ tries }) => `ran after ${tries} tries`, o);
    expect(out).toBe('ran after 4 tries');
    expect(starts()).toHaveLength(4);
    expect(lines.filter((l) => /code 10021/.test(l))).toHaveLength(3);
    expect(lines.join('\n')).toMatch(/try 1 .*code 10021.*retrying in 30 s/);
    for (const s of starts()) expect(alive(s.pid)).toBe(false);
    expect(run.data.details.tries).toEqual([
      expect.objectContaining({ n: 1, result: '10021' }), expect.objectContaining({ n: 2, result: '10021' }),
      expect.objectContaining({ n: 3, result: '10021' }), expect.objectContaining({ n: 4, result: 'answered' }),
    ]);
  });

  it('a session that prints 10021 but stays up, holding /health unanswered, is killed and retried at once', async () => {
    mode({ what: 'hang10021' });
    const clock = fakeClock();
    // A held /health never settles by itself: the 10021 line must end the poll, not a timeout.
    const { o } = opts({ ...clock, retryDelayMs: 600_000, pollTimeoutMs: 60_000, healthTimeoutMs: 60_000 });
    const started = Date.now();
    await expect(withRemoteSession(async () => 'ran', o)).rejects.toThrow(/10021 on 4 tries/);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(starts()).toHaveLength(4);
    for (const s of starts()) expect(alive(s.pid)).toBe(false);
  });

  it('a held /health with no 10021 ends at the per-poll timeout, and the try at the health deadline', async () => {
    mode({ what: 'hang10021' });
    writeFileSync(join(dir, 'fake-wrangler.mjs'), FAKE.replace("setTimeout(() => process.stderr.write(err10021), 200);", ''));
    const started = Date.now();
    await expect(withRemoteSession(async () => 'ran', opts({ pollTimeoutMs: 200, healthTimeoutMs: 1500 }).o)).rejects.toThrow(/did not answer \/health within 1.5s/);
    expect(Date.now() - started).toBeLessThan(8000);
    expect(alive(starts()[0].pid)).toBe(false);
  });

  it(`stops retrying at the limit (${RETRY_LIMIT_MS / 60_000} minutes) and never runs the command`, async () => {
    mode({ what: 'fail10021' });
    const clock = fakeClock();
    let ran = false;
    const { o } = opts({ ...clock, retryDelayMs: 300_000 });
    await expect(withRemoteSession(async () => { ran = true; }, o)).rejects.toThrow(/code 10021 on 7 tries over 30 min/);
    expect(ran).toBe(false);
    // Tries at 0, 5, 10, ... 30 minutes; none after the limit.
    expect(starts()).toHaveLength(7);
    for (const s of starts()) expect(alive(s.pid)).toBe(false);
  });

  it('does not retry another error', async () => {
    mode({ what: 'other' });
    await expect(withRemoteSession(async () => 'ran', opts(fakeClock()).o)).rejects.toThrow(/exited \(1\) before answering/);
    expect(starts()).toHaveLength(1);
  });

  it('always kills the child: when the command throws, and when the child ignores SIGTERM', async () => {
    mode({ what: 'serve' });
    await expect(withRemoteSession(async () => { throw new Error('command failed'); }, opts().o)).rejects.toThrow('command failed');
    expect(alive(starts()[0].pid)).toBe(false);
    mode({ what: 'stubborn' });
    await withRemoteSession(async () => 'ok', opts({ killGraceMs: 300 }).o);
    expect(alive(starts()[1].pid)).toBe(false);
  });

  it('a SIGHUP stops the session at once, even when signals are deferred to the command', async () => {
    mode({ what: 'serve' });
    const { EventEmitter } = await import('node:events');
    const proc = new EventEmitter();
    /** @type {string[]} */
    const heard = [];
    const { o } = opts({ proc: /** @type {any} */ (proc), deferSignals: true, onSignal: (sig, phase) => heard.push(`${sig} ${phase}`) });
    await expect(withRemoteSession(async () => {
      proc.emit('SIGHUP');
      return new Promise(() => {});
    }, o)).rejects.toThrow(/SIGHUP/);
    expect(heard).toEqual(['SIGHUP stopping']);
    expect(alive(starts()[0].pid)).toBe(false);
    expect(existsSync(/** @type {string} */ (starts()[0].envFile))).toBe(false);
  });

  it('kills the child and removes its dir on SIGINT, before the process exits', async () => {
    mode({ what: 'serve' });
    const { EventEmitter } = await import('node:events');
    const proc = Object.assign(new EventEmitter(), { exitCode: /** @type {number | undefined} */ (undefined) });
    const { o } = opts({ proc: /** @type {any} */ (proc) });
    await expect(withRemoteSession(async () => {
      proc.emit('SIGINT');
      return new Promise(() => {}); // the command never ends on its own
    }, o)).rejects.toThrow(/SIGINT/);
    const [start] = starts();
    expect(alive(start.pid)).toBe(false);
    expect(existsSync(/** @type {string} */ (start.envFile))).toBe(false);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });
});

describe('npm run remote -- <command…>', () => {
  it('runs the command with WORKER_URL and INGEST_SECRET set, then stops the session; one run record', async () => {
    mode({ what: 'serve' });
    const runs = join(dir, 'runs');
    const out = join(dir, 'child.json');
    const code = await remoteMain([process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ url: process.env.WORKER_URL, secret: process.env.INGEST_SECRET, target: process.env.VNM_REMOTE_TARGET }))`], {
      session: opts().o, runsDir: runs, log: () => {},
    });
    expect(code).toBe(0);
    const child = JSON.parse(readFileSync(out, 'utf8'));
    const [start] = starts();
    expect(child.url).toBe(`http://127.0.0.1:${start.args[5]}`);
    expect(start.envText).toBe(`INGEST_SECRET=${child.secret}\n`);
    expect(child.target).toMatch(/wrangler dev --remote/);
    expect(alive(start.pid)).toBe(false);
    const files = readdirSync(runs);
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(runs, files[0]), 'utf8'));
    expect(record).toMatchObject({
      script: 'remote', outcome: 'ok', exitCode: 0, requests: { 'wrangler dev --remote': 1 },
      details: { port: Number(start.args[5]), tries: [expect.objectContaining({ result: 'answered' })] },
    });
    expect(JSON.stringify(record)).not.toContain(child.secret);
  });

  it('passes a SIGTERM sent to it alone on to the command, and records the run as interrupted', async () => {
    mode({ what: 'serve' });
    const runs = join(dir, 'runs');
    const { EventEmitter } = await import('node:events');
    const proc = new EventEmitter();
    const ready = join(dir, 'ready');
    const cmd = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, ''); process.on('SIGTERM', () => process.exit(143)); setInterval(() => {}, 1000);`;
    const pending = remoteMain([process.execPath, '-e', cmd], { session: { ...opts().o, proc: /** @type {any} */ (proc) }, runsDir: runs, log: () => {} });
    while (!existsSync(ready)) await new Promise((r) => { setTimeout(r, 50); });
    proc.emit('SIGTERM');
    expect(await pending).toBe(143);
    const [file] = readdirSync(runs);
    expect(JSON.parse(readFileSync(join(runs, file), 'utf8'))).toMatchObject({ outcome: 'interrupted', exitCode: 143, details: { signals: ['SIGTERM'] } });
    expect(alive(starts()[0].pid)).toBe(false);
  });

  it('a second signal stops the session and the command at once', async () => {
    mode({ what: 'serve' });
    const runs = join(dir, 'runs');
    const { EventEmitter } = await import('node:events');
    const proc = new EventEmitter();
    const ready = join(dir, 'ready');
    // The command ignores SIGINT, as one still finishing in-flight work would.
    const cmd = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);`;
    const pending = remoteMain([process.execPath, '-e', cmd], { session: { ...opts().o, proc: /** @type {any} */ (proc) }, runsDir: runs, log: () => {} });
    while (!existsSync(ready) || !readFileSync(ready, 'utf8')) await new Promise((r) => { setTimeout(r, 50); });
    const commandPid = Number(readFileSync(ready, 'utf8'));
    proc.emit('SIGINT');
    proc.emit('SIGINT');
    expect(await pending).toBe(130);
    await new Promise((r) => { setTimeout(r, 200); });
    expect(alive(commandPid)).toBe(false);
    expect(alive(starts()[0].pid)).toBe(false);
  });

  it('expands ingest, verify and vectors to their scripts, passes the command\'s exit code through, and records a failure', async () => {
    mode({ what: 'serve' });
    const runs = join(dir, 'runs');
    /** @type {string[][]} */
    const ran = [];
    const code = await remoteMain(['verify', '--pre-deploy'], {
      session: opts().o, runsDir: runs, log: () => {},
      runCommand: async (cmd, args) => { ran.push([cmd, ...args]); return 1; },
    });
    expect(code).toBe(1);
    expect(ran).toEqual([[process.execPath, expect.stringMatching(/scripts\/verify\.mjs$/), '--pre-deploy']]);
    const [file] = readdirSync(runs);
    expect(JSON.parse(readFileSync(join(runs, file), 'utf8'))).toMatchObject({ script: 'remote', outcome: 'failed', exitCode: 1 });
  });

  it('a session that never answers: the command never runs, one record, outcome failed', async () => {
    mode({ what: 'other' });
    const runs = join(dir, 'runs');
    let ran = false;
    const code = await remoteMain(['verify'], { session: opts(fakeClock()).o, runsDir: runs, log: () => {}, runCommand: async () => { ran = true; return 0; } });
    expect(code).toBe(1);
    expect(ran).toBe(false);
    const [file] = readdirSync(runs);
    expect(JSON.parse(readFileSync(join(runs, file), 'utf8'))).toMatchObject({ outcome: 'failed' });
  });

  it('refuses no command, and a reserved --port, without starting anything', async () => {
    expect(await remoteMain([], { session: opts().o, runsDir: join(dir, 'runs'), log: () => {} })).toBe(2);
    expect(await remoteMain(['--port', '8787', 'verify'], { session: opts().o, runsDir: join(dir, 'runs'), log: () => {} })).toBe(2);
    expect(starts()).toEqual([]);
    expect(existsSync(join(dir, 'runs'))).toBe(false);
    expect(statSync(dir).isDirectory()).toBe(true);
  });
});
