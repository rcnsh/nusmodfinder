#!/usr/bin/env node
// @ts-check
// The production corpus manifest's commands (Phase 7 7D, scripts/corpus-manifest.mjs):
//
//   npm run corpus -- fetch [<year>]
//       NUSMods' moduleInfo.json for <year> (default DEFAULT_ACAD_YEAR) into
//       .data/staging/, with a sidecar recording when it was served. The only
//       command that contacts api.nusmods.com.
//   npm run corpus -- publish [--file <path>] [--fetched-at <ISO time>] [--new-data-version]
//       Uploads the staged corpus (or --file, with --fetched-at unless a
//       <file>.cache.json sidecar records it) as release asset
//       prod-<year>-<yyyymmdd> (gz), writes its entry in data/corpus.json and
//       sets `current`. Refuses a corpus whose data version (with HEAD's NG
//       files) is not src/data-version.json unless --new-data-version, and a
//       release already in the manifest. Writes a run record. Commit
//       data/corpus.json afterwards.
//   npm run corpus -- restore
//       Downloads `current` (gh), sha-checks it and writes
//       .data/prod/<sha256>.json: what ingest, `vectors.mjs build --corpus
//       production` and every per-corpus builder read. Any worktree.
//   npm run corpus -- check
//       CI: `current`'s data version with HEAD's NG files equals
//       src/data-version.json, its catalogueKey equals the bundled catalogue
//       file's, and data/'s per-corpus 3B files are what the build writes from it.
//
// `preflight()` is the deploy preflight's "corpus manifest" check (scripts/preflight.mjs, 7B):
// restore, then the same check.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build as build3b, staleFiles } from './build-3b-data.mjs';
import { checkCurrent, fetchStaging, publishCorpus, restoreCurrent } from './corpus-manifest.mjs';
import { DEFAULT_ACAD_YEAR } from './lib.mjs';

/**
 * `check`'s comparisons: current's data version and catalogueKey, and the 3B files' freshness.
 * @param {{ check?: typeof checkCurrent, built?: () => Promise<Record<string, string>>, stale?: typeof staleFiles }} [deps]
 */
export async function corpusCheck({ check = checkCurrent, built = () => build3b('production'), stale = staleFiles } = {}) {
  const r = await check();
  const problems = [...r.problems];
  for (const rel of await stale(await built())) problems.push(`${rel} is not what node scripts/build-3b-data.mjs --corpus production writes from current`);
  return { ...r, ok: problems.length === 0, problems };
}

/**
 * The deploy preflight's "corpus manifest" check (Phase 7 7B's optional-check contract,
 * `{ ok, message }`): restores `current` (sha-checked; a no-op when it is already there), then
 * corpusCheck. A deploy whose src/data-version.json, bundled catalogue file or 3B files don't
 * follow current stops here, before D1 is read.
 * @param {{ log?: (line: string) => void, restore?: typeof restoreCurrent, check?: typeof corpusCheck }} [deps]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function preflight({ log = console.log, restore = restoreCurrent, check = corpusCheck } = {}) {
  try {
    await restore({ log: (line) => log(`deploy: preflight: ${line}`) });
  } catch (err) {
    return { ok: false, message: `could not restore current (npm run corpus -- restore): ${/** @type {Error} */ (err).message}` };
  }
  /** @type {Awaited<ReturnType<typeof corpusCheck>>} */
  let r;
  try { r = await check(); } catch (err) { return { ok: false, message: /** @type {Error} */ (err).message }; }
  if (!r.ok) return { ok: false, message: `${r.release} (data/corpus.json current): ${r.problems.join('; ')}` };
  return { ok: true, message: `${r.release}: data version ${r.dataVersion.committed} and catalogueKey ${r.catalogueKey.file} follow it; the 3B files are fresh` };
}

const USAGE = 'usage: npm run corpus -- fetch [<year>] | publish [--file <path>] [--fetched-at <iso>] [--new-data-version] | restore | check';

/**
 * @param {string[]} argv
 * @param {{ log?: (line: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function main(argv, { log = console.log } = {}) {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest, allowPositionals: true, strict: true,
    options: { file: { type: 'string' }, 'fetched-at': { type: 'string' }, 'new-data-version': { type: 'boolean' } },
  });
  try {
    if (command === 'fetch') {
      await fetchStaging(positionals[0] ?? DEFAULT_ACAD_YEAR, { log });
      log('next: npm run corpus -- publish');
      return 0;
    }
    if (command === 'publish') {
      await publishCorpus({
        ...(values.file ? { file: values.file } : {}), ...(values['fetched-at'] ? { fetchedAt: values['fetched-at'] } : {}),
        newDataVersion: values['new-data-version'] ?? false, log, args: argv,
      });
      return 0;
    }
    if (command === 'restore') {
      await restoreCurrent({ log });
      return 0;
    }
    if (command === 'check') {
      const r = await corpusCheck();
      log(`corpus check: ${r.release}`);
      log(`  data version  asset with HEAD's NG files ${r.dataVersion.asset}, src/data-version.json ${r.dataVersion.committed}`);
      log(`  catalogueKey  asset ${r.catalogueKey.asset}, bundled file ${r.catalogueKey.file}`);
      for (const p of r.problems) log(`  FAIL ${p}`);
      if (!r.ok) return 1;
      log('  OK: src/data-version.json and the per-corpus files follow current');
      return 0;
    }
    log(USAGE);
    return 2;
  } catch (err) {
    log(`corpus ${command}: ${/** @type {Error} */ (err).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
