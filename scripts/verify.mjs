// @ts-check
// Do D1 and Vectorize agree? Exits non-zero on drift.
//
//   npm run verify -- --url http://localhost:8787
//
// D1 side through the Worker's /admin/verify (INGEST_SECRET, like ingest);
// vector ids from `wrangler vectorize list-vectors <index> --json`, paged
// 1,000 at a time. Run it against the same `wrangler dev --remote` Worker as
// ingest (README "Re-ingesting"), after ingest reports done. What counts as
// drift: scripts/verify-core.mjs.
//
// Flags: --url <base> (default $WORKER_URL or http://localhost:8787),
// --index <name> (default the wrangler.jsonc index), --sample <n> (default 100,
// max 100), --json (print the report as JSON).
// Exit codes: 0 agree; 1 drift; 2 could not verify.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from './deploy.mjs';
import { httpAdminApi } from './ingest.mjs';
import { formatReport, runVerify } from './verify-core.mjs';

/** The binding's index in wrangler.jsonc (a test keeps them equal). */
export const DEFAULT_INDEX = 'nusmods-modules';
/** Pages of 1,000 ids; 6,771 vectors take 7. Stops a cursor loop. */
const MAX_PAGES = 1000;

/**
 * Every vector id in the index, via `wrangler vectorize list-vectors --json`.
 * @param {string} index
 * @param {import('./deploy.mjs').Exec} exec
 */
export async function listVectorIds(index, exec = run) {
  /** @type {string[]} */
  const ids = [];
  /** @type {string | null} */
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['wrangler', 'vectorize', 'list-vectors', index, '--json', '--count', '1000', ...(cursor ? ['--cursor', cursor] : [])];
    const { code, stdout } = await exec('npx', args);
    if (code !== 0) throw new Error(`wrangler vectorize list-vectors exited ${code}`);
    const start = stdout.indexOf('{');
    /** @type {{ vectors?: { id: string }[], isTruncated?: boolean, nextCursor?: string | null }} */
    let body;
    try {
      body = JSON.parse(stdout.slice(start));
    } catch {
      throw new Error(`wrangler vectorize list-vectors printed no JSON: ${stdout.slice(0, 200)}`);
    }
    if (!Array.isArray(body.vectors)) throw new Error('wrangler vectorize list-vectors: no "vectors" array in its JSON');
    ids.push(...body.vectors.map((v) => v.id));
    if (!body.isTruncated || !body.nextCursor) return ids;
    cursor = body.nextCursor;
  }
  throw new Error(`wrangler vectorize list-vectors: more than ${MAX_PAGES} pages`);
}

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, exec?: import('./deploy.mjs').Exec, log?: (line: string) => void,
 *   envVars?: Record<string, string | undefined> }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { fetchImpl = fetch, exec = run, log = console.log, envVars = process.env } = deps;
  const { values } = parseArgs({
    args: argv,
    options: { url: { type: 'string' }, index: { type: 'string' }, sample: { type: 'string' }, json: { type: 'boolean' } },
    strict: true,
  });
  const secret = envVars.INGEST_SECRET;
  if (!secret) {
    log('INGEST_SECRET is not set. Export the same value the Worker is bound to.');
    return 2;
  }
  const base = (values.url ?? envVars.WORKER_URL ?? 'http://localhost:8787').replace(/\/$/, '');
  const sampleSize = values.sample ? Number(values.sample) : 100;
  if (!Number.isInteger(sampleSize) || sampleSize < 0 || sampleSize > 100) {
    log('--sample must be an integer from 0 to 100');
    return 2;
  }
  try {
    const report = await runVerify({
      api: httpAdminApi(base, secret, fetchImpl),
      listVectorIds: () => listVectorIds(values.index ?? DEFAULT_INDEX, exec),
      sampleSize,
    });
    if (values.json) log(JSON.stringify(report, null, 2));
    else for (const l of formatReport(report)) log(l);
    return report.ok ? 0 : 1;
  } catch (err) {
    log(`verify failed: ${/** @type {Error} */ (err).message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
