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
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { build as build3b, staleFiles } from './build-3b-data.mjs';
import { checkCurrent, fetchStaging, publishCorpus, restoreCurrent } from './corpus-manifest.mjs';
import { DEFAULT_ACAD_YEAR } from './lib.mjs';

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
      const r = await checkCurrent();
      log(`corpus check: ${r.release}`);
      log(`  data version  asset with HEAD's NG files ${r.dataVersion.asset}, src/data-version.json ${r.dataVersion.committed}`);
      log(`  catalogueKey  asset ${r.catalogueKey.asset}, bundled file ${r.catalogueKey.file}`);
      const stale = await staleFiles(await build3b('production'));
      for (const rel of stale) r.problems.push(`${rel} is not what node scripts/build-3b-data.mjs --corpus production writes from current`);
      for (const p of r.problems) log(`  FAIL ${p}`);
      if (r.problems.length) return 1;
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
