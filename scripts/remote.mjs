// @ts-check
// Runs one command against production D1, Vectorize and Workers AI through a
// fresh `wrangler dev --remote` session (Phase 7 7C; scripts/remote-session.mjs):
//
//   npm run remote -- [--port <n>] <command…>
//   npm run remote -- ingest --d1-only --offline
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
// Exit codes: the command's; 1 when the session never answered; 2 on a usage
// error; 130/143 on SIGINT/SIGTERM.
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SESSION_TARGET, reservedPortError, withRemoteSession } from './remote-session.mjs';
import { startRun } from './run-record.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** Commands that name a script in scripts/. */
export const SCRIPTS = ['ingest', 'verify', 'vectors'];

/**
 * @typedef {(cmd: string, args: string[], env: NodeJS.ProcessEnv) => Promise<number>} RunCommand
 */

/** @type {RunCommand} */
const spawnCommand = (cmd, args, env) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, { stdio: 'inherit', env });
  child.once('error', reject);
  child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1)));
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
  try {
    const code = await withRemoteSession(async ({ url, secret, port: bound }) => {
      log(`remote: running ${args.join(' ')} with WORKER_URL=${url}`);
      return runCommand(cmd, rest, {
        ...env, WORKER_URL: url, INGEST_SECRET: secret, VNM_REMOTE_TARGET: `${SESSION_TARGET} on 127.0.0.1:${bound}`,
      });
    }, { log, record: run, deferSignals: true, ...session, ...(port !== undefined ? { port } : {}) });
    run.detail('commandExitCode', code);
    const outcome = code === 0 ? 'ok' : code === 130 || code === 143 ? 'interrupted' : 'failed';
    run.finish(outcome, { exitCode: code, message: `the command exited ${code}` });
    log(`remote: session stopped; the command exited ${code}; record ${run.path}`);
    return code;
  } catch (err) {
    const message = String(/** @type {Error} */ (err).message ?? err);
    const signal = /^(SIGINT|SIGTERM):/.exec(message)?.[1];
    const code = signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
    run.finish(signal ? 'interrupted' : 'failed', { exitCode: code, message: message.split('\n')[0] });
    log(`remote: ${message}`);
    return code;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
