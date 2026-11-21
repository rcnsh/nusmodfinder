#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { appendCountRow, assertRoute } from './lib/count-log.mjs';
import { CorpusMismatchError, errorClass, RunFileError } from './lib/errors.mjs';
import { groupIndex, groupKeys, loadGroups } from './lib/groups.mjs';
import { answerableCount, qrelsFor, scoredSet } from './lib/metrics.mjs';
import { layout, loadQrels, loadQueries, readSetJson, runFile, setKey } from './lib/sets.mjs';

const OPTIONS = /** @type {const} */ ({
  custodian: { type: 'boolean', default: false },
  set: { type: 'string' },
  holdout: { type: 'boolean', default: false },
  'set-dir': { type: 'string' },
  answerable: { type: 'boolean', default: false },
  'emptied-untagged': { type: 'boolean', default: false },
  'lists-differing': { type: 'boolean', default: false },
  'by-group': { type: 'boolean', default: false },
  run: { type: 'string' },
  baseline: { type: 'string' },
  route: { type: 'string' },
});
const TAKES = 'eval:count takes only --custodian, --set, --holdout, --set-dir, --answerable, --emptied-untagged, --lists-differing, --by-group, --run, --baseline and --route (it prints one integer, never ids or metrics)';

/** @param {string} msg @returns {never} */
function refuse(msg) {
  console.error(`eval:count: ${msg}`);
  process.exit(1);
}

/** @type {ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>['values']} */
let a;
try {
  a = parseArgs({ options: OPTIONS, allowPositionals: false, strict: true }).values;
} catch (err) {
  refuse(`${/** @type {Error} */ (err).message}; ${TAKES}`);
}

if (!a.custodian) refuse('refusing without --custodian: only the custodian counts an encrypted set');
try {
  assertRoute(a.route);
} catch (err) {
  refuse(/** @type {Error} */ (err).message);
}
if (!a.holdout && !a.set) refuse('name the set: --set test or --holdout');
const set = (() => {
  try {
    return layout(a.holdout ? 'holdout' : /** @type {string} */ (a.set), a['set-dir'] ? resolve(a['set-dir']) : undefined);
  } catch (err) {
    return refuse(/** @type {Error} */ (err).message);
  }
})();
if (!set.encrypted || !set.countLog) refuse(`the ${set.name} set is open: read its report; eval:count is for the encrypted sets`);
if ([a.answerable, a['emptied-untagged'], a['lists-differing']].filter(Boolean).length !== 1) {
  refuse('give exactly one of --answerable, --emptied-untagged or --lists-differing');
}
if (a.baseline && !a['lists-differing']) refuse('--baseline is for --lists-differing only');
if (a['by-group'] && !a['lists-differing']) refuse('--by-group is for --lists-differing only');
if (a.answerable) {
  if (set.gate !== 'test') refuse('--answerable counts the test set only (--set test)');
  if (a.run) refuse('--answerable takes no --run: it counts the queries and qrels');
} else if (a['emptied-untagged']) {
  if (set.gate !== 'holdout') refuse('--emptied-untagged counts the holdout only (--holdout)');
  if (!a.run) refuse('--emptied-untagged needs --run <variant>, a run stored with --store-only');
} else {
  if (set.gate !== 'holdout') refuse('--lists-differing counts the holdout only (--holdout)');
  if (!a.run || !a.baseline) refuse('--lists-differing needs --run <variant> and --baseline <variant>, both stored with --store-only');
}

const kind = a.answerable ? 'answerable' : a['emptied-untagged'] ? 'emptied-untagged' : a['by-group'] ? 'lists-differing-by-group' : 'lists-differing';

/** @returns {Promise<number>} */
async function counted() {
  await setKey();
  const verify = { verify: true };
  const querySet = await loadQueries(set, verify);
  if (a.answerable) return answerableCount(querySet.queries, await loadQrels(set, verify));
  const sha = createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex');
  /** @param {string} variant @returns {Promise<import('./lib/metrics.mjs').RunFile>} */
  const stored = async (variant) => {
    /** @type {import('./lib/metrics.mjs').RunFile} */
    const r = await readSetJson(set, runFile(set, variant), verify);
    if (/** @type {any} */ (r.queries)?.sha256 !== sha) throw new RunFileError(`run ${variant} was not made on these queries`);
    return r;
  };
  const run = await stored(/** @type {string} */ (a.run));
  if (a['lists-differing']) {
    const base = await stored(/** @type {string} */ (a.baseline));
    if (JSON.stringify(run.config) !== JSON.stringify(base.config)) throw new RunFileError('the two runs were made with different settings');
    if (JSON.stringify(/** @type {any} */ (run.corpus)?.moduleInfoSha256) !== JSON.stringify(/** @type {any} */ (base.corpus)?.moduleInfoSha256)) {
      throw new RunFileError('the two runs were made on different corpora');
    }
    /** @type {(codes: string[]) => unknown} */
    let seq = (codes) => codes;
    if (a['by-group']) {
      const groups = await loadGroups();
      if (groups.corpus.moduleInfoSha256 !== /** @type {any} */ (run.corpus)?.moduleInfoSha256) throw new CorpusMismatchError('eval/groups.json was built from another corpus than the runs');
      const index = groupIndex(groups.groups);
      seq = (codes) => groupKeys(codes, index);
    }
    const list = (/** @type {any} */ x) => JSON.stringify([x.status, seq(x.codes)]);
    let n = 0;
    querySet.queries.forEach((q, i) => {
      const x = run.results?.[q.id];
      const y = base.results?.[q.id];
      if (!x || !y) throw new RunFileError(`a run has no result for query #${i + 1}`);
      if (list(x) !== list(y)) n++;
    });
    return n;
  }
  const qrels = await loadQrels(set, verify);
  let n = 0;
  querySet.queries.forEach((q, i) => {
    const r = run.results?.[q.id];
    if (!r) throw new RunFileError(`run ${a.run} has no result for query #${i + 1}`);
    if (!scoredSet(q, qrelsFor(qrels, q.id, i).grades).noAnswer && r.status === 200 && r.codes.length === 0) n++;
  });
  return n;
}

try {
  const n = await counted();
  const runCell = a['lists-differing'] ? `${a.run} vs ${a.baseline}` : a.run ?? '—';
  await appendCountRow(/** @type {string} */ (set.countLog), { set: set.name, kind: `count: ${kind}`, run: runCell, count: String(n), route: a.route });
  console.log(String(n));
} catch (err) {
  console.error(`eval: ${set.name} count failed (${errorClass(err)}); details withheld`);
  process.exit(1);
}
