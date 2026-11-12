// @ts-check
// The compliance rule's open-set report (dev and the fixture).
// The same rule as the holdout's verdict path (lib/compliance.mjs, gate.mjs
// `complianceGate`), with the per-query detail an open set may print. With
// `gate: false` it is the explicit-params diagnostic: the candidate against
// the baseline sent the parsed constraints as explicit params; reported, never
// a verdict.
// Never called for an encrypted set (the CLI prints complianceVerdictOnly).
import { applyComplianceRule } from './compliance.mjs';
import { gateFor } from './gate.mjs';
import { byShape, summarise } from './metrics.mjs';
import { comparisonTable, fmt, shapeTable, summaryTable, verdictBlock } from './report.mjs';

/** @param {number} x */
const signed = (x) => (Number.isFinite(x) ? `${x >= 0 ? '+' : ''}${x.toFixed(3)}` : '—');

/**
 * @param {{
 *   set: import('./sets.mjs').SetLayout,
 *   queries: import('./metrics.mjs').EvalQuery[],
 *   qrels: import('./metrics.mjs').Qrels,
 *   qrelsVersion: string,
 *   base: import('./metrics.mjs').RunFile,
 *   cand: import('./metrics.mjs').RunFile,
 *   sources: import('./compliance.mjs').RuleSources,
 *   gate?: boolean,
 *   change?: import('./gate.mjs').Change,
 * }} o `qrels` with the corpus groups joined
 */
export function devComplianceReport(o) {
  if (o.set.encrypted) throw new Error('the compliance rule\'s open report is for dev and the fixture only');
  const gate = o.gate !== false;
  const r = applyComplianceRule({ queries: o.queries, qrels: o.qrels, base: o.base, cand: o.cand, sources: o.sources, explicitBaseline: !gate });
  const recorded = /** @type {any} */ (o.cand.config)?.vocabulary?.sha256 ?? null;
  const vocabMatch = recorded === o.sources.source.vocabularySha256;
  /** @type {string[]} */
  const out = [];
  out.push(`\n${gate ? 'compliance rule' : 'diagnostic: candidate vs the baseline run with the parsed constraints as explicit params; reported, never gated'} · set ${o.set.name}`);
  out.push(`reference parse ${o.sources.source.reference} · its vocabulary sha256 ${o.sources.source.vocabularySha256.slice(0, 12)}…; candidate run recorded ${recorded ? `${String(recorded).slice(0, 12)}…` : 'none'} (${vocabMatch ? 'same' : 'DIFFERENT'})`);
  out.push(`constraint fields: ${o.sources.source.fields}`);
  out.push(summaryTable([{ name: `${o.base.variant} (filtered)`, summary: summarise(r.scores.base) }, { name: `${o.cand.variant} (filtered)`, summary: summarise(r.scores.cand) }]));
  out.push(`\n${comparisonTable(r.cmp, o.base.variant, o.cand.variant, `${o.qrelsVersion} filtered`)}`);
  out.push(`raw qrels, for reference: ΔnDCG@10 ${signed(r.raw.overall.ndcg.delta)} over ${r.raw.n}, ΔP@5 ${signed(r.raw.overall.p5.delta)}`);
  out.push(r.block.n === 0
    ? 'constraint block: no scored query (vacuous pass)'
    : `constraint block: nDCG@10 ${fmt(r.block.base)} -> ${fmt(r.block.cand)}, Δ ${signed(r.block.delta)} over ${r.block.n}`);
  out.push(`counts: scored ${r.counts.primary} primary + ${r.counts.block} constraint block · unscored ${r.counts.unscored} · parsed ${r.counts.parsed}`);

  const byId = new Map(r.scores.base.map((b, i) => [b.id, { b, c: r.scores.cand[i] }]));
  const delta = (/** @type {string} */ id) => {
    const s = byId.get(id);
    if (!s || !s.b.answerable) return '— (unscored)';
    return `${signed(s.c.ndcg - s.b.ndcg)}${s.b.featureGap ? ' (constraint block)' : ''}`;
  };
  out.push(`\nparsed by the reference (${r.detail.parsed.length}):`);
  for (const p of r.detail.parsed) {
    const ex = p.exchange ? ` · exchange sem ${p.exchange.sem ?? 'either'}` : '';
    const viol = r.compliance.violations.filter((v) => v.id === p.id);
    out.push(`  ${p.id}  ${JSON.stringify(p.text)}  ${JSON.stringify(p.constraints)}${p.semantics ? ` (prereq ${p.semantics})` : ''}${ex}  ΔnDCG@10 ${delta(p.id)}  compliance ${viol.length ? `FAIL: ${viol.map((v) => `${v.code} (${v.why})`).join(', ')}` : 'ok'}`);
  }
  const removed = Object.entries(r.detail.removed);
  out.push(`\nrelevant documents the filter removed (${removed.length} queries):${removed.length ? '' : ' none'}`);
  for (const [id, { removed: codes }] of removed) out.push(`  ${id}: ${Object.entries(codes).map(([c, why]) => `${c} (${why})`).join(', ')}`);
  out.push(`unscored once filtered (${r.detail.emptied.length}): ${r.detail.emptied.join(', ') || 'none'}`);
  out.push(`unparsed queries whose top 10 differ from the baseline (${r.identity.differing.length} of ${r.identity.queries}): ${r.identity.differing.join(', ') || 'none'}`);
  out.push(`queries the candidate newly errors on (${r.newErrors.length}): ${r.newErrors.join(', ') || 'none'}`);

  /** @type {import('./gate.mjs').Verdict | null} */
  let verdict = null;
  if (gate) {
    verdict = gateFor(o.set.gate, r.cmp, o.change ?? { kind: 'compliance' }, {
      compliance: { raw: r.raw, block: r.block, compliance: { queries: r.compliance.queries, violations: r.compliance.violations.length }, identity: { queries: r.identity.queries, differing: r.identity.differing.length }, newErrors: r.newErrors.length },
    });
    out.push(`\n${verdictBlock(verdict)}`);
    if (!vocabMatch) out.push('  note: the candidate run\'s vocabulary is not the one the reference parsed over; the dev screen does not pass with this difference');
  } else {
    out.push('\ndiagnostic: reported, no gate');
  }
  out.push(`\nper shape (${o.set.name} only, filtered)`);
  out.push(shapeTable(byShape(r.scores.base), byShape(r.scores.cand), r.cmp));
  const json = {
    set: o.set.name, rule: gate ? 'compliance' : 'diagnostic', candidate: o.cand.variant, baseline: o.base.variant, qrels: o.qrelsVersion,
    reference: o.sources.source, candidateVocabulary: recorded, vocabularyMatches: vocabMatch,
    summary: { base: summarise(r.scores.base), cand: summarise(r.scores.cand) },
    comparison: { ...r.cmp, shapes: undefined }, raw: { ...r.raw, shapes: undefined }, block: r.block, counts: r.counts,
    compliance: r.compliance, identity: r.identity, detail: r.detail, verdict,
  };
  return { text: out.join('\n'), json, result: r, verdict, vocabMatch };
}
