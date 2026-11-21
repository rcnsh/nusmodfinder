#!/usr/bin/env node
// @ts-check
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { buildGroupsFile, serializeGroupsFile } from '../src/groups.js';
import { assertProductionCorpus, corpusDataVersion, productionModules } from './build-vocabulary.mjs';
import { loadPinnedCorpus } from './pinned-corpus.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const OUTPUTS = Object.freeze({
  production: 'data/groups.json',
  fixture: 'test/fixtures/groups.json',
});

/**
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

/** @param {NormalisedModule[]} modules */
export async function writeProductionGroups(modules) {
  await writeFile(join(ROOT, OUTPUTS.production), await groupsBytes(modules, 'production'));
  return OUTPUTS.production;
}

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
