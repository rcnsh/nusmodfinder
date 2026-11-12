#!/usr/bin/env node
// @ts-check
// The module groups: groups-v1 (src/groups.js) over the corpus each Worker
// searches, versioned with that corpus's bundle the way the vocabulary is
// (scripts/build-vocabulary.mjs):
//
//   node scripts/build-groups.mjs --corpus production
//       data/groups.json, the Worker's (src/group-data.js): the corpus
//       `npm run ingest` writes, `current` in data/corpus.json. Refused unless its row count and data version
//       are the production bundle's in data/vectors.json. `vectors.mjs build
//       --corpus production` rewrites it with the bundle.
//   node scripts/build-groups.mjs --corpus fixture
//       test/fixtures/groups.json, from the fixture corpus (vitest.config.mjs
//       aliases it for the Worker tests).
//   add --check to rebuild in memory and exit 1 if the committed file differs.
//
// The pinned groups are never committed here: vitest.config.mjs builds them for
// test/full and the query suite (pinnedGroupsPath), and every eval run writes its
// own from the run corpus (eval/runner/run.mjs). They equal eval/groups.json's.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildGroupsFile, serializeGroupsFile } from '../src/groups.js';
import { assertProductionCorpus, corpusDataVersion, productionModules } from './build-vocabulary.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The committed groups modules, repo-relative. */
export const OUTPUTS = Object.freeze({
  production: 'data/groups.json',
  fixture: 'test/fixtures/groups.json',
});

/**
 * The groups file's bytes for the modules of a corpus.
 * @param {import('../src/groups.js').GroupInput[] & NormalisedModule[]} modules
 * @param {import('../src/groups.js').GroupsCorpus} corpus
 */
export async function groupsBytes(modules, corpus) {
  return serializeGroupsFile(buildGroupsFile(modules, { corpus, dataVersion: await corpusDataVersion(modules) }));
}

/**
 * @param {'production' | 'pinned' | 'fixture'} corpus
 */
export async function build(corpus) {
  if (corpus === 'fixture') {
    const { modules } = JSON.parse(await readFile(join(ROOT, 'test/fixtures/corpus.json'), 'utf8'));
    return groupsBytes(modules, 'fixture');
  }
  if (corpus === 'pinned') return groupsBytes((await loadPinnedCorpus()).modules, 'pinned');
  const modules = await productionModules();
  await assertProductionCorpus(modules);
  return groupsBytes(modules, 'production');
}

/**
 * Writes the production groups for the modules the production bundle was just
 * built from (scripts/vectors.mjs build --corpus production).
 * @param {NormalisedModule[]} modules
 */
export async function writeProductionGroups(modules) {
  await writeFile(join(ROOT, OUTPUTS.production), await groupsBytes(modules, 'production'));
  return OUTPUTS.production;
}

/** The pinned groups as a file (.data/groups/, git-ignored), rebuilt if absent or stale. */
export async function pinnedGroupsPath() {
  const bytes = await build('pinned');
  const path = join(ROOT, '.data/groups/groups-pinned.json');
  if (!existsSync(path) || (await readFile(path, 'utf8')) !== bytes) {
    await mkdir(join(ROOT, '.data/groups'), { recursive: true });
    await writeFile(path, bytes);
  }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({ options: { corpus: { type: 'string' }, check: { type: 'boolean' } } });
  const corpus = values.corpus;
  if (corpus !== 'production' && corpus !== 'fixture') {
    console.error('usage: node scripts/build-groups.mjs --corpus production|fixture [--check]');
    process.exit(1);
  }
  try {
    const bytes = await build(corpus);
    const path = join(ROOT, OUTPUTS[corpus]);
    if (values.check) {
      const have = existsSync(path) ? await readFile(path, 'utf8') : null;
      if (have !== bytes) { console.error(`${OUTPUTS[corpus]} is out of date (node scripts/build-groups.mjs --corpus ${corpus})`); process.exitCode = 1; }
      else console.log(`${OUTPUTS[corpus]} is up to date`);
    } else {
      await writeFile(path, bytes);
      const g = JSON.parse(bytes);
      console.log(`wrote ${OUTPUTS[corpus]}: ${g.counts.groups} groups, ${g.counts.members} members, data version ${g.dataVersion}`);
    }
  } catch (err) {
    console.error(`build-groups: ${/** @type {Error} */ (err).message}`);
    process.exitCode = 1;
  }
}
