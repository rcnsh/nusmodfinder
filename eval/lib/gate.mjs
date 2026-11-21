// @ts-check

import { CutoffError, GateRuleError } from './errors.mjs';

const EPS = 1e-12;

export const RULES = Object.freeze({
  judgedRequired: 1,
  cutoffMinCorrectEmptyGain: 0.25,
  cutoffMaxNdcgLoss: 0.01,
  floorMaxNdcgLoss: 0.01,
  minQueries: 10,
  minNoAnswerQueries: 3,
  minTargetQueries: 3,
  minShapeQueriesForCi: 3,
});

export const DEV_ONLY_KINDS = Object.freeze(['no-loss', 'answerable-floor']);
export const CHANGE_KINDS = Object.freeze(['general', 'cutoff', 'compliance', ...DEV_ONLY_KINDS]);

/**
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

/** @param {import('./stats.mjs').Interval} ci */
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
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @param {Comparison} [noLoss]
 * @returns {Verdict}
 */
export function devGate(cmp, change = {}, noLoss = cmp) {
  const checks = [noNewErrorsCheck(cmp), sufficientCheck(cmp), judgedCheck(cmp), exactCodeCheck(cmp)];
  if (change.kind === 'cutoff') return verdict('dev', [...checks, ...cutoffChecks(cmp)]);
  if (change.kind && DEV_ONLY_KINDS.includes(change.kind)) return verdict('dev', [...checks, devKindCheck(cmp, change, noLoss)]);

  const targets = change.targetShapes ?? [];
  const ndcg = cmp.overall.ndcg;
  const ciPass = lowerAboveZero(ndcg.bca);
  const missing = targets.filter((t) => !cmp.shapes[t]?.ndcg);
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
      checks.push({ name, pass: s.ndcg.delta >= -EPS, detail: `n ${s.n} < ${RULES.minShapeQueriesForCi}: point estimate ΔnDCG@10 ${f(s.ndcg.delta)} >= 0` });
    } else if (s.ndcg.bca.degenerate && Math.abs(s.ndcg.delta) <= EPS) {
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
 * @typedef {{
 *   raw: Comparison,
 *   block: { n: number, delta: number },
 *   compliance: { queries: number, violations: number },
 *   identity: { queries: number, differing: number },
 *   newErrors: number,
 * }} ComplianceChecks
 */

export const VACUOUS_BLOCK_RULE = 'compliance (constraint block vacuous)';

/**
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
 * @param {string} set
 * @param {Change} [change]
 */
export function ruleOf(set, change = {}) {
  if (set === 'test') return 'test-set';
  if (change.kind === 'cutoff' || change.kind === 'compliance' || (change.kind && DEV_ONLY_KINDS.includes(change.kind))) return change.kind;
  const targets = (change.targetShapes ?? []).map((t) => t.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 40));
  return targets.length ? `targeted: ${targets.join(',')}` : 'general';
}

/**
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
 * @param {string} set
 * @param {Comparison} cmp
 * @param {Change} [change]
 * @param {{ noLoss?: Comparison, compliance?: ComplianceChecks }} [options]
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
