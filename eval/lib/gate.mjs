// @ts-check
// The gate a ranking change must pass. Takes a Comparison from metrics.mjs `compare()` (candidate vs
// the currently shipped ranker, same queries, same qrels) and a declaration
// of the change, and returns a verdict with every check that produced it.
//
// Per change:
//   dev     no exact-code regression, and ΔnDCG@10 BCa 95% lower bound > 0, OR (the change declares target
//           shapes, each target's ΔnDCG@10 > 0, and overall ΔnDCG@10 >= 0).
//           Tripwire on target shapes only: a target whose one-sided 95% upper
//           bound on ΔnDCG@10 is below 0 (a confident regression) fails.
//           A target whose every query moved by exactly 0 passes it.
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
//   test    On the sealed test set (the final measurement against eval-v0):
//           BCa 95% lower bounds of ΔnDCG@10 and ΔP@5 both > 0; judged@10 = 100%.
//   no-loss            (dev screen only) ΔnDCG@10 >= 0, point
//                      estimate, over the primary set less any `exempt` ids.
//                      Exempt ids leave only that figure: every other check
//                      (errors, exact-code, query count) is on the full set.
//   answerable-floor   (dev screen only) ΔnDCG@10 >= -0.01 over the
//                      primary answerable set.
//   compliance         (dev screen and holdout, never the test
//                      set) on constraint-filtered qrels (lib/compliance.mjs):
//                      ΔnDCG@10 >= 0 and ΔP@5 >= 0 over the primary set's
//                      scored queries; the constraint block's ΔnDCG@10 >= 0,
//                      a recorded vacuous pass when it has no scored query;
//                      compliance 100%; every unparsed query's top 10 equal
//                      to the baseline's. No new errors, judged@10 and the
//                      exact-code check read the raw qrels.
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

/** Change kinds that screen on dev only: no holdout or test verdict uses them. */
export const DEV_ONLY_KINDS = Object.freeze(['no-loss', 'answerable-floor']);
/** Every change kind `--change-kind` takes. */
export const CHANGE_KINDS = Object.freeze(['general', 'cutoff', 'compliance', ...DEV_ONLY_KINDS]);

/**
 * `exempt` (no-loss only, dev only): ids left out of the no-loss comparison.
 * @typedef {{ kind?: 'general' | 'cutoff' | 'compliance' | 'no-loss' | 'answerable-floor', targetShapes?: string[], exempt?: string[] }} Change
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
  // Exact-code check on dev too: the holdout has a single exact-code query.
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
    } else if (s.ndcg.bca.degenerate && Math.abs(s.ndcg.delta) <= EPS) {
      // Every query moved by exactly 0 (a degenerate interval at 0): no change
      // is no regression (ADR 0003).
      checks.push({ name, pass: true, detail: `n ${s.n}: every query's ΔnDCG@10 is 0 (degenerate interval at 0: no change, no regression)` });
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
 * What the compliance rule adds to a filtered comparison (lib/compliance.mjs
 * `applyComplianceRule`): the raw-qrels comparison and the counts its own
 * checks read. Counts only, never ids.
 * @typedef {{
 *   raw: Comparison,
 *   block: { n: number, delta: number },
 *   compliance: { queries: number, violations: number },
 *   identity: { queries: number, differing: number },
 *   newErrors: number,
 * }} ComplianceChecks `newErrors`: queries the candidate errors on where the baseline answered 200
 */

/** The ledger's rule cell when the constraint block had no scored query. */
export const VACUOUS_BLOCK_RULE = 'compliance (constraint block vacuous)';

/**
 * The compliance rule, the same on dev and the holdout. `cmp`
 * is the comparison on constraint-filtered qrels.
 * @param {string} set
 * @param {Comparison} cmp
 * @param {ComplianceChecks} c
 * @returns {Verdict}
 */
export function complianceGate(set, cmp, c) {
  const vacuous = c.block.n === 0;
  return verdict(set, [
    noNewErrorsCheck(c.raw),
    { name: 'no new errors, per query', pass: c.newErrors === 0, detail: `${c.newErrors} queries answered by the baseline get a non-200 response from the candidate` },
    sufficientCheck(cmp),
    judgedCheck(c.raw),
    { ...exactCodeCheck(c.raw), name: 'no exact-code regression (raw qrels)' },
    { name: 'ΔnDCG@10 >= 0 (filtered qrels)', pass: cmp.overall.ndcg.delta >= -EPS, detail: `${f(cmp.overall.ndcg.delta)} over ${cmp.n} primary scored queries` },
    { name: 'ΔP@5 >= 0 (filtered qrels)', pass: cmp.overall.p5.delta >= -EPS, detail: `${f(cmp.overall.p5.delta)} over ${cmp.n} primary scored queries` },
    {
      name: 'constraint block ΔnDCG@10 >= 0 (filtered qrels)',
      pass: vacuous || (Number.isFinite(c.block.delta) && c.block.delta >= -EPS),
      detail: vacuous ? 'vacuous pass: the constraint block has no scored query' : `${f(c.block.delta)} over ${c.block.n} scored queries`,
    },
    { name: 'compliance 100%', pass: c.compliance.violations === 0, detail: `${c.compliance.violations} shown results break the parsed constraints, over ${c.compliance.queries} parsed queries` },
    { name: 'unparsed queries keep their top 10', pass: c.identity.differing === 0, detail: `${c.identity.differing} of ${c.identity.queries} unparsed queries differ from the baseline in the top 10` },
  ]);
}

/**
 * The sealed test set: the shipped ranker vs eval-v0.
 * @param {Comparison} cmp
 * @returns {Verdict}
 */
export function testSetGate(cmp) {
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
 * `test-set`, `cutoff`, `no-loss`,
 * `answerable-floor`, `targeted: <shape,...>` or `general`.
 * Shape names are cut to [A-Za-z0-9._-].
 * @param {string} set dev | holdout | test
 * @param {Change} [change]
 */
export function ruleOf(set, change = {}) {
  if (set === 'test') return 'test-set';
  if (change.kind === 'cutoff' || change.kind === 'compliance' || (change.kind && DEV_ONLY_KINDS.includes(change.kind))) return change.kind;
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
 * @param {{ noLoss?: Comparison, compliance?: ComplianceChecks }} [options] `noLoss`, the comparison without no-loss's exempt ids (dev only);
 *   `compliance`, the compliance rule's checks (`cmp` is then on filtered qrels)
 * @returns {Verdict}
 */
export function gateFor(set, cmp, change = {}, options = {}) {
  const rule = ruleOf(set, change);
  if ((set === 'holdout' || set === 'test') && change.kind && DEV_ONLY_KINDS.includes(change.kind)) {
    throw new GateRuleError(`--change-kind ${change.kind} is a dev screen only: no ${set} verdict takes it`);
  }
  if (change.kind === 'compliance') {
    if (set === 'test') throw new GateRuleError('--change-kind compliance is not taken on the test set: it has one rule');
    if (!options.compliance) throw new GateRuleError('--change-kind compliance needs the compliance rule\'s checks (lib/compliance.mjs)');
    const v = complianceGate(set === 'holdout' ? 'holdout' : 'dev', cmp, options.compliance);
    return { ...v, rule: options.compliance.block.n === 0 ? VACUOUS_BLOCK_RULE : rule };
  }
  if (set === 'holdout') return { ...holdoutGate(cmp, change), rule };
  if (set === 'test') return { ...testSetGate(cmp), rule };
  return { ...devGate(cmp, change, options.noLoss), rule };
}
