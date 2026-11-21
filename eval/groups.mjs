#!/usr/bin/env node
// @ts-check
import { readFile, writeFile } from 'node:fs/promises';
import { loadPinnedCorpus, PINNED_RELEASE } from '../scripts/pinned-corpus.mjs';
import { GROUPS_PATH, groupsFile, serialiseGroups } from './lib/groups.mjs';

export async function buildPinnedGroups() {
  const c = await loadPinnedCorpus();
  const f = groupsFile(c.modules, { release: PINNED_RELEASE, moduleInfoSha256: c.moduleInfoSha256 });
  return { file: f, text: serialiseGroups(f) };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const { file, text } = await buildPinnedGroups();
  const { groups, members, largest } = file.counts;
  console.log(`${groups} groups, ${members} members, largest ${largest} (${file.corpus.modules} offered modules, ${file.version})`);
  if (process.argv.includes('--check')) {
    const committed = await readFile(GROUPS_PATH, 'utf8').catch(() => '');
    if (committed !== text) {
      console.error(`${GROUPS_PATH} is stale: run npm run eval:groups and commit it`);
      process.exit(1);
    }
    console.log('eval/groups.json is up to date');
  } else {
    await writeFile(GROUPS_PATH, text);
    console.log(`wrote ${GROUPS_PATH}`);
  }
}
