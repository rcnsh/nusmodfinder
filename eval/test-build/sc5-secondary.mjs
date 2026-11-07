#!/usr/bin/env node
// @ts-check
// SC5's secondary report (ADR 0003 "Test set, pre-registered now"): the same
// comparison, final vs eval-v0, on the unfiltered test set, that is, the SC5
// set plus the queries the leak filter dropped. The dropped queries live in a
// second encrypted directory, eval/sealed-unfiltered (set name `test`), with
// their own stored runs and judged qrels. Reported, never a verdict: it writes
// no ledger row. Prints the overall Δ lines only.
//
//   node eval/test-build/sc5-secondary.mjs eval/sealed-unfiltered
import { loadGroups, withCorpusGroups } from '../lib/groups.mjs';
import { compare, scoreRun } from '../lib/metrics.mjs';
import { layout, loadQrels, loadQueries, readSetJson, runFile } from '../lib/sets.mjs';

const dir = process.argv[2];
if (!dir) throw new Error('usage: sc5-secondary.mjs <dropped set dir>');
const groups = await loadGroups();
/** @param {import('../lib/sets.mjs').SetLayout} set */
async function scores(set) {
  const { queries } = await loadQueries(set);
  const qrels = withCorpusGroups(await loadQrels(set), groups);
  const run = async (/** @type {string} */ v) => scoreRun(await readSetJson(set, runFile(set, v)), queries, qrels);
  return { base: await run('v0'), cand: await run('final') };
}
const filtered = await scores(layout('test'));
const dropped = await scores(layout('test', dir));
const fmt = (/** @type {number} */ x) => (x >= 0 ? '+' : '') + x.toFixed(3);
/** @type {[string, import('../lib/metrics.mjs').QueryScore[], import('../lib/metrics.mjs').QueryScore[]][]} */
const reports = [
  ['filtered (the SC5 set)', filtered.base, filtered.cand],
  ['dropped by the leak filter', dropped.base, dropped.cand],
  ['unfiltered (both)', [...filtered.base, ...dropped.base], [...filtered.cand, ...dropped.cand]],
];
for (const [name, base, cand] of reports) {
  const c = compare(base, cand);
  const line = (/** @type {"ndcg" | "p5"} */ m) => `${fmt(c.overall[m].delta)} [${c.overall[m].bca.lower.toFixed(3)}, ${c.overall[m].bca.upper.toFixed(3)}]`;
  console.log(`${name}: n ${c.n} primary answerable · ΔnDCG@10 ${line('ndcg')} · ΔP@5 ${line('p5')} (BCa 95%)`);
}
