// @ts-check
// The pre-committed ship gate (docs/plans/phase2.md, r2 "Gate", r3 cutoff
// rule, Final). Takes a Comparison from metrics.mjs `compare()` (candidate vs
// the currently shipped ranker, same queries, same qrels) and a declaration
// of the change, and returns a verdict with every check that produced it.
//
// Per change:
//   dev     no exact-code regression, and ΔnDCG@10 BCa 95% lower bound > 0, OR (the change declares target
//           shapes, each target's ΔnDCG@10 > 0, and overall ΔnDCG@10 >= 0).
//           Tripwire on target shapes only: a target whose one-sided 95% upper
//           bound on ΔnDCG@10 is below 0 (a confident regression) fails.
//   holdout ΔnDCG@10 >= 0 and ΔP@5 >= 0 (point estimates); no exact-code
//           regression; judged@10 = 100% for both runs.
//   cutoff  For a change whose purpose is the no-answer cutoff, the trade-off
//           rule replaces the Δ rules on both sets: correct-empty gain >= 0.25
//           and answerable ΔnDCG@10 >= -0.01. Dev applies it as the screen;
//           holdout governs. Because it is looser than the Δ rules, it is
//           not taken on the operator's word: `assertTruncation` refuses a
//           candidate whose result list for any query is neither the
//           baseline's nor a prefix of it (a cutoff truncates; it never
//           reorders or adds).
//   SC5     On the sealed test set: BCa 95% lower bounds of ΔnDCG@10 and ΔP@5
//           both > 0; judged@10 = 100%.
//
// Every gate fails a candidate with more errored (non-200) queries than its
// baseline ("no new errors"), and needs at least RULES.minQueries primary
// answerable queries ("insufficient queries" otherwise). When the verdict
// rests on a smaller comparison, that comparison has its own floor: a cutoff
// verdict needs RULES.minNoAnswerQueries no-answer queries, and the dev
// targeted route needs RULES.minTargetQueries distinct answerable queries
// across the target shapes (otherwise only the CI route can pass). A CI-based
// check never passes on a degenerate interval (stats.mjs: one query, or every
// delta equal), and a target-shape tripwire over fewer than
// RULES.minShapeQueriesForCi queries falls back to "point estimate >= 0".

import { CutoffError } from './errors.mjs';

/** Tolerance for "point estimate >= 0" so float summation noise cannot flip a verdict. */
const EPS = 1e-12;

export const RULES = Object.freeze({
  judgedRequired: 1,
  cutoffMinCorrectEmptyGain: 0.25,
  cutoffMaxNdcgLoss: 0.01,
  /** Fewer primary answerable queries than this and no gate can pass. */
  minQueries: 10,
  /** Fewer no-answer queries than this and a cutoff verdict cannot pass. */
  minNoAnswerQueries: 3,
  /** Fewer distinct answerable target-shape queries than this and the targeted route cannot pass. */
  minTargetQueries: 3,
  /** Below this many queries a shape tripwire uses the point estimate, not a CI. */
  minShapeQueriesForCi: 3,
});

/**
 * @typedef {{ kind?: 'general' | 'cutoff', targetShapes?: string[] }} Change
 * @typedef {{ name: string, pass: boolean, detail: string }} Check
 * @typedef {{ set: string, verdict: 'pass' | 'fail', checks: Check[], rule?: string }} Verdict
 * @typedef {import('./metrics.mjs').Comparison} Comparison
 */

/** @param {number} x */
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

/** @param {Comparison} cmp @returns {Check} */
function sufficientCheck(cmp) {
  const ok = cmp.n >= RULES.minQueries;
  return {
    name: `sufficient queries (>= ${RULES.minQueries} answerable)`,
    pass: ok,
    detail: ok ? `${cmp.n} primary answerable queries` : `insufficient queries: ${cmp.n} primary answerable, need ${RULES.minQueries}`,
  };
}

/**
 * A CI lower bound above 0, never on a degenerate interval.
 * @param {import('./stats.mjs').Interval} ci
 */
const lowerAboveZero = (ci) => !ci.degenerate && ci.lower > 0;

/** @param {import('./stats.mjs').Interval} ci */
const ciText = (ci) => `[${f(ci.lower)}, ${f(ci.upper)}]${ci.degenerate ? ' (degenerate: no variance)' : ''}`;

/** @param {Comparison} cmp @returns {Check} */
function noNewErrorsCheck(cmp) {
  return {
    name: 'no new errors',
    pass: cmp.errors.cand <= cmp.errors.base,
    detail: `non-200 responses: baseline ${cmp.errors.base}, candidate ${cmp.errors.cand}`,
  };
}

/** @param {Comparison} cmp @returns {Check} */
function judgedCheck(cmp) {
  const ok = cmp.judged.base >= RULES.judgedRequired - EPS && cmp.judged.cand >= RULES.judgedRequired - EPS;
  return {
    name: 'judged@10 = 100%',
    pass: ok,
    detail: `baseline ${(cmp.judged.base * 100).toFixed(1)}%, candidate ${(cmp.judged.cand * 100).toFixed(1)}%`,
  };
}

/** @param {Comparison} cmp @returns {Check} */
function exactCodeCheck(cmp) {
  return {
    name: 'no exact-code regression',
    pass: cmp.exactCodeRegressions.length === 0,
    detail: `${cmp.exactCodeRegressions.length} exact-code queries lost their rank-1 hit`,
  };
}

/** @param {Comparison} cmp @returns {Check[]} */
function cutoffChecks(cmp) {
  const gain = cmp.noAnswer.delta;
  const loss = -cmp.overall.ndcg.delta;
  const enough = cmp.noAnswer.n >= RULES.minNoAnswerQueries;
  return [
    {
      name: `sufficient no-answer queries (>= ${RULES.minNoAnswerQueries})`,
      pass: enough,
      detail: enough ? `${cmp.noAnswer.n} no-answer queries` : `insufficient queries: ${cmp.noAnswer.n} no-answer, need ${RULES.minNoAnswerQueries}`,
    },
    {
      name: `correct-empty gain >= ${RULES.cutoffMinCorrectEmptyGain}`,
      pass: Number.isFinite(gain) && gain >= RULES.cutoffMinCorrectEmptyGain - EPS,
      detail: `${f(cmp.noAnswer.base)} -> ${f(cmp.noAnswer.cand)} over ${cmp.noAnswer.n} no-answer queries`,
    },
    {
      name: `answerable nDCG@10 loss <= ${RULES.cutoffMaxNdcgLoss}`,
      pass: loss <= RULES.cutoffMaxNdcgLoss + EPS,
      detail: `ΔnDCG@10 ${f(cmp.overall.ndcg.delta)}`,
    },
  ];
}

/**
 * @param {string} set
 * @param {Check[]} checks
 * @returns {Verdict}
 */
const verdict = (set, checks) => ({ set, verdict: checks.every((c) => c.pass) ? 'pass' : 'fail', checks });

/**
 * Dev screen for one change.
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @returns {Verdict}
 */
export function devGate(cmp, change = {}) {
  // Exact-code check on dev too: the holdout has a single exact-code query (ADR 0003 v2.1).
  const checks = [noNewErrorsCheck(cmp), sufficientCheck(cmp), judgedCheck(cmp), exactCodeCheck(cmp)];
  if (change.kind === 'cutoff') return verdict('dev', [...checks, ...cutoffChecks(cmp)]);

  const targets = change.targetShapes ?? [];
  const ndcg = cmp.overall.ndcg;
  const ciPass = lowerAboveZero(ndcg.bca);
  const missing = targets.filter((t) => !cmp.shapes[t]?.ndcg);
  // Distinct answerable queries across the targets (a query may carry several shapes).
  const targetN = new Set(targets.flatMap((t) => /** @type {any} */ (cmp.shapes[t])?.members ?? [])).size;
  const targetedPass = targets.length > 0 && missing.length === 0
    && targetN >= RULES.minTargetQueries
    && targets.every((t) => /** @type {any} */ (cmp.shapes[t]).ndcg.delta > EPS)
    && ndcg.delta >= -EPS;
  checks.push({
    name: targets.length ? 'ΔnDCG@10 CI lower > 0, or targeted shapes improve and overall Δ >= 0' : 'ΔnDCG@10 BCa 95% lower bound > 0',
    pass: ciPass || targetedPass,
    detail: `ΔnDCG@10 ${f(ndcg.delta)} ${ciText(ndcg.bca)}`
      + (targets.length ? `; targets ${targets.map((t) => `${t} Δ ${f(/** @type {any} */ (cmp.shapes[t])?.ndcg?.delta ?? NaN)}`).join(', ')}`
        + ` (n ${targetN}${targetN < RULES.minTargetQueries ? `, insufficient queries for the targeted route: need ${RULES.minTargetQueries}` : ''})` : ''),
  });
  for (const t of targets) {
    const s = /** @type {any} */ (cmp.shapes[t]);
    const name = `tripwire: ${t} not confidently regressed`;
    if (!s?.ndcg) {
      checks.push({ name, pass: false, detail: 'no answerable queries with this shape' });
    } else if (s.n < RULES.minShapeQueriesForCi) {
      // Too few queries for an interval: fall back to the point estimate.
      checks.push({ name, pass: s.ndcg.delta >= -EPS, detail: `n ${s.n} < ${RULES.minShapeQueriesForCi}: point estimate ΔnDCG@10 ${f(s.ndcg.delta)} >= 0` });
    } else {
      /** @type {import('./stats.mjs').Interval} */
      const ci = s.ndcg.bca;
      checks.push({
        name,
        pass: !ci.degenerate && Number.isFinite(ci.upper) && ci.upper >= 0,
        detail: `n ${s.n}, ΔnDCG@10 ${f(s.ndcg.delta)}, one-sided 95% upper ${f(ci.upper)}${ci.degenerate ? ' (degenerate: no variance)' : ''}`,
      });
    }
  }
  return verdict('dev', checks);
}

/**
 * Holdout verdict for one change. The CLI prints only `verdict` and the
 * overall Δ lines, never `checks` details that name queries.
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @returns {Verdict}
 */
export function holdoutGate(cmp, change = {}) {
  const checks = [noNewErrorsCheck(cmp), sufficientCheck(cmp), judgedCheck(cmp), exactCodeCheck(cmp)];
  if (change.kind === 'cutoff') return verdict('holdout', [...checks, ...cutoffChecks(cmp)]);
  checks.push(
    { name: 'ΔnDCG@10 >= 0', pass: cmp.overall.ndcg.delta >= -EPS, detail: f(cmp.overall.ndcg.delta) },
    { name: 'ΔP@5 >= 0', pass: cmp.overall.p5.delta >= -EPS, detail: f(cmp.overall.p5.delta) },
  );
  return verdict('holdout', checks);
}

/**
 * SC5 on the sealed test set: final shipped ranker vs eval-v0.
 * @param {Comparison} cmp
 * @returns {Verdict}
 */
export function sc5Gate(cmp) {
  return verdict('test', [
    noNewErrorsCheck(cmp),
    sufficientCheck(cmp),
    judgedCheck(cmp),
    { name: 'ΔnDCG@10 BCa 95% lower bound > 0', pass: lowerAboveZero(cmp.overall.ndcg.bca), detail: ciText(cmp.overall.ndcg.bca) },
    { name: 'ΔP@5 BCa 95% lower bound > 0', pass: lowerAboveZero(cmp.overall.p5.bca), detail: ciText(cmp.overall.p5.bca) },
  ]);
}

/**
 * The rule a verdict applies, as printed and recorded in the ledger:
 * `sc5` (the test set), `cutoff`, `targeted: <shape,...>` or `general`.
 * Shape names are cut to [A-Za-z0-9._-].
 * @param {string} set dev | holdout | test
 * @param {Change} [change]
 */
export function ruleOf(set, change = {}) {
  if (set === 'test') return 'sc5';
  if (change.kind === 'cutoff') return 'cutoff';
  const targets = (change.targetShapes ?? []).map((t) => t.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 40));
  return targets.length ? `targeted: ${targets.join(',')}` : 'general';
}

/**
 * Throws CutoffError unless, for every query, the candidate's result has the
 * baseline's status and its codes are the baseline's or a prefix of them.
 * The message counts queries and names none.
 * @param {import('./metrics.mjs').RunFile} base
 * @param {import('./metrics.mjs').RunFile} cand
 */
export function assertTruncation(base, cand) {
  const ids = new Set([...Object.keys(base.results), ...Object.keys(cand.results)]);
  let bad = 0;
  for (const id of ids) {
    const b = base.results[id], c = cand.results[id];
    const bc = b?.codes ?? [], cc = c?.codes ?? [];
    if (!b || !c || b.status !== c.status || cc.length > bc.length || cc.some((code, i) => code !== bc[i])) bad++;
  }
  if (bad) {
    throw new CutoffError(`--change-kind cutoff: candidate ${cand.variant} is not a truncation of baseline ${base.variant} on ${bad} of ${ids.size} queries`
      + ' (a cutoff only shortens result lists: each must be the baseline\'s, or a prefix of it, with the same status); judge it as --change-kind general');
  }
}

/**
 * The gate for a set; the verdict carries the rule it applied (`ruleOf`).
 * @param {string} set dev | holdout | test (anything else is screened as dev)
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @returns {Verdict}
 */
export function gateFor(set, cmp, change) {
  const rule = ruleOf(set, change);
  if (set === 'holdout') return { ...holdoutGate(cmp, change), rule };
  if (set === 'test') return { ...sc5Gate(cmp), rule };
  return { ...devGate(cmp, change), rule };
}
