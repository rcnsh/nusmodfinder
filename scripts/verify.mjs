// @ts-check
// Do D1 and Vectorize agree? Exits non-zero on drift.
//
//   npm run remote -- verify [--pre-deploy]   (the runbook: a session sets WORKER_URL)
//   npm run verify -- --url <base>
//
// D1 side through the Worker's /admin/verify (INGEST_SECRET, like ingest);
// vector ids from `wrangler vectorize list-vectors <index> --json`, paged
// 1,000 at a time. Run it against the same `wrangler dev --remote` Worker as
// ingest (docs/REFERENCE.md "Re-ingesting"), after ingest reports done. What counts as
// drift: scripts/verify-core.mjs.
//
// Flags: --url <base> (else $WORKER_URL; no default, and ports 8787 and 8799
// are refused: Phase 7 7C),
// --index <name> (default the wrangler.jsonc index), --sample <n> (default 100,
// max 100), --json (print the report as JSON).
//
// Phase 3 splits verify in two (docs/plans/phase3.md 3-0, B2-1):
//   --pre-deploy [--bundle production|pinned|fixture]   runbook step 5, before
//     the deploy: D1's (code, text_hash) pairs equal the manifest's rowsKey,
//     D1's data version equals the committed one, and the bundle's codes and
//     filter table equal D1's fields. Reads no Vectorize.
//   (default)   after runbook step 8: today's check (Vectorize metadata
//     against D1, and the id list). `--values` (or scripts/vectors.mjs
//     standby) also compares a getByIds sample of values with the production
//     bundle's bits.
// Exit codes: 0 agree; 1 drift; 2 could not verify.
// Each run past its arguments writes a run record (scripts/run-record.mjs):
// requests by path, D1 rows read, the outcome (drift is `failed`).
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { run } from './deploy.mjs';
import { DATA_VERSION_PATH, httpAdminApi } from './ingest.mjs';
import { readBundledCatalogue } from './catalogue-check.mjs';
import { formatPreDeployReport, formatReport, runPreDeployVerify, runVerify } from './verify-core.mjs';
import { loadCheckedBundle, readVectorsManifest } from './vectors-manifest.mjs';
import { workerUrl } from './remote-session.mjs';
import { startRun } from './run-record.mjs';

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
    // `--cursor=<value>` in one word: cursors are base64url and can start with "-", and wrangler
    // reads a separate "-h…" as --help (the usage, exit 0) and any other "-…" as unknown flags.
    const args = ['wrangler', 'vectorize', 'list-vectors', index, '--json', '--count', '1000', ...(cursor ? [`--cursor=${cursor}`] : [])];
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
 * 6A: the year files this deploy ships, and the NG list of the year the reason texts name.
 * @param {string} acadYear
 * @returns {import('./verify-core.mjs').PreDeployDataFiles}
 */
export function preDeployDataFiles(acadYear) {
  const read = (/** @type {string} */ rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'));
  const unscheduled = read('data/ng-unscheduled.json');
  const ng = read(`data/ng-courses-${acadYear}.json`);
  return {
    ngReasonsAcadYear: acadYear,
    unscheduled: { acadYear: unscheduled.acadYear, codes: unscheduled.modules.map((/** @type {{ code: string }} */ e) => e.code) },
    ngCodes: [...new Set(Object.values(/** @type {Record<string, string[]>} */ (ng.semesters)).flat())],
  };
}

/**
 * @param {string[]} argv
 * @param {{ fetchImpl?: typeof fetch, exec?: import('./deploy.mjs').Exec, log?: (line: string) => void,
 *   envVars?: Record<string, string | undefined>, runsDir?: string }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, deps = {}) {
  const { fetchImpl: rawFetch = fetch, exec = run, log = console.log, envVars = process.env, runsDir } = deps;
  const { values } = parseArgs({
    args: argv,
    options: {
      url: { type: 'string' }, index: { type: 'string' }, sample: { type: 'string' }, json: { type: 'boolean' },
      'pre-deploy': { type: 'boolean' }, bundle: { type: 'string' }, values: { type: 'boolean' },
    },
    strict: true,
  });
  const secret = envVars.INGEST_SECRET;
  if (!secret) {
    log('INGEST_SECRET is not set. Run it through `npm run remote -- verify …`, or export the value the Worker is bound to.');
    return 2;
  }
  const worker = workerUrl(values.url, envVars);
  if (worker.error !== undefined) { log(`verify: ${worker.error} Nothing was sent.`); return 2; }
  const base = worker.base;
  const sampleSize = values.sample ? Number(values.sample) : 100;
  if (!Number.isInteger(sampleSize) || sampleSize < 0 || sampleSize > 100) {
    log('--sample must be an integer from 0 to 100');
    return 2;
  }
  const record = startRun('verify', { target: envVars.VNM_REMOTE_TARGET ? `${base} (${envVars.VNM_REMOTE_TARGET})` : base, args: argv, dir: runsDir });
  record.detail('mode', values['pre-deploy'] ? 'pre-deploy' : 'post-standby');
  const fetchImpl = record.countingFetch(rawFetch);
  const unguard = record.guardExit();
  /** @param {number} code @param {string | null} [message] */
  const done = (code, message = null) => {
    unguard();
    record.finish(code === 0 ? 'ok' : 'failed', { exitCode: code, message });
    return code;
  };
  /** Each `wrangler vectorize list-vectors` page is a Cloudflare API call. @type {import('./deploy.mjs').Exec} */
  const countedExec = (cmd, args, opts) => {
    if (cmd === 'npx' && args[0] === 'wrangler') record.request(`wrangler ${args.slice(1, 3).join(' ')}`);
    return exec(cmd, args, opts);
  };
  try {
    const corpus = /** @type {'production' | 'pinned' | 'fixture'} */ (values.bundle ?? 'production');
    if (!['production', 'pinned', 'fixture'].includes(corpus)) { log('--bundle must be production, pinned or fixture'); return done(2, 'bad --bundle'); }
    const loadBundle = async () => {
      const entry = (await readVectorsManifest()).bundles[corpus];
      if (!entry) throw new Error(`data/vectors.json has no ${corpus} bundle`);
      return { entry, ...(await loadCheckedBundle(entry)) };
    };
    if (values['pre-deploy']) {
      const { entry, bundle } = await loadBundle();
      const committedDataVersion = String(JSON.parse(await readFile(DATA_VERSION_PATH, 'utf8')).version);
      // Phase 4 (B3-5): every stored rule id has a text in the reasons this deploy ships.
      const ngReasons = JSON.parse(readFileSync(new URL('../data/ng-reasons.json', import.meta.url), 'utf8'));
      const reasons = ngReasons.reasons;
      const report = await runPreDeployVerify({
        api: httpAdminApi(base, secret, fetchImpl), bundle, manifest: entry, committedDataVersion,
        knownReason: (id) => Object.hasOwn(reasons, id), dataFiles: preDeployDataFiles(ngReasons.acadYear),
        // Phase 7 7D: D1's catalogue_only against the catalogue file this deploy bundles.
        catalogue: await readBundledCatalogue(),
      });
      if (values.json) log(JSON.stringify(report, null, 2));
      else for (const l of formatPreDeployReport(report)) log(l);
      record.read('D1 rows (/admin/hashes and fields)', { estimate: entry.count, actual: report.rowsRead });
      return done(report.ok ? 0 : 1, report.ok ? 'D1 agrees with the manifest and the bundle' : 'drift');
    }
    const report = await runVerify({
      api: httpAdminApi(base, secret, fetchImpl),
      listVectorIds: () => listVectorIds(values.index ?? DEFAULT_INDEX, countedExec),
      sampleSize,
      ...(values.values ? { bundle: (await loadBundle()).bundle } : {}),
    });
    if (values.json) log(JSON.stringify(report, null, 2));
    else for (const l of formatReport(report)) log(l);
    record.read('D1 rows (/admin/verify)', { actual: report.rowsRead });
    record.read('Vectorize ids listed (wrangler vectorize list-vectors)', { actual: report.vectors });
    return done(report.ok ? 0 : 1, report.ok ? 'D1 and Vectorize agree' : 'drift');
  } catch (err) {
    log(`verify failed: ${/** @type {Error} */ (err).message}`);
    return done(2, String(/** @type {Error} */ (err).message).split('\n')[0]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
