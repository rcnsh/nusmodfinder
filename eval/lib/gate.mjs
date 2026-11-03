// @ts-check
// The pre-committed ship gate (docs/plans/phase2.md, r2 "Gate", r3 cutoff
// rule, Final). Takes a Comparison from metrics.mjs `compare()` (candidate vs
// the currently shipped ranker, same queries, same qrels) and a declaration
// of the change, and returns a verdict with every check that produced it.
//
// Per change:
//   dev     ΔnDCG@10 BCa 95% lower bound > 0, OR (the change declares target
//           shapes, each target's ΔnDCG@10 > 0, and overall ΔnDCG@10 >= 0).
//           Tripwire on target shapes only: a target whose one-sided 95% upper
//           bound on ΔnDCG@10 is below 0 (a confident regression) fails.
//   holdout ΔnDCG@10 >= 0 and ΔP@5 >= 0 (point estimates); no exact-code
//           regression; judged@10 = 100% for both runs.
//   cutoff  For a change whose purpose is the no-answer cutoff, the trade-off
//           rule replaces the Δ rules on both sets: correct-empty gain >= 0.25
//           and answerable ΔnDCG@10 >= -0.01. Dev applies it as the screen;
//           holdout governs.
//   SC5     On the sealed test set: BCa 95% lower bounds of ΔnDCG@10 and ΔP@5
//           both > 0; judged@10 = 100%.

/** Tolerance for "point estimate >= 0" so float summation noise cannot flip a verdict. */
const EPS = 1e-12;

export const RULES = Object.freeze({
  judgedRequired: 1,
  cutoffMinCorrectEmptyGain: 0.25,
  cutoffMaxNdcgLoss: 0.01,
});

/**
 * @typedef {{ kind?: 'general' | 'cutoff', targetShapes?: string[] }} Change
 * @typedef {{ name: string, pass: boolean, detail: string }} Check
 * @typedef {{ set: string, verdict: 'pass' | 'fail', checks: Check[] }} Verdict
 * @typedef {import('./metrics.mjs').Comparison} Comparison
 */

/** @param {number} x */
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x));

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
  return [
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
  const checks = [judgedCheck(cmp)];
  if (change.kind === 'cutoff') return verdict('dev', [...checks, ...cutoffChecks(cmp)]);

  const targets = change.targetShapes ?? [];
  const ndcg = cmp.overall.ndcg;
  const ciPass = ndcg.bca.lower > 0;
  const missing = targets.filter((t) => !cmp.shapes[t]?.ndcg);
  const targetedPass = targets.length > 0 && missing.length === 0
    && targets.every((t) => /** @type {any} */ (cmp.shapes[t]).ndcg.delta > EPS)
    && ndcg.delta >= -EPS;
  checks.push({
    name: targets.length ? 'ΔnDCG@10 CI lower > 0, or targeted shapes improve and overall Δ >= 0' : 'ΔnDCG@10 BCa 95% lower bound > 0',
    pass: ciPass || targetedPass,
    detail: `ΔnDCG@10 ${f(ndcg.delta)} [${f(ndcg.bca.lower)}, ${f(ndcg.bca.upper)}]`
      + (targets.length ? `; targets ${targets.map((t) => `${t} Δ ${f(/** @type {any} */ (cmp.shapes[t])?.ndcg?.delta ?? NaN)}`).join(', ')}` : ''),
  });
  for (const t of targets) {
    const s = /** @type {any} */ (cmp.shapes[t]);
    const upper = s?.ndcg?.bca?.upper ?? NaN;
    checks.push({
      name: `tripwire: ${t} not confidently regressed`,
      pass: Number.isFinite(upper) && upper >= 0,
      detail: s?.ndcg ? `n ${s.n}, ΔnDCG@10 ${f(s.ndcg.delta)}, one-sided 95% upper ${f(upper)}` : 'no answerable queries with this shape',
    });
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
  const checks = [judgedCheck(cmp), exactCodeCheck(cmp)];
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
    judgedCheck(cmp),
    { name: 'ΔnDCG@10 BCa 95% lower bound > 0', pass: cmp.overall.ndcg.bca.lower > 0, detail: `[${f(cmp.overall.ndcg.bca.lower)}, ${f(cmp.overall.ndcg.bca.upper)}]` },
    { name: 'ΔP@5 BCa 95% lower bound > 0', pass: cmp.overall.p5.bca.lower > 0, detail: `[${f(cmp.overall.p5.bca.lower)}, ${f(cmp.overall.p5.bca.upper)}]` },
  ]);
}

/**
 * The gate for a set.
 * @param {string} set dev | holdout | test (anything else is screened as dev)
 * @param {Comparison} cmp
 * @param {Change} [change]
 */
export function gateFor(set, cmp, change) {
  if (set === 'holdout') return holdoutGate(cmp, change);
  if (set === 'test') return sc5Gate(cmp);
  return devGate(cmp, change);
}
