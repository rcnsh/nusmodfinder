// @ts-check
import { buildGroups, familyOf } from './groups.mjs';
import { pairKey, splitKey, nextVersion, RULE } from './judging.mjs';
import { gradeOf, violationReason } from './metrics.mjs';

export const CODE_RULE = 'code-rule-v1';
const RULE_TEXT = 'JUDGING.md rule 4 (code target), applied mechanically from public corpus fields';
const FORMS = ['exact', 'space', 'partial'];

/**
 * @typedef {{
 *   code: string, title?: string, description?: string | null, level?: number | null, credits?: number | null,
 *   semesters?: number[], ng?: boolean, ngSemesters?: number[], faculty?: string | null,
 * }} RuleModule
 * @typedef {{ grade: number, rationale: string }} RuleGrade
 * @typedef {{ 0: number, 1: number, 2: number }} ByGrade
 * @typedef {{ total: number, up: number, down: number, same: number }} Overrides
 * @typedef {{ queries: number, added: ByGrade, changed: Record<string, number>, overrides: Overrides }} RuleStats
 * @typedef {{ queryId: string, code: string, from: number | null, fromSource: string | null, to: number }} RuleChange
 * @typedef {import('./metrics.mjs').EvalQuery & { origin?: string, codeForm?: string, target?: string }} CodeQuery
 */

/**
 * @param {CodeQuery[]} queries
 * @param {RuleModule[]} modules
 * @param {{ groups?: string[][] }} [o]
 * @returns {Map<string, RuleGrade>}
 */
export function codeRuleGrades(queries, modules, o = {}) {
  const groups = o.groups ?? buildGroups(modules.map((m) => ({ code: m.code, title: m.title ?? '', description: m.description ?? '' }))).groups;
  /** @type {Map<string, string[]>} */
  const groupOf = new Map();
  for (const g of groups) for (const c of g) groupOf.set(c, g);
  const byCode = new Map(modules.map((m) => [m.code, m]));
  /** @type {Map<string, RuleGrade>} */
  const out = new Map();
  for (const q of queries) {
    if (q.origin !== 'code' || q.noAnswerByRule) continue;
    if (!q.codeForm || !FORMS.includes(q.codeForm)) throw new Error(`a code query has code form ${JSON.stringify(q.codeForm)}; expected ${FORMS.join(', ')}`);
    if (typeof q.target !== 'string' || !q.target) throw new Error('a code query has no target');
    const target = q.target.toUpperCase();
    const constraints = /** @type {import('./metrics.mjs').Constraints} */ (q.constraints ?? q.filters ?? {});
    /** @type {[string, number, string][]} */
    const named = [];
    if (q.codeForm === 'partial') {
      for (const m of modules) if (m.code.startsWith(target)) named.push([m.code, 2, `code starts with ${target}`]);
    } else {
      const stem = familyOf(target);
      if (byCode.has(target)) named.push([target, 2, 'the exact code']);
      if (stem) for (const m of modules) if (m.code !== target && familyOf(m.code) === stem) named.push([m.code, 1, `a variant of ${target}`]);
      for (const c of groupOf.get(target) ?? []) if (c !== target && familyOf(c) !== stem) named.push([c, 1, `cross-listed with ${target}`]);
    }
    for (const [code, grade, why] of named) {
      const m = /** @type {RuleModule} */ (byCode.get(code));
      const reason = violationReason({
        level: m.level ?? null, semesters: m.semesters ?? [], ng: m.ng === true || (m.ngSemesters ?? []).length > 0,
        ngSemesters: m.ngSemesters ?? [], credits: m.credits ?? null, faculty: m.faculty ?? null,
      }, constraints);
      out.set(pairKey(q.id, code), reason ? { grade: 0, rationale: `hard constraint: ${reason}` } : { grade, rationale: `code rule: ${why}` });
    }
  }
  return out;
}

/**
 * @param {{ queries: Record<string, import('./metrics.mjs').QueryQrels> }} qrels
 * @param {Map<string, RuleGrade>} grades
 * @returns {{ queries: Record<string, import('./metrics.mjs').QueryQrels>, stats: RuleStats, changes: RuleChange[] }}
 */
export function applyCodeRule(qrels, grades) {
  /** @type {Record<string, import('./metrics.mjs').QueryQrels>} */
  const queries = JSON.parse(JSON.stringify(qrels.queries ?? {}));
  /** @type {RuleStats} */
  const stats = { queries: 0, added: { 0: 0, 1: 0, 2: 0 }, changed: {}, overrides: { total: 0, up: 0, down: 0, same: 0 } };
  /** @type {RuleChange[]} */
  const changes = [];
  /** @type {Set<string>} */
  const affected = new Set();
  for (const [key, g] of [...grades].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const [qid, code] = splitKey(key);
    queries[qid] ??= { judgments: {} };
    const old = queries[qid].judgments[code];
    const oldObj = old !== undefined && typeof old === 'object' ? /** @type {any} */ (old) : null;
    if (oldObj?.round === CODE_RULE && oldObj.grade === g.grade) continue;
    const from = old === undefined ? null : gradeOf(old);
    const fromSource = old === undefined ? null : oldObj?.source ?? 'grade';
    /** @type {Record<string, unknown>} */
    const judges = { ...(oldObj?.judges ?? {}) };
    judges[RULE] = { slot: RULE, grade: g.grade, rationale: g.rationale };
    queries[qid].judgments[code] = /** @type {any} */ ({ grade: g.grade, source: RULE, round: CODE_RULE, judges });
    affected.add(qid);
    changes.push({ queryId: qid, code, from, fromSource, to: g.grade });
    if (from === null) stats.added[/** @type {0 | 1 | 2} */ (g.grade)]++;
    else if (from !== g.grade) stats.changed[`${from}->${g.grade}`] = (stats.changed[`${from}->${g.grade}`] ?? 0) + 1;
    if (from !== null && fromSource !== RULE) {
      stats.overrides.total++;
      stats.overrides[g.grade > from ? 'up' : g.grade < from ? 'down' : 'same']++;
    }
  }
  stats.queries = affected.size;
  return { queries, stats, changes };
}

/**
 * @template {import('./metrics.mjs').Qrels & { judging?: unknown[] }} Q
 * @param {Q} qrels
 * @param {Map<string, RuleGrade>} grades
 * @param {{ version?: string, createdAt?: string, groupsVersion: string, corpusSha256: string }} o
 */
export function withCodeRule(qrels, grades, o) {
  const { queries, stats, changes } = applyCodeRule(qrels, grades);
  const version = o.version ?? nextVersion(qrels.version, /** @type {any} */ (qrels).set);
  if (version === qrels.version) throw new Error('the rule-graded qrels need a new version string');
  return {
    qrels: {
      ...qrels,
      version,
      judging: [...(qrels.judging ?? []), {
        round: CODE_RULE, mode: 'rule', rule: RULE_TEXT, corpus: { moduleInfoSha256: o.corpusSha256 }, groups: o.groupsVersion,
        pairs: grades.size, added: stats.added, changed: stats.changed, overrides: stats.overrides, createdAt: o.createdAt ?? new Date().toISOString(),
      }],
      queries,
    },
    stats,
    changes,
  };
}

/**
 * @param {RuleStats} s
 * @param {number} pairs
 */
export function countLines(s, pairs) {
  const changed = Object.entries(s.changed).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k.replace('->', ' -> ')}: ${n}`).join(', ') || 'none';
  return [
    `rule pairs: ${pairs}`,
    `queries affected: ${s.queries}`,
    `pairs added by grade: 2: ${s.added[2]}, 1: ${s.added[1]}, 0: ${s.added[0]}`,
    `pairs changed by grade: ${changed}`,
    `A grades overridden: ${s.overrides.total} (${s.overrides.up} up, ${s.overrides.down} down, ${s.overrides.same} unchanged)`,
  ];
}
