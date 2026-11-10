// @ts-check
// A synthetic set for the 5F compliance rule's tests: its own corpus.json
// (every constraint field, so the rule needs no pinned snapshot), queries
// whose 3H phrases the frozen reference parse (tag 3h) reads over that
// corpus's vocabulary, qrels, and a baseline and candidate run. The candidate
// applies each parsed constraint (a compliant list) and records the parse it
// "answered" in `intents`; unparsed queries keep the baseline's list. No
// workerd, no Cloudflare, no real holdout file.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, studyMapSha256 } from '../../eval/lib/sets.mjs';

export const CSCU = 'Completed Satisfactory/Unsatisfactory';
/** Every allow-mask bit (5 study levels × sem 1, 2, either). */
const ALL = (1 << 15) - 1;
/** The pinned corpus the qrels and groups record. */
export const CORPUS_SHA = JSON.parse(readFileSync(join(REPO, 'eval', 'groups.json'), 'utf8')).corpus.moduleInfoSha256;

/**
 * One corpus module. Its text carries the phrase words, so the reference's
 * 3C correction leaves them alone on this corpus's vocabulary.
 * @param {string} code @param {Record<string, unknown>} [f]
 */
export function mod(code, f = {}) {
  const description = 'An intro course with no final exam, no prerequisites, a light workload under ten hours, s/u grading and a project.';
  return {
    code, title: `Course ${code.toLowerCase()}`, description, credits: 4, department: 'Synthetic', faculty: 'Synthetic', level: 1000,
    semesters: [1, 2], workload: null, prerequisite: null, preclusion: null, acadYear: '2026-2027', text: `${code} ${description}`, textHash: code,
    ng: true, ngSemesters: [1, 2],
    examSemesters: [], su: false, gradingBasis: null, workloadHours: 8, prereqNone: true, prereqCohortOnly: false, ngAllow: ALL,
    ...f,
  };
}

/**
 * The parsed queries: id, text, filters, shapes, the parse the reference
 * gives, and per document [grade, constraint fields].
 * @type {{ id: string, text: string, filters?: Record<string, unknown>, shapes: string[], parse: Record<string, unknown>, docs: [number, Record<string, unknown>][] }[]}
 */
export const PARSED = [
  {
    id: 'syn-p1', text: 'intro programming no prerequisites', shapes: ['topical'], parse: { prereq: { value: 'none', semantics: 'ii' } },
    docs: [[2, { prereqNone: false }], [2, {}], [1, { prereqNone: false, prereqCohortOnly: true }], [1, { prereqNone: false }], [0, {}], [0, {}]],
  },
  {
    id: 'syn-p2', text: 'project course with no final exam', filters: { ng: true, sem: 1 }, shapes: ['topical'], parse: { exam: 0 },
    docs: [[2, { examSemesters: [1] }], [2, { examSemesters: [2] }], [1, { ngAllow: 0 }], [1, {}], [0, {}], [0, {}]],
  },
  {
    id: 'syn-p3', text: 'elective with a light workload', shapes: ['topical'], parse: { hoursBelow: 10 },
    docs: [[2, { workloadHours: 12 }], [2, { workloadHours: 6 }], [1, { workloadHours: null }], [1, { workloadHours: 9.5 }], [0, {}], [0, {}]],
  },
  {
    id: 'syn-p4', text: 's/u elective for exchange', shapes: ['constraint'], parse: { su: { value: 1, basis: ['CS/CU', 'su'] } },
    docs: [[2, {}], [2, { su: true }], [1, { gradingBasis: CSCU }], [0, { su: true }], [0, { su: true }]],
  },
];

/** Unparsed queries: identical lists in both runs. */
export const UNPARSED = Array.from({ length: 12 }, (_, i) => ({ id: `syn-u${String(i + 1).padStart(2, '0')}`, text: `synthetic topical query number ${i + 1} about ${['robots', 'markets', 'poetry', 'cells'][i % 4]}` }));
const UNPARSED_GRADES = [2, 1, 1, 0, 0];

/** @param {string} id @param {number} r */
export const codeOf = (id, r) => `ZZ${id.replace(/\D/g, '').padStart(2, '0')}${id.includes('-p') ? 'P' : 'U'}${r}`;

/** @param {Record<string, unknown>} m @param {Record<string, unknown>} parse @param {Record<string, unknown>} [filters] */
const compliant = (m, parse, filters = {}) => {
  const f = /** @type {any} */ (m);
  if (parse.exam === 0 && (filters.sem !== undefined ? f.examSemesters.includes(filters.sem) : f.examSemesters.length > 0)) return false;
  if (parse.su && !(f.su || f.gradingBasis === CSCU)) return false;
  if (typeof parse.hoursBelow === 'number' && !(f.workloadHours !== null && f.workloadHours < parse.hoursBelow)) return false;
  if (parse.prereq && !(f.prereqNone || f.prereqCohortOnly)) return false;
  return !(filters.ng && f.ngAllow === 0);
};

/**
 * The whole set; `tweak` edits it before the runs are derived.
 * @param {string} set the set name the runs record
 * @param {{ ranker: { base: any, cand: any } }} o
 */
export function syntheticSet(set, o) {
  const all = [...PARSED.map((p) => ({ id: p.id, text: p.text, filters: p.filters, shapes: p.shapes, persona: 'p-cs' })), ...UNPARSED.map((u) => ({ id: u.id, text: u.text, shapes: ['topical'], persona: 'p-cs' }))];
  const queries = all.map((q) => (/** @type {any} */ (q).filters ? q : { id: q.id, text: q.text, shapes: q.shapes, persona: q.persona }));
  /** @type {any[]} */
  const modules = [];
  /** @type {Record<string, { judgments: Record<string, number> }>} */
  const judged = {};
  /** @type {Record<string, string[]>} */
  const base = {};
  /** @type {Record<string, string[]>} */
  const cand = {};
  /** @type {Record<string, Record<string, unknown> | null>} */
  const intents = {};
  for (const p of PARSED) {
    const codes = p.docs.map((_, r) => codeOf(p.id, r));
    p.docs.forEach(([, f], r) => modules.push(mod(codes[r], f)));
    judged[p.id] = { judgments: Object.fromEntries(p.docs.map(([g], r) => [codes[r], g])) };
    base[p.id] = codes;
    cand[p.id] = codes.filter((c, r) => compliant(mod(c, p.docs[r][1]), p.parse, p.filters));
    intents[p.id] = { exam: null, su: null, hoursBelow: null, prereq: null, ...p.parse };
  }
  for (const u of UNPARSED) {
    const codes = UNPARSED_GRADES.map((_, r) => codeOf(u.id, r));
    codes.forEach((c) => modules.push(mod(c)));
    judged[u.id] = { judgments: Object.fromEntries(codes.map((c, r) => [c, UNPARSED_GRADES[r]])) };
    base[u.id] = codes;
    cand[u.id] = [...codes];
    intents[u.id] = { exam: null, su: null, hoursBelow: null, prereq: null };
  }
  const querySet = { schema: 'vnm-eval-queries/1', set, version: 'synthetic-5f-v1', queries };
  const qrels = { schema: 'vnm-eval-qrels/1', set, version: 'qrels-synthetic-5f-v1', corpus: { moduleInfoSha256: CORPUS_SHA }, groups: [], queries: judged };
  const corpus = { source: { generator: '5F compliance tests' }, count: modules.length, modules };
  /** @param {string} variant @param {any} ranker @param {Record<string, string[]>} lists @param {Record<string, unknown> | null} [ints] */
  const run = (variant, ranker, lists, ints = null) => ({
    schema: 'vnm-eval-run/1', variant, set, ranker,
    corpus: { moduleInfoSha256: CORPUS_SHA },
    queries: { version: querySet.version, sha256: createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex'), count: queries.length },
    config: { mode: 'hybrid', filters: true, studyMap: studyMapSha256() },
    results: Object.fromEntries(Object.entries(lists).map(([id, c]) => [id, { status: 200, codes: c }])),
    docs: {},
    ...(ints ? { intents: ints } : {}),
  });
  return {
    querySet, qrels, corpus,
    base: run('base', o.ranker.base, base),
    cand: run('cand', o.ranker.cand, cand, intents),
    /** Every query id, text and code, which no encrypted-set output may contain. */
    secrets: [...queries.flatMap((q) => [q.id, q.text]), ...modules.map((m) => m.code)],
  };
}
