// @ts-check

export const GROUPS_VERSION = 'groups-v1';
export const GROUPS_FILE_SCHEMA = 'vnm-groups/1';

const PLACEHOLDER_DESCRIPTIONS = new Set(['', 'not available']);

/** @param {unknown} s */
export const normaliseText = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** @param {string} code */
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
 * @typedef {'production' | 'pinned' | 'fixture' | 'eval'} GroupsCorpus
 * @typedef {{ schema: string, version: string, corpus: GroupsCorpus, dataVersion: string, counts: GroupCounts, groups: string[][] }} GroupsModuleFile
 */

/**
 * @param {GroupInput[]} modules
 * @param {{ corpus: GroupsCorpus, dataVersion: string }} o
 * @returns {GroupsModuleFile}
 */
export function buildGroupsFile(modules, { corpus, dataVersion }) {
  const { groups, counts } = buildGroups(modules);
  return { schema: GROUPS_FILE_SCHEMA, version: GROUPS_VERSION, corpus, dataVersion, counts, groups };
}

/** @param {GroupsModuleFile} f */
export function serializeGroupsFile(f) {
  const { groups, ...head } = f;
  const body = groups.map((g) => `  ${JSON.stringify(g)}`).join(',\n');
  return `${JSON.stringify(head, null, 1).replace(/\n}$/, '')},\n "groups": [${groups.length ? `\n${body}\n ` : ''}]\n}\n`;
}

/**
 * @param {GroupsModuleFile} f
 * @returns {Map<string, string>}
 */
export function parseGroupsFile(f) {
  if (f?.schema !== GROUPS_FILE_SCHEMA) throw new Error(`groups file: schema ${f?.schema}, expected ${GROUPS_FILE_SCHEMA}`);
  if (f.version !== GROUPS_VERSION) throw new Error(`groups file: rule ${f.version}, this Worker applies ${GROUPS_VERSION}`);
  /** @type {Map<string, string>} */
  const groupOf = new Map();
  for (const g of f.groups) for (const code of g) groupOf.set(code, g[0]);
  return groupOf;
}

/** @param {Map<string, string>} groupOf @param {string} code */
export const groupKeyOf = (groupOf, code) => groupOf.get(code) ?? code;

/**
 * @param {string} kept
 * @param {string[]} others
 * @param {Map<string, number>} rank
 * @param {(code: string) => boolean} offered
 * @returns {string}
 */
export function semesterRepresentative(kept, others, rank, offered) {
  if (offered(kept)) return kept;
  const pos = (/** @type {string} */ c) => rank.get(c) ?? Infinity;
  let best = null;
  for (const c of others) {
    if (!offered(c)) continue;
    if (best === null || pos(c) < pos(best) || (pos(c) === pos(best) && c < best)) best = c;
  }
  return best ?? kept;
}

/**
 * @param {string[]} codes
 * @param {Map<string, string>} groupOf
 * @param {string[]} [already]
 * @returns {{ kept: string[], hidden: Map<string, string[]> }}
 */
export function collapse(codes, groupOf, already = []) {
  /** @type {Map<string, string>} */
  const keptFor = new Map(already.map((c) => [groupKeyOf(groupOf, c), c]));
  /** @type {string[]} */
  const kept = [];
  /** @type {Map<string, string[]>} */
  const hidden = new Map();
  for (const code of codes) {
    const k = groupKeyOf(groupOf, code);
    const first = keptFor.get(k);
    if (first === undefined) { keptFor.set(k, code); kept.push(code); continue; }
    if (first === code) continue;
    const h = hidden.get(first);
    if (h) h.push(code); else hidden.set(first, [code]);
  }
  return { kept, hidden };
}
