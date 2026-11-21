// @ts-check
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

export const DEFAULT_INDEX = 'nusmods-modules';
const MAX_PAGES = 1000;

/**
 * @param {string} index
 * @param {import('./deploy.mjs').Exec} exec
 */
export async function listVectorIds(index, exec = run) {
  /** @type {string[]} */
  const ids = [];
  /** @type {string | null} */
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
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
  /** @type {import('./deploy.mjs').Exec} */
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
      const ngReasons = JSON.parse(readFileSync(new URL('../data/ng-reasons.json', import.meta.url), 'utf8'));
      const reasons = ngReasons.reasons;
      const report = await runPreDeployVerify({
        api: httpAdminApi(base, secret, fetchImpl), bundle, manifest: entry, committedDataVersion,
        knownReason: (id) => Object.hasOwn(reasons, id), dataFiles: preDeployDataFiles(ngReasons.acadYear),
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
