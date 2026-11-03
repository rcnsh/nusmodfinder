// @ts-check
// Retrieval metrics over a run file and a qrels file. Pure functions; no I/O.
// Rules (docs/plans/phase2.md, r2/r3/Final):
// - nDCG@10, gain 2^g - 1, log2(rank + 1) discount. Duplicate-group aware:
//   only the first member of a group to appear in the ranking earns gain, and
//   the ideal ranking holds one document per group (its best grade).
// - P@5: group-first documents with grade >= 1 in the top 5, divided by 5.
// - MRR@10: 1 / rank of the first group-first document with grade >= 1.
// - Unjudged documents count as grade 0; judged@10 coverage is reported.
// - A query is answerable iff some judged document has grade >= 1, unless it
//   is marked `noAnswerByRule` (non-existent codes). Answerable queries tagged
//   with a feature-gap shape are scored in their own block, not the primary.
// - No-answer queries score correct-empty (the run returned nothing).
// - A non-200 response is an error, never a result: it is never correct-empty
//   and nothing in it is relevant (it scores as an empty ranking that also
//   fails correct-empty). Every gate fails a candidate with more errors than
//   its baseline (gate.mjs, "no new errors").
import { CorpusMismatchError, QrelsError, RunFileError } from './errors.mjs';
import { bcaInterval, clusteredInterval, mean, signFlipP } from './stats.mjs';

export const K = 10;
export const P_K = 5;
/** Shapes reported as a feature-gap block, outside the primary metric (r2). */
export const FEATURE_GAP_SHAPES = ['constraint'];
/** Shapes whose rank-1 hit must not regress (gate rule 3). */
export const EXACT_CODE_SHAPES = ['code-exact'];
/** The per-query metrics compared between runs. */
export const METRICS = /** @type {const} */ (['ndcg', 'p5', 'rr']);

/**
 * @typedef {{ sem?: number | string, ng?: boolean | number | string, level?: number | string | (number | string)[], credits?: number | string, faculty?: string }} Constraints
 * @typedef {{
 *   id: string, text: string, filters?: Constraints, constraints?: Constraints,
 *   shapes?: string[], persona?: string, narrative?: string, noAnswerByRule?: boolean, source?: string,
 * }} EvalQuery
 * @typedef {{ schema?: string, set?: string, version: string, queries: EvalQuery[] }} QuerySet
 * @typedef {number | { grade: number, [k: string]: unknown }} Judgment
 * @typedef {{ judgments: Record<string, Judgment>, groups?: string[][] }} QueryQrels
 * @typedef {{ moduleInfoSha256?: string, ngSha256?: string }} CorpusIds
 * @typedef {{ schema?: string, set?: string, version: string, corpus?: CorpusIds, groups?: string[][], queries: Record<string, QueryQrels> }} Qrels
 * @typedef {{ level: number | null, semesters: number[], ng: boolean, ngSemesters: number[], credits: number | null, faculty: string | null }} DocMeta
 * @typedef {{ status: number, codes: string[], error?: string }} QueryRun
 * @typedef {{
 *   schema: string, variant: string, set: string, createdAt?: string,
 *   ranker?: Record<string, unknown>, corpus?: Record<string, unknown>, embedding?: Record<string, unknown>,
 *   queries?: Record<string, unknown>, config?: Record<string, unknown>,
 *   results: Record<string, QueryRun>, docs: Record<string, DocMeta>,
 * }} RunFile
 */

/**
 * Errors name a bad grade by its value and position only: never the judgment
 * object (it may carry a judge's rationale), the query id or the code.
 * @param {Judgment | undefined} j
 * @param {string} [where] position, e.g. "query #3, judgment #2"
 */
export function gradeOf(j, where = 'a judgment') {
  if (j === undefined) return 0;
  const g = typeof j === 'number' ? j : j?.grade;
  if (!Number.isInteger(g) || g < 0 || g > 2) {
    const value = typeof g === 'number' ? String(g) : g === null ? 'null' : `a ${typeof g}`;
    throw new QrelsError(`qrels: ${where} has grade ${value}; grades must be 0, 1 or 2`);
  }
  return /** @type {number} */ (g);
}

/**
 * @param {Qrels} qrels
 * @param {string} id
 * @param {number} [position] zero-based index of the query in its set, for errors
 * @returns {{ grades: Map<string, number>, groupOf: Map<string, string> }}
 */
export function qrelsFor(qrels, id, position) {
  const q = qrels.queries[id];
  const at = position === undefined ? 'a query' : `query #${position + 1}`;
  /** @type {Map<string, number>} */
  const grades = new Map();
  Object.entries(q?.judgments ?? {}).forEach(([code, j], k) => grades.set(code, gradeOf(j, `${at}, judgment #${k + 1}`)));
  /** @type {Map<string, string>} */
  const groupOf = new Map();
  for (const group of [...(qrels.groups ?? []), ...(q?.groups ?? [])]) {
    const key = `group:${[...group].sort()[0]}`;
    for (const code of group) groupOf.set(code, key);
  }
  return { grades, groupOf };
}

/** @param {number} grade */
const gain = (grade) => 2 ** grade - 1;
/** @param {number} i zero-based rank */
const discount = (i) => Math.log2(i + 2);

/**
 * Scores one ranking. `codes` is the run's ranked list (any length; only the
 * top K count).
 * @param {string[]} codes
 * @param {Map<string, number>} grades judged grades; absent = unjudged = 0
 * @param {Map<string, string>} [groupOf] code -> duplicate-group key
 * @returns {{ ndcg: number, p5: number, rr: number, dcg: number, idcg: number }}
 */
export function scoreRanking(codes, grades, groupOf = new Map()) {
  const key = (/** @type {string} */ c) => groupOf.get(c) ?? c;
  /** @type {Set<string>} */
  const seen = new Set();
  let dcg = 0, hits5 = 0, rr = 0;
  codes.slice(0, K).forEach((code, i) => {
    const g = key(code);
    const first = !seen.has(g);
    seen.add(g);
    const grade = first ? grades.get(code) ?? 0 : 0;
    dcg += gain(grade) / discount(i);
    if (grade >= 1) {
      if (i < P_K) hits5++;
      if (rr === 0) rr = 1 / (i + 1);
    }
  });
  /** @type {Map<string, number>} best grade per group */
  const best = new Map();
  for (const [code, grade] of grades) best.set(key(code), Math.max(best.get(key(code)) ?? 0, grade));
  const ideal = [...best.values()].sort((a, b) => b - a).slice(0, K);
  const idcg = ideal.reduce((s, grade, i) => s + gain(grade) / discount(i), 0);
  return { ndcg: idcg === 0 ? 0 : dcg / idcg, p5: hits5 / P_K, rr, dcg, idcg };
}

/** @param {unknown} v */
const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/**
 * Does a returned document break the query's hard constraints? Semester means
 * offered that semester; NG + semester means NG in that semester (an exchange
 * student can take an NG module only in its NG semesters).
 * @param {DocMeta | undefined} doc
 * @param {Constraints} c
 */
export function violates(doc, c) {
  if (!doc) return false;
  const ng = truthy(c.ng);
  if (ng && !doc.ng) return true;
  if (c.sem !== undefined && c.sem !== '') {
    const sem = Number(c.sem);
    if (!doc.semesters.includes(sem)) return true;
    if (ng && !(doc.ngSemesters ?? []).includes(sem)) return true;
  }
  if (c.level !== undefined && c.level !== '') {
    const levels = (Array.isArray(c.level) ? c.level : [c.level]).map(Number);
    if (!levels.includes(/** @type {number} */ (doc.level))) return true;
  }
  if (c.credits !== undefined && c.credits !== '' && doc.credits !== Number(c.credits)) return true;
  if (c.faculty !== undefined && c.faculty !== '' && doc.faculty !== c.faculty) return true;
  return false;
}

/**
 * `empty` is a correct empty answer (status 200, no codes); `error` is any
 * non-200 response.
 * @typedef {{
 *   id: string, shapes: string[], persona: string, answerable: boolean, featureGap: boolean,
 *   ndcg: number, p5: number, rr: number, empty: boolean, error: boolean, status: number,
 *   violations: number, judged: number, top: number, top1: string | null, top1Grade: number,
 * }} QueryScore
 */

/**
 * Throws unless every run used the corpus the qrels were judged on: the
 * same moduleInfo sha256, and the same NG sha256 when the qrels record one.
 * @param {Qrels} qrels
 * @param {RunFile[]} runs
 */
export function assertSameCorpus(qrels, runs) {
  const want = qrels.corpus ?? {};
  if (!want.moduleInfoSha256) {
    throw new CorpusMismatchError(`qrels ${qrels.version} record no corpus.moduleInfoSha256, so there is no telling which corpus they were judged on`);
  }
  const keys = /** @type {(keyof CorpusIds)[]} */ (want.ngSha256 ? ['moduleInfoSha256', 'ngSha256'] : ['moduleInfoSha256']);
  const short = (/** @type {unknown} */ v) => (typeof v === 'string' ? v.slice(0, 12) : String(v));
  for (const run of runs) {
    const got = /** @type {CorpusIds} */ (run.corpus ?? {});
    for (const k of keys) {
      if (got[k] !== want[k]) {
        throw new CorpusMismatchError(`qrels ${qrels.version} were judged on a corpus with ${k} ${short(want[k])}…, but run ${run.variant} used ${short(got[k])}…; re-run on that corpus or re-judge`);
      }
    }
  }
}

/**
 * Scores every query of a run.
 * @param {RunFile} run
 * @param {EvalQuery[]} queries
 * @param {Qrels} qrels
 * @returns {QueryScore[]}
 */
export function scoreRun(run, queries, qrels) {
  return queries.map((q, i) => {
    const r = run.results[q.id];
    if (!r) throw new RunFileError(`run ${run.variant} has no result for query #${i + 1} of ${queries.length}`);
    const { grades, groupOf } = qrelsFor(qrels, q.id, i);
    const ok = r.status === 200;
    const codes = ok ? r.codes : [];
    const s = scoreRanking(codes, grades, groupOf);
    const top = codes.slice(0, K);
    const shapes = q.shapes ?? [];
    const constraints = q.constraints ?? q.filters ?? {};
    return {
      id: q.id,
      shapes,
      persona: q.persona ?? 'unknown',
      answerable: !q.noAnswerByRule && [...grades.values()].some((g) => g >= 1),
      featureGap: shapes.some((t) => FEATURE_GAP_SHAPES.includes(t)),
      ndcg: s.ndcg,
      p5: s.p5,
      rr: s.rr,
      empty: ok && codes.length === 0,
      error: !ok,
      status: r.status,
      violations: top.filter((c) => violates(run.docs[c], constraints)).length,
      judged: top.filter((c) => grades.has(c)).length,
      top: top.length,
      top1: codes[0] ?? null,
      top1Grade: codes[0] === undefined ? 0 : grades.get(codes[0]) ?? 0,
    };
  });
}

/**
 * @param {QueryScore[]} scores
 */
function block(scores) {
  return {
    n: scores.length,
    ndcg: mean(scores.map((s) => s.ndcg)),
    p5: mean(scores.map((s) => s.p5)),
    mrr: mean(scores.map((s) => s.rr)),
  };
}

/**
 * Aggregate metrics for one run.
 * @param {QueryScore[]} scores
 */
export function summarise(scores) {
  const primary = scores.filter((s) => s.answerable && !s.featureGap);
  const gap = scores.filter((s) => s.answerable && s.featureGap);
  const noAnswer = scores.filter((s) => !s.answerable);
  const top = scores.reduce((n, s) => n + s.top, 0);
  const judged = scores.reduce((n, s) => n + s.judged, 0);
  const violations = scores.reduce((n, s) => n + s.violations, 0);
  return {
    queries: scores.length,
    primary: block(primary),
    featureGap: block(gap),
    noAnswer: {
      n: noAnswer.length,
      correctEmpty: noAnswer.length ? noAnswer.filter((s) => s.empty).length / noAnswer.length : NaN,
      falsePositives: noAnswer.filter((s) => !s.empty && !s.error).length,
      errors: noAnswer.filter((s) => s.error).length,
    },
    violationsAt10: { total: violations, perQuery: scores.length ? violations / scores.length : NaN },
    judgedAt10: { judged, top, coverage: top === 0 ? 1 : judged / top },
    errors: scores.filter((s) => s.error).length,
  };
}

/**
 * Per-shape blocks (dev only; the holdout CLI never calls this).
 * @param {QueryScore[]} scores
 */
export function byShape(scores) {
  const shapes = [...new Set(scores.flatMap((s) => s.shapes))].sort();
  return Object.fromEntries(shapes.map((shape) => {
    const these = scores.filter((s) => s.shapes.includes(shape));
    const answerable = these.filter((s) => s.answerable);
    const noAnswer = these.filter((s) => !s.answerable);
    return [shape, {
      ...block(answerable),
      noAnswer: noAnswer.length,
      correctEmpty: noAnswer.length ? noAnswer.filter((s) => s.empty).length / noAnswer.length : NaN,
      violationsAt10: these.reduce((n, s) => n + s.violations, 0),
    }];
  }));
}

/**
 * Paired comparison of a candidate against a baseline over the same queries
 * and qrels. Deltas are candidate - baseline on the primary answerable set.
 * @param {QueryScore[]} base
 * @param {QueryScore[]} cand
 * @param {{ resamples?: number, seed?: number }} [options]
 */
export function compare(base, cand, options = {}) {
  const byId = new Map(cand.map((s) => [s.id, s]));
  if (base.length !== cand.length || base.some((s) => !byId.has(s.id))) {
    throw new Error('compare: runs must score the same queries');
  }
  const pairs = base.map((b) => ({ b, c: /** @type {QueryScore} */ (byId.get(b.id)) }));
  const primary = pairs.filter(({ b }) => b.answerable && !b.featureGap);

  /** @param {typeof pairs} ps @param {(typeof METRICS)[number]} m */
  const deltas = (ps, m) => ps.map(({ b, c }) => c[m] - b[m]);
  /** @param {typeof pairs} ps @param {{ alpha?: number }} [extra] */
  const stats = (ps, extra = {}) => Object.fromEntries(METRICS.map((m) => {
    const d = deltas(ps, m);
    return [m, {
      base: mean(ps.map(({ b }) => b[m])),
      cand: mean(ps.map(({ c }) => c[m])),
      delta: mean(d),
      bca: bcaInterval(d, { ...options, ...extra }),
      signFlip: signFlipP(d, options),
      cluster: clusteredInterval(d, ps.map(({ b }) => b.persona), { ...options, ...extra }),
    }];
  }));

  const noAnswer = pairs.filter(({ b }) => !b.answerable);
  const rate = (/** @type {QueryScore[]} */ xs) => (xs.length ? xs.filter((s) => s.empty).length / xs.length : NaN);
  const shapes = [...new Set(base.flatMap((s) => s.shapes))].sort();

  return {
    n: primary.length,
    overall: stats(primary),
    noAnswer: {
      n: noAnswer.length,
      base: rate(noAnswer.map(({ b }) => b)),
      cand: rate(noAnswer.map(({ c }) => c)),
      delta: rate(noAnswer.map(({ c }) => c)) - rate(noAnswer.map(({ b }) => b)),
    },
    /**
     * One-sided 95% bounds per shape come from a two-sided 90% interval.
     * `members`: positions (in the baseline's query order, never ids) of the
     * shape's answerable queries, so a gate can count distinct queries across shapes.
     */
    shapes: /** @type {Record<string, { n: number, members: number[] } & Partial<ReturnType<typeof stats>>>} */ (Object.fromEntries(shapes.map((shape) => {
      const members = pairs.flatMap(({ b }, i) => (b.answerable && b.shapes.includes(shape) ? [i] : []));
      const ps = members.map((i) => pairs[i]);
      return [shape, { n: ps.length, members, ...(ps.length ? stats(ps, { alpha: 0.1 }) : {}) }];
    }))),
    exactCodeRegressions: pairs
      .filter(({ b }) => b.shapes.some((t) => EXACT_CODE_SHAPES.includes(t)) && b.top1 !== null && b.top1Grade >= 1)
      .filter(({ b, c }) => c.top1 !== b.top1)
      .map(({ b }) => b.id),
    judged: {
      base: summarise(base).judgedAt10.coverage,
      cand: summarise(cand).judgedAt10.coverage,
    },
    /** Non-200 responses over every query of each run. */
    errors: {
      base: base.filter((s) => s.error).length,
      cand: cand.filter((s) => s.error).length,
    },
  };
}

/** @typedef {ReturnType<typeof compare>} Comparison */
