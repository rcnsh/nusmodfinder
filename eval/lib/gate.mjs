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
//           both > 0; judged@10 = 100%. On the holdout only by `--gate sc5`,
//           and only under the holdout reading of SC5 (SC5_READING, tied to
//           ADR 0003's "SC5 reading" by test/eval/gate.node.test.js).
//   no-loss            (dev screen only; 3F, 3H) ΔnDCG@10 >= 0, point
//                      estimate, over the primary set less any `exempt` ids.
//                      Exempt ids leave only that figure: every other check
//                      (errors, exact-code, query count) is on the full set.
//   answerable-floor   (dev screen only; 3G) ΔnDCG@10 >= -0.01 over the
//                      primary answerable set.
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

import { CutoffError, GateRuleError } from './errors.mjs';

/** Tolerance for "point estimate >= 0" so float summation noise cannot flip a verdict. */
const EPS = 1e-12;

export const RULES = Object.freeze({
  judgedRequired: 1,
  cutoffMinCorrectEmptyGain: 0.25,
  cutoffMaxNdcgLoss: 0.01,
  /** answerable-floor: the largest answerable ΔnDCG@10 loss allowed. */
  floorMaxNdcgLoss: 0.01,
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
 * Which set decides SC5, as ADR 0003 "SC5 reading" records it: `sealed` (the
 * sealed test set, one look) or `holdout` (L12 on the holdout, `--gate sc5`).
 * A test ties this to the ADR's text, so changing the reading means changing
 * the ADR in the same PR.
 * @type {'sealed' | 'holdout'}
 */
export const SC5_READING = 'sealed';

/** Change kinds that screen on dev only: no holdout or test verdict uses them. */
export const DEV_ONLY_KINDS = Object.freeze(['no-loss', 'answerable-floor']);
/** Every change kind `--change-kind` takes. */
export const CHANGE_KINDS = Object.freeze(['general', 'cutoff', ...DEV_ONLY_KINDS]);

/**
 * Throws GateRuleError unless the SC5 rule may be taken on `set`'s gate: the
 * test set always; the holdout only under the holdout reading; dev never.
 * @param {string} set dev | holdout | test
 * @param {'sealed' | 'holdout'} [reading]
 */
export function assertSc5Allowed(set, reading = SC5_READING) {
  if (set === 'test') return;
  if (set !== 'holdout') throw new GateRuleError(`--gate sc5 is not taken on dev: SC5 is decided on the sealed test set or, under the holdout reading, on the holdout`);
  if (reading !== 'holdout') {
    throw new GateRuleError('--gate sc5 is refused on the holdout: ADR 0003 records the sealed-test-set reading of SC5, so the holdout is never read for SC5 (L12 is unused)');
  }
}

/**
 * `gate: 'sc5'` takes the SC5 rule on the holdout (assertSc5Allowed).
 * `exempt` (no-loss only, dev only): ids left out of the no-loss comparison.
 * @typedef {{ kind?: 'general' | 'cutoff' | 'no-loss' | 'answerable-floor', targetShapes?: string[], gate?: 'sc5', exempt?: string[] }} Change
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
      detail: enough ? `${cmp.noAnswer.n} no-answer queries` : `insufficient queries: ${cmp.noAnswer.n} no-answer (tagged, no grade-≥1 document), need ${RULES.minNoAnswerQueries}; a cutoff verdict cannot pass on this set`,
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
 * The dev-only kinds' decisive check. `noLoss` is the comparison without the
 * exempt ids, used for the no-loss ΔnDCG@10 and its n only.
 * @param {Comparison} cmp
 * @param {Change} change
 * @param {Comparison} [noLoss]
 * @returns {Check}
 */
function devKindCheck(cmp, change, noLoss = cmp) {
  const d = cmp.overall.ndcg.delta;
  if (change.kind === 'no-loss') {
    const exempt = change.exempt?.length ?? 0;
    const dn = noLoss.overall.ndcg.delta;
    return {
      name: 'ΔnDCG@10 >= 0 (no-loss)',
      pass: Number.isFinite(dn) && dn >= -EPS,
      detail: `ΔnDCG@10 ${f(dn)} over ${noLoss.n} primary answerable queries${exempt ? `, ${exempt} exempt left out` : ''}`,
    };
  }
  return {
    name: `answerable ΔnDCG@10 >= -${RULES.floorMaxNdcgLoss}`,
    pass: Number.isFinite(d) && -d <= RULES.floorMaxNdcgLoss + EPS,
    detail: `ΔnDCG@10 ${f(d)} over ${cmp.n} primary answerable queries`,
  };
}

/**
 * @param {string} set
 * @param {Check[]} checks
 * @returns {Verdict}
 */
const verdict = (set, checks) => ({ set, verdict: checks.every((c) => c.pass) ? 'pass' : 'fail', checks });

/**
 * Dev screen for one change. Every check reads `cmp`, the full comparison;
 * `noLoss` (no-loss with `exempt` ids: the comparison without them) feeds the
 * no-loss ΔnDCG@10 alone.
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @param {Comparison} [noLoss]
 * @returns {Verdict}
 */
export function devGate(cmp, change = {}, noLoss = cmp) {
  // Exact-code check on dev too: the holdout has a single exact-code query (ADR 0003 v2.1).
  const checks = [noNewErrorsCheck(cmp), sufficientCheck(cmp), judgedCheck(cmp), exactCodeCheck(cmp)];
  if (change.kind === 'cutoff') return verdict('dev', [...checks, ...cutoffChecks(cmp)]);
  if (change.kind && DEV_ONLY_KINDS.includes(change.kind)) return verdict('dev', [...checks, devKindCheck(cmp, change, noLoss)]);

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
 * SC5: final shipped ranker vs eval-v0, on the sealed test set (or, under the
 * holdout reading, on the holdout: `set` names it).
 * @param {Comparison} cmp
 * @param {string} [set]
 * @returns {Verdict}
 */
export function sc5Gate(cmp, set = 'test') {
  return verdict(set, [
    noNewErrorsCheck(cmp),
    sufficientCheck(cmp),
    judgedCheck(cmp),
    { name: 'ΔnDCG@10 BCa 95% lower bound > 0', pass: lowerAboveZero(cmp.overall.ndcg.bca), detail: ciText(cmp.overall.ndcg.bca) },
    { name: 'ΔP@5 BCa 95% lower bound > 0', pass: lowerAboveZero(cmp.overall.p5.bca), detail: ciText(cmp.overall.p5.bca) },
  ]);
}

/**
 * The rule a verdict applies, as printed and recorded in the ledger:
 * `sc5` (the test set, or `--gate sc5`), `cutoff`, `no-loss`,
 * `answerable-floor`, `targeted: <shape,...>` or `general`.
 * Shape names are cut to [A-Za-z0-9._-].
 * @param {string} set dev | holdout | test
 * @param {Change} [change]
 */
export function ruleOf(set, change = {}) {
  if (set === 'test' || change.gate === 'sc5') return 'sc5';
  if (change.kind === 'cutoff' || (change.kind && DEV_ONLY_KINDS.includes(change.kind))) return change.kind;
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
 * @param {{ reading?: 'sealed' | 'holdout', noLoss?: Comparison }} [options] the SC5 reading (default: the
 *   recorded SC5_READING); `noLoss`, the comparison without no-loss's exempt ids (dev only)
 * @returns {Verdict}
 */
export function gateFor(set, cmp, change = {}, options = {}) {
  const rule = ruleOf(set, change);
  if ((set === 'holdout' || set === 'test') && change.kind && DEV_ONLY_KINDS.includes(change.kind)) {
    throw new GateRuleError(`--change-kind ${change.kind} is a dev screen only: no ${set} verdict takes it`);
  }
  if (change.gate === 'sc5') {
    assertSc5Allowed(set, options.reading);
    return { ...sc5Gate(cmp, set), rule };
  }
  if (set === 'holdout') return { ...holdoutGate(cmp, change), rule };
  if (set === 'test') return { ...sc5Gate(cmp), rule };
  return { ...devGate(cmp, change, options.noLoss), rule };
}
