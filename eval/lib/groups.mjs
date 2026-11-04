// @ts-check
// Duplicate groups for scoring (docs/plans/phase2.md, "Metrics (changes)"):
// only the first member of a group to appear earns gain (metrics.mjs). The
// groups are built from public corpus fields only, never from qrels or judge
// grades, so they apply equally to every set (dev, holdout, test).
//
// Rule, over the offered modules of the pinned corpus (code, title,
// description as scripts/lib.mjs `normalise()` returns them). "Normalised"
// means lower-cased, whitespace runs collapsed to one space, trimmed.
// - Variant family: codes with the same prefix letters and four digits that
//   differ only in the suffix letters (TR3202I/S/T, ACC1701X/XA, CS1010/CS1010S),
//   and the same normalised title. MA2101 "Linear Algebra II" and MA2101S
//   "Linear Algebra II (S)" stay apart: the (S) course is a different,
//   Special Programme course with its own description.
// - Cross-listing: different codes whose normalised title and normalised
//   description are both identical, when the description is a real one. The
//   placeholder "Not Available" (226 offered modules) says nothing about the
//   content, so it never makes two codes cross-listed (otherwise BN5999 ...
//   MT5999 "Graduate Seminars" of nine departments would be one group).
// - Groups are transitive (union-find over both relations); singletons are
//   dropped. Members are sorted, groups sorted by first member.
//
// eval/groups.json is the committed output (`npm run eval:groups`, checked by
// `npm run eval:groups -- --check` and test/full/groups.node.test.js). The
// harness merges it into the qrels at scoring time (`withCorpusGroups`) and
// refuses it when it was built from another corpus.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CorpusMismatchError } from './errors.mjs';
import { REPO } from './sets.mjs';

export const GROUPS_PATH = join(REPO, 'eval/groups.json');
export const GROUPS_SCHEMA = 'vnm-eval-groups/1';
/** Bump when the rule changes. */
export const GROUPS_VERSION = 'groups-v1';

/** Descriptions that carry no content (normalised). */
const PLACEHOLDER_DESCRIPTIONS = new Set(['', 'not available']);

/** @param {unknown} s */
export const normaliseText = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * The variant-family key of a code: prefix letters + four digits, when the
 * rest is only suffix letters (CS1010S -> CS1010); null otherwise (DMA1401L01).
 * @param {string} code
 */
export function familyOf(code) {
  return /^([A-Z]+\d{4})[A-Z]*$/.exec(code)?.[1] ?? null;
}

/**
 * @typedef {{ code: string, title: string, description: string }} GroupInput
 * @typedef {{ groups: number, members: number, largest: number }} GroupCounts
 */

/**
 * @param {GroupInput[]} modules
 * @returns {{ groups: string[][], counts: GroupCounts }}
 */
export function buildGroups(modules) {
  /** @type {Map<string, string>} */
  const parent = new Map(modules.map((m) => [m.code, m.code]));
  /** @param {string} x @returns {string} */
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = /** @type {string} */ (parent.get(root));
    while (parent.get(x) !== root) { const next = /** @type {string} */ (parent.get(x)); parent.set(x, root); x = next; }
    return root;
  };
  /** @param {string} a @param {string} b */
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  /** @param {(m: GroupInput) => string | null} key */
  const joinBy = (key) => {
    /** @type {Map<string, string>} */
    const first = new Map();
    for (const m of modules) {
      const k = key(m);
      if (k === null) continue;
      const f = first.get(k);
      if (f === undefined) first.set(k, m.code);
      else union(f, m.code);
    }
  };
  joinBy((m) => { const f = familyOf(m.code); return f === null ? null : `${f}\t${normaliseText(m.title)}`; });
  joinBy((m) => {
    const d = normaliseText(m.description);
    return PLACEHOLDER_DESCRIPTIONS.has(d) ? null : `${normaliseText(m.title)}\t${d}`;
  });

  /** @type {Map<string, string[]>} */
  const byRoot = new Map();
  for (const m of modules) {
    const r = find(m.code);
    const g = byRoot.get(r);
    if (g) g.push(m.code); else byRoot.set(r, [m.code]);
  }
  const cmp = (/** @type {string} */ a, /** @type {string} */ b) => (a < b ? -1 : a > b ? 1 : 0);
  const groups = [...byRoot.values()].filter((g) => g.length > 1).map((g) => [...new Set(g)].sort(cmp)).sort((a, b) => cmp(a[0], b[0]));
  return {
    groups,
    counts: {
      groups: groups.length,
      members: groups.reduce((n, g) => n + g.length, 0),
      largest: groups.reduce((n, g) => Math.max(n, g.length), 0),
    },
  };
}

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
