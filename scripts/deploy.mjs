// @ts-check
// The only supported way to deploy:
//
//   npm run deploy
//
// Refuses unless the working tree is clean and HEAD is already on origin/main,
// so every deployed version maps to a pushed commit. Then runs
//   wrangler deploy --tag <short sha> --message "<sha> <subject>"
// and prints the version id. The Worker reports the tag as `x-app-version` and
// in GET /health (version_metadata binding).
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Cloudflare caps version messages at 100 characters.
const MAX_MESSAGE = 100;

/**
 * @typedef {{ code: number, stdout: string }} ExecResult
 * @typedef {(cmd: string, args: string[], opts?: { stream?: boolean }) => Promise<ExecResult>} Exec
 *   Runs a command without a shell. With `stream`, stdout is also echoed live.
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
 * @param {{ exec?: Exec, log?: (msg: string) => void, error?: (msg: string) => void }} [deps]
 * @returns {Promise<number>} The process exit code.
 */
export async function deploy({ exec = run, log = console.log, error = console.error } = {}) {
  /** @param {string[]} args */
  const git = async (args) => {
    const res = await exec('git', args);
    return { ...res, out: res.stdout.trim() };
  };

  const status = await git(['status', '--porcelain']);
  if (status.code !== 0) { error('deploy: `git status` failed.'); return 1; }
  if (status.out !== '') {
    error(`deploy: refusing, the working tree is not clean:\n${status.out}\nCommit (via a PR to main) or discard these first.`);
    return 1;
  }

  const fetched = await git(['fetch', '--quiet', 'origin', 'main']);
  if (fetched.code !== 0) { error('deploy: refusing, could not fetch origin/main to check HEAD is pushed.'); return 1; }

  const head = await git(['rev-parse', 'HEAD']);
  const tip = await git(['rev-parse', 'origin/main']);
  if (head.code !== 0 || tip.code !== 0) { error('deploy: `git rev-parse` failed.'); return 1; }
  const onMain = await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
  if (onMain.code === 1) {
    error(`deploy: refusing, HEAD ${head.out} is not on origin/main. Merge it to main first.`);
    return 1;
  }
  if (onMain.code !== 0) { error('deploy: `git merge-base` failed.'); return 1; }
  if (head.out !== tip.out) {
    log(`deploy: note: HEAD ${head.out} is behind origin/main (${tip.out}); deploying the older commit.`);
  }

  const short = (await git(['rev-parse', '--short', 'HEAD'])).out;
  const subject = (await git(['log', '-1', '--format=%s'])).out;
  const message = `${short} ${subject}`.slice(0, MAX_MESSAGE);

  log(`deploy: wrangler deploy --tag ${short} --message "${message}"`);
  const wrangler = await exec('npx', ['wrangler', 'deploy', '--tag', short, '--message', message], { stream: true });
  if (wrangler.code !== 0) { error(`deploy: wrangler deploy failed (exit ${wrangler.code}).`); return wrangler.code; }

  const versionId = wrangler.stdout.match(/Current Version ID:\s*([0-9a-f-]{36})/i)?.[1];
  if (versionId) log(`deploy: version ${versionId} (tag ${short}) is live.`);
  else error('deploy: deployed, but no version id in wrangler output; check `npx wrangler deployments list`.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await deploy();
}
