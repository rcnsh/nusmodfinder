// The Phase 2 baseline's tables for EVAL.md: dev set, the committed qrels (eval/dev/qrels.json,
// whichever version it holds; the first line printed names it), duplicate groups applied,
// no-answer = tagged and no grade-≥1 document (ADR 0003, amendment 2026-11-06).
// Absolute 95% CIs are BCa and persona-cluster bootstraps over the primary answerable queries
// (EVAL.md states how many on the current qrels); Δ CIs are the harness's paired compare().
// Seeds and resample counts are the harness defaults, so the output is deterministic. A new qrels
// version changes the output: re-derive EVAL.md's tables (test/docs-facts.node.test.js fails
// until its qrels label matches).
//
//   node docs/evidence/phase2/baseline-table.mjs     (needs eval/runs/v0{,-lexical,-vector}.json,
//   from EVAL.md's "Reproduce" commands)
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGroups, withCorpusGroups } from '../../../eval/lib/groups.mjs';
import { METRICS, assertSameCorpus, compare, scoreRun } from '../../../eval/lib/metrics.mjs';
import { bcaInterval, clusteredInterval } from '../../../eval/lib/stats.mjs';
import { REPO, layout, loadQueries } from '../../../eval/lib/sets.mjs';

const set = layout('dev');
const { queries, version } = await loadQueries(set);
const qrels = JSON.parse(await readFile(join(set.dir, 'qrels.json'), 'utf8'));
const groups = await loadGroups();
const scored = withCorpusGroups(qrels, groups);
const names = ['v0', 'v0-lexical', 'v0-vector'];
const runs = await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(REPO, 'eval/runs', `${n}.json`), 'utf8'))));
assertSameCorpus(qrels, runs);
const wantMode = { v0: 'hybrid', 'v0-lexical': 'lexical', 'v0-vector': 'vector' };
runs.forEach((r, i) => {
  const mode = r.config?.mode ?? 'hybrid';
  if (r.variant !== names[i] || mode !== wantMode[names[i]] || r.ranker?.ref !== 'eval-v0') {
    throw new Error(`eval/runs/${names[i]}.json is variant ${r.variant}, mode ${mode}, ref ${r.ranker?.ref}; expected ${names[i]}, ${wantMode[names[i]]}, eval-v0`);
  }
});
const scores = Object.fromEntries(runs.map((r, i) => [names[i], scoreRun(r, queries, scored)]));

const f = (x) => x.toFixed(3);
const label = { ndcg: 'nDCG@10', p5: 'P@5', rr: 'MRR@10' };
console.log(`dev · queries ${version} · ${qrels.version} · ${groups.version}`);
console.log('\n| run | metric | mean | BCa 95% CI | persona-cluster 95% CI |\n|---|---|---|---|---|');
for (const n of names) {
  const primary = scores[n].filter((s) => s.answerable && !s.featureGap);
  for (const m of METRICS) {
    const xs = primary.map((s) => s[m]);
    const b = bcaInterval(xs);
    const c = clusteredInterval(xs, primary.map((s) => s.persona));
    console.log(`| ${n} | ${label[m]} | ${f(b.estimate)} | [${f(b.lower)}, ${f(b.upper)}] | [${f(c.lower)}, ${f(c.upper)}] |`);
  }
}

console.log('\n| Δ | metric | Δ | BCa 95% CI | sign-flip p | persona-cluster 95% CI |\n|---|---|---|---|---|---|');
for (const base of ['v0-lexical', 'v0-vector']) {
  const cmp = compare(scores[base], scores.v0);
  for (const m of METRICS) {
    const x = cmp.overall[m];
    console.log(`| v0 − ${base} | ${label[m]} | ${x.delta >= 0 ? '+' : ''}${f(x.delta)} | [${f(x.bca.lower)}, ${f(x.bca.upper)}] | ${x.signFlip.p.toFixed(4)} | [${f(x.cluster.lower)}, ${f(x.cluster.upper)}] |`);
  }
}
