// @ts-check
// Duplicate groups for scoring:
// only the first member of a group to appear earns gain (metrics.mjs). The
// groups are built from public corpus fields only, never from qrels or judge
// grades, so they apply equally to every set (dev, holdout, test).
//
// The rule is groups-v1 in src/groups.js, one rule for eval and product,
// over the offered modules of the pinned corpus (code, title, description as
// scripts/lib.mjs `normalise()` returns them).
//
// eval/groups.json is the committed output (`npm run eval:groups`, checked by
// `npm run eval:groups -- --check` and test/full/groups.node.test.js). The
// harness merges it into the qrels at scoring time (`withCorpusGroups`) and
// refuses it when it was built from another corpus.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CorpusMismatchError } from './errors.mjs';
import { REPO } from './sets.mjs';
import { GROUPS_VERSION, buildGroups, familyOf, normaliseText } from '../../src/groups.js';

export { GROUPS_VERSION, buildGroups, familyOf, normaliseText };

/**
 * @typedef {import('../../src/groups.js').GroupInput} GroupInput
 * @typedef {import('../../src/groups.js').GroupCounts} GroupCounts
 */

export const GROUPS_PATH = join(REPO, 'eval/groups.json');
export const GROUPS_SCHEMA = 'vnm-eval-groups/1';

/**
 * @typedef {{
 *   schema: string, version: string,
 *   corpus: { release: string | null, moduleInfoSha256: string, modules: number },
 *   counts: GroupCounts, groups: string[][],
 * }} GroupsFile
 */

/**
 * @param {GroupInput[]} modules
 * @param {{ release: string | null, moduleInfoSha256: string }} corpus
 * @returns {GroupsFile}
 */
export function groupsFile(modules, corpus) {
  const { groups, counts } = buildGroups(modules);
  return {
    schema: GROUPS_SCHEMA,
    version: GROUPS_VERSION,
    corpus: { release: corpus.release, moduleInfoSha256: corpus.moduleInfoSha256, modules: modules.length },
    counts,
    groups,
  };
}

/** The file's bytes: one group per line, so diffs stay readable. @param {GroupsFile} f */
export function serialiseGroups(f) {
  const { groups, ...head } = f;
  const body = groups.map((g) => `  ${JSON.stringify(g)}`).join(',\n');
  return `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "groups": [\n${body}\n ]\n}\n`;
}

/**
 * Reads and validates a groups file.
 * @param {string} [path]
 * @returns {Promise<GroupsFile>}
 */
export async function loadGroups(path = GROUPS_PATH) {
  const f = JSON.parse(await readFile(path, 'utf8'));
  const ok = f?.schema === GROUPS_SCHEMA && typeof f.corpus?.moduleInfoSha256 === 'string' && Array.isArray(f.groups)
    && f.groups.every((/** @type {unknown} */ g) => Array.isArray(g) && g.length > 1 && g.every((c) => typeof c === 'string'));
  if (!ok) throw new Error(`${path}: expected a ${GROUPS_SCHEMA} file with corpus.moduleInfoSha256 and groups of two or more codes`);
  return f;
}

/**
 * The qrels to score with: the committed corpus groups added to whatever
 * groups the qrels carry (metrics.mjs `qrelsFor` joins overlapping groups).
 * Throws CorpusMismatchError when the groups were built from another corpus
 * than the qrels were judged on (the runs are checked against the qrels by
 * `assertSameCorpus`). The error names hashes only, never qrels content.
 * @param {import('./metrics.mjs').Qrels} qrels
 * @param {GroupsFile} groups
 * @returns {import('./metrics.mjs').Qrels}
 */
export function withCorpusGroups(qrels, groups) {
  const want = qrels.corpus?.moduleInfoSha256;
  const got = groups.corpus.moduleInfoSha256;
  if (want !== got) {
    const short = (/** @type {unknown} */ v) => (typeof v === 'string' ? `${v.slice(0, 12)}…` : String(v));
    throw new CorpusMismatchError(`duplicate groups ${groups.version} were built from a corpus with moduleInfoSha256 ${short(got)}, but qrels ${qrels.version} were judged on ${short(want)}; rebuild them with npm run eval:groups`);
  }
  return { ...qrels, groups: [...(qrels.groups ?? []), ...groups.groups] };
}

/**
 * Code -> group key (the group's first member) for a groups file's groups. A
 * code in no group has no entry: it is its own group.
 * @param {string[][]} groups
 * @returns {Map<string, string>}
 */
export function groupIndex(groups) {
  /** @type {Map<string, string>} */
  const index = new Map();
  for (const g of groups) for (const c of g) index.set(c, g[0]);
  return index;
}

/**
 * A ranked list as its sequence of group keys: two lists with the same
 * sequence differ at most in which member stands for each group.
 * @param {string[]} codes @param {Map<string, string>} index
 */
export const groupKeys = (codes, index) => codes.map((c) => index.get(c) ?? c);
