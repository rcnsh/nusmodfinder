// @ts-check
// Plain-text tables for the CLI. Dev output is full; holdout/test output is
// produced only by `verdictOnly()` (and, for the compliance rule,
// `complianceVerdictOnly()`), which print the verdict, the overall deltas
// with CIs and counts, and nothing per query or per shape.

/** @param {number} x @param {number} [d] */
export const fmt = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '—');
/** @param {number} x */
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—');
/** @param {number} x */
const signed = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(3)}` : '—');

/** What an unscored query is, as every report says it. */
export const UNSCORED_NOTE = 'untagged, no grade-≥1 document; in neither set';

/**
 * @param {string[][]} rows first row is the header
 */
export function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  const line = (/** @type {string[]} */ r) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

/**
 * @param {{ name: string, summary: ReturnType<typeof import('./metrics.mjs').summarise> }[]} runs
 */
export function summaryTable(runs) {
  const rows = [['metric', ...runs.map((r) => r.name)]];
  const add = (/** @type {string} */ label, /** @type {(s: any) => string} */ get) => rows.push([label, ...runs.map((r) => get(r.summary))]);
  add('answerable (primary) n', (s) => String(s.primary.n));
  add('nDCG@10', (s) => fmt(s.primary.ndcg));
  add('P@5', (s) => fmt(s.primary.p5));
  add('MRR@10', (s) => fmt(s.primary.mrr));
  add('feature-gap n', (s) => String(s.featureGap.n));
  add('feature-gap nDCG@10', (s) => fmt(s.featureGap.ndcg));
  add('no-answer n', (s) => String(s.noAnswer.n));
  add('no-answer correct-empty', (s) => pct(s.noAnswer.correctEmpty));
  add('no-answer false positives', (s) => String(s.noAnswer.falsePositives));
  add('no-answer errors (non-200)', (s) => String(s.noAnswer.errors));
  add('unscored n', (s) => String(s.unscored));
  add('violations@10 (total)', (s) => String(s.violationsAt10.total));
  add('judged@10', (s) => pct(s.judgedAt10.coverage));
  add('non-200 responses', (s) => String(s.errors));
  return table(rows);
}

/** A qrels version as printed: only [A-Za-z0-9._-], at most 40 characters. */
export const qrelsLabel = (/** @type {unknown} */ v) => String(v).replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 40);

/**
 * @param {import('./metrics.mjs').Comparison} cmp
 * @param {string} base
 * @param {string} cand
 * @param {string} qrelsVersion
 */
export function comparisonTable(cmp, base, cand, qrelsVersion) {
  const rows = [['Δ (cand − base)', base, cand, 'Δ', 'BCa 95% CI', 'sign-flip p', 'persona-cluster 95% CI']];
  for (const [label, m] of /** @type {const} */ ([['nDCG@10', 'ndcg'], ['P@5', 'p5'], ['MRR@10', 'rr']])) {
    const s = cmp.overall[m];
    rows.push([label, fmt(s.base), fmt(s.cand), signed(s.delta), `[${fmt(s.bca.lower)}, ${fmt(s.bca.upper)}]`, fmt(s.signFlip.p, 4), `[${fmt(s.cluster.lower)}, ${fmt(s.cluster.upper)}] (${s.cluster.clusters})`]);
  }
  rows.push(['correct-empty', pct(cmp.noAnswer.base), pct(cmp.noAnswer.cand), signed(cmp.noAnswer.delta), '', '', `n ${cmp.noAnswer.n}`]);
  return `paired over ${cmp.n} primary answerable queries · qrels ${qrelsLabel(qrelsVersion)}\n${table(rows)}`;
}

/**
 * @param {Record<string, any>} baseShapes byShape() of the baseline
 * @param {Record<string, any>} candShapes byShape() of the candidate
 * @param {import('./metrics.mjs').Comparison | null} cmp
 */
export function shapeTable(baseShapes, candShapes, cmp) {
  const rows = [['shape', 'n', 'nDCG base', 'nDCG cand', 'Δ', 'one-sided 95% upper', 'P@5 cand', 'no-answer', 'unscored', 'violations@10']];
  for (const shape of Object.keys(candShapes)) {
    const b = baseShapes[shape], c = candShapes[shape], d = cmp?.shapes[shape];
    rows.push([shape, String(c.n), fmt(b?.ndcg), fmt(c.ndcg), d?.ndcg ? signed(d.ndcg.delta) : '—', d?.ndcg ? fmt(d.ndcg.bca.upper) : '—', fmt(c.p5), c.noAnswer ? `${c.noAnswer} (${pct(c.correctEmpty)} empty)` : '0', String(c.unscored ?? 0), String(c.violationsAt10)]);
  }
  return table(rows);
}

/**
 * @param {import('./gate.mjs').Verdict} v
 */
export function verdictBlock(v) {
  return [`gate (${v.set}): ${v.verdict.toUpperCase()}${v.rule ? ` · rule ${v.rule}` : ''}`, ...v.checks.map((c) => `  [${c.pass ? 'pass' : 'FAIL'}] ${c.name} — ${c.detail}`)].join('\n');
}

/** What an unscored query is under the compliance rule. */
export const COMPLIANCE_UNSCORED_NOTE = 'no grade-≥1 document, or none left once the constraints filter the qrels; in neither set';

/**
 * The compliance rule's output on an encrypted set (Phase 5 5F): the verdict,
 * the Δ lines (primary nDCG@10 and P@5 with their CIs, the constraint block's
 * nDCG@10) and the counts (scored, unscored, parsed). Never an id, a text, a
 * check's detail or which check failed.
 * @param {import('./gate.mjs').Verdict} v
 * @param {import('./metrics.mjs').Comparison} cmp the comparison on filtered qrels
 * @param {{ block: { n: number, delta: number }, counts: { parsed: number, primary: number, block: number, unscored: number } }} c
 * @param {string} qrelsVersion
 * @param {string} baseline
 */
export function complianceVerdictOnly(v, cmp, c, qrelsVersion, baseline) {
  const ci = (/** @type {'ndcg' | 'p5'} */ m) => `${signed(cmp.overall[m].delta)} [${fmt(cmp.overall[m].bca.lower)}, ${fmt(cmp.overall[m].bca.upper)}]`;
  const block = c.block.n === 0 ? 'constraint block ΔnDCG@10 — (vacuous pass: no scored query)' : `constraint block ΔnDCG@10 ${signed(c.block.delta)} (n ${c.block.n})`;
  return {
    text: [
      `${v.set} verdict: ${v.verdict.toUpperCase()} · rule ${v.rule ?? 'compliance'} · baseline ${baseline} · qrels ${qrelsLabel(qrelsVersion)}`,
      `ΔnDCG@10 ${ci('ndcg')} (BCa 95%, constraint-filtered qrels)`,
      `ΔP@5     ${ci('p5')} (BCa 95%, constraint-filtered qrels)`,
      block,
      `scored queries: ${c.counts.primary} primary, ${c.counts.block} constraint block · unscored queries: ${c.counts.unscored} · parsed queries: ${c.counts.parsed}`,
    ].join('\n'),
    ndcg: ci('ndcg'),
    p5: ci('p5'),
  };
}

/**
 * The only output an encrypted set ever produces. The first line names the
 * rule applied (gate.mjs `ruleOf`) and the baseline ranker it was taken
 * against ("eval-v0 7ac9841"); the last gives the unscored count, never ids.
 * @param {import('./gate.mjs').Verdict} v
 * @param {import('./metrics.mjs').Comparison} cmp
 * @param {string} qrelsVersion
 * @param {string} baseline
 */
export function verdictOnly(v, cmp, qrelsVersion, baseline) {
  const ci = (/** @type {'ndcg' | 'p5'} */ m) => `${signed(cmp.overall[m].delta)} [${fmt(cmp.overall[m].bca.lower)}, ${fmt(cmp.overall[m].bca.upper)}]`;
  return {
    text: [`${v.set} verdict: ${v.verdict.toUpperCase()} · rule ${v.rule ?? 'general'} · baseline ${baseline} · qrels ${qrelsLabel(qrelsVersion)}`, `ΔnDCG@10 ${ci('ndcg')} (BCa 95%)`, `ΔP@5     ${ci('p5')} (BCa 95%)`, `unscored queries: ${cmp.unscored.n} (${UNSCORED_NOTE})`].join('\n'),
    ndcg: ci('ndcg'),
    p5: ci('p5'),
  };
}
