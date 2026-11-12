// @ts-check
// Runs one command against production D1, Vectorize and Workers AI through a
// fresh `wrangler dev --remote` session (Phase 7 7C; scripts/remote-session.mjs):
//
//   npm run remote -- [--port <n>] <command…>
//   npm run remote -- ingest --d1-only
//   npm run remote -- verify --pre-deploy
//   npm run remote -- vectors standby
//
// `ingest`, `verify` and `vectors` run scripts/<name>.mjs with this Node; any
// other command runs as given, without a shell. The command gets WORKER_URL
// (the session) and INGEST_SECRET (a one-off), and VNM_REMOTE_TARGET for its
// own run record. The session stops when the command ends, whatever its exit
// code, which this passes through. This replaces the old runbook's `.dev.vars`
// swap: nothing here reads or writes `.dev.vars`.
//
// Writes one run record (script `remote`): the port, each try, the command,
// its exit code. The command writes its own.
//
// Signals: a Ctrl-C reaches the command from the terminal, and the session
// stays up while the command stops cleanly (ingest records its in-flight
// mutations). A SIGTERM sent to this pid alone is passed on to the command.
// A second signal, or a SIGHUP, stops the session and the command at once.
//
// Exit codes: the command's; 1 when the session never answered; 2 on a usage
// error; 130/143/129 on SIGINT/SIGTERM/SIGHUP.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSION_TARGET, reservedPortError, withRemoteSession } from './remote-session.mjs';
import { startRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Commands that name a script in scripts/. */
export const SCRIPTS = ['ingest', 'verify', 'vectors'];

/**
 * @typedef {(cmd: string, args: string[], env: NodeJS.ProcessEnv, started?: (child: import('node:child_process').ChildProcess) => void) => Promise<number>} RunCommand
 */

/** @type {Partial<Record<NodeJS.Signals, number>>} */
const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** @type {RunCommand} */
const spawnCommand = (cmd, args, env, started = () => {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  started(child);
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal ? SIGNAL_EXIT[signal] ?? 1 : 1)));
});

/**
 * @param {string[]} argv
 * @param {{ session?: import('./remote-session.mjs').SessionOptions, runsDir?: string, log?: (line: string) => void,
 *   runCommand?: RunCommand, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { session = {}, runsDir, log = console.error, runCommand = spawnCommand, env = process.env } = deps;
  const args = [...argv];
  /** @type {number | undefined} */
  let port;
  if (args[0] === '--port') {
    port = Number(args[1]);
    args.splice(0, 2);
    const reserved = Number.isInteger(port) && port > 0 ? reservedPortError(port) : `--port must be a port number`;
    if (reserved) { log(`remote: ${reserved}`); return 2; }
  }
  if (args[0] === '--') args.shift();
  if (!args.length) {
    log('usage: npm run remote -- [--port <n>] <command…>   (ingest, verify and vectors name their scripts)');
    return 2;
  }
  const [cmd, ...rest] = SCRIPTS.includes(args[0]) ? [process.execPath, `${ROOT}scripts/${args[0]}.mjs`, ...args.slice(1)] : args;

  const run = startRun('remote', { target: SESSION_TARGET, args: argv, dir: runsDir });
  run.detail('command', SCRIPTS.includes(args[0]) ? args : [cmd, ...rest]);
  // A crash still leaves the record; signals are the session's (deferred to the command).
  const unguard = run.guardExit(process, { signals: false });
  /** The command, once started, so a signal can reach it. @type {import('node:child_process').ChildProcess | null} */
  let command = null;
  /** @type {NodeJS.Signals[]} */
  const signals = [];
  run.detail('signals', signals);
  /** @param {NodeJS.Signals} sig @param {'deferred' | 'stopping'} phase */
  const onSignal = (sig, phase) => {
    signals.push(sig);
    // A Ctrl-C already reached the command from the terminal; a SIGTERM may have come to this pid only.
    if (command && command.exitCode === null && (phase === 'stopping' || sig === 'SIGTERM')) command.kill(phase === 'stopping' ? 'SIGKILL' : sig);
  };
  try {
    const code = await withRemoteSession(async ({ url, secret, port: bound }) => {
      log(`remote: running ${args.join(' ')} with WORKER_URL=${url}`);
      return runCommand(cmd, rest, {
        ...env, WORKER_URL: url, INGEST_SECRET: secret, VNM_REMOTE_TARGET: `${SESSION_TARGET} on 127.0.0.1:${bound}`,
      }, (child) => { command = child; });
    }, { log, record: run, deferSignals: true, onSignal, ...session, ...(port !== undefined ? { port } : {}) });
    run.detail('commandExitCode', code);
    const outcome = code === 0 ? 'ok' : Object.values(SIGNAL_EXIT).includes(code) ? 'interrupted' : 'failed';
    run.finish(outcome, { exitCode: code, message: `the command exited ${code}${signals.length ? ` after ${signals.join(', ')}` : ''}` });
    log(`remote: session stopped; the command exited ${code}; record ${run.path}`);
    unguard();
    return code;
  } catch (err) {
    const message = String(/** @type {Error} */ (err).message ?? err);
    const signal = /** @type {NodeJS.Signals | undefined} */ (/^(SIGINT|SIGTERM|SIGHUP):/.exec(message)?.[1]);
    const code = signal ? SIGNAL_EXIT[signal] ?? 1 : 1;
    run.finish(signal ? 'interrupted' : 'failed', { exitCode: code, message: message.split('\n')[0] });
    log(`remote: ${message}`);
    unguard();
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
