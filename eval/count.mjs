#!/usr/bin/env node
// @ts-check
// `npm run eval:count`: custodian-only counts on an encrypted set
// (docs/plans/phase3.md §3 P-5b, A3-1, A-N9). It prints one integer and
// nothing else:
//
//   npm run eval:count -- --custodian --set test --answerable
//       the sealed test set's primary answerable queries (§5's stopping rule)
//   npm run eval:count -- --custodian --holdout --emptied-untagged --run <variant>
//       holdout queries not tagged no-answer that the stored run returns
//       empty (status 200, no codes): 3G's custodian count
//   npm run eval:count -- --custodian --holdout --lists-differing --run <A> --baseline <B>
//       holdout queries whose stored lists differ between runs A and B (status,
//       or the codes in order); both made on these queries with the same
//       settings: the identity check that moves the shipped-ranker pin without
//       a look (docs/plans/phase5.md §3 5A)
//
// Every call appends a row (date, set, kind, run, count) to the set's count
// log (eval/count-log.md; the self-test set's beside its own ledger). The
// ledger never reads the count log and refuses a row copied from it, so a
// count prints no verdict and is not a look (ADR 0003, amendment 2026-11-06).
// Any option outside the ones above is refused, so no flag can make it print
// ids or metrics; any failure after the checks prints only the error class.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { errorClass, RunFileError } from './lib/errors.mjs';
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
  run: { type: 'string' },
  baseline: { type: 'string' },
});
const TAKES = 'eval:count takes only --custodian, --set, --holdout, --set-dir, --answerable, --emptied-untagged, --lists-differing, --run and --baseline (it prints one integer, never ids or metrics)';

const LOG_HEADER = `# Count log

Append-only. One row per \`npm run eval:count\` call, which only the custodian runs. A count
prints one integer and no verdict, so it is not a look (ADR 0003, amendment 2026-11-06). The
holdout ledger never reads this file and refuses a row copied from it.

| date | set | kind | run | count |
|---|---|---|---|---|
`;

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

const kind = a.answerable ? 'answerable' : a['emptied-untagged'] ? 'emptied-untagged' : 'lists-differing';

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
    // Lists compare only under the same settings: a filtered run against an
    // unfiltered one, or hybrid against lexical, would count the settings.
    if (JSON.stringify(run.config) !== JSON.stringify(base.config)) throw new RunFileError('the two runs were made with different settings');
    if (JSON.stringify(/** @type {any} */ (run.corpus)?.moduleInfoSha256) !== JSON.stringify(/** @type {any} */ (base.corpus)?.moduleInfoSha256)) {
      throw new RunFileError('the two runs were made on different corpora');
    }
    const list = (/** @type {any} */ x) => JSON.stringify([x.status, x.codes]);
    let n = 0;
    querySet.queries.forEach((q, i) => {
      const x = run.results?.[q.id];
      const y = base.results?.[q.id];
      if (!x || !y) throw new RunFileError(`a run has no result for query #${i + 1}`);
      if (list(x) !== list(y)) n++;
    });
    return n;
  }
  // Every query outside the no-answer set counts: a tagged query with a grade-≥1 document is
  // answerable, so emptying it is a loss too (ADR 0003, 2026-11-06).
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
  const log = /** @type {string} */ (set.countLog);
  if (!existsSync(log)) {
    await mkdir(dirname(log), { recursive: true });
    await writeFile(log, LOG_HEADER);
  }
  const runCell = a['lists-differing'] ? `${a.run} vs ${a.baseline}` : a.run ?? '—';
  const cells = [new Date().toISOString().slice(0, 10), set.name, `count: ${kind}`, runCell, String(n)];
  await appendFile(log, `| ${cells.map((c) => c.replace(/[|\n]/g, ' ')).join(' | ')} |\n`);
  console.log(String(n));
} catch (err) {
  console.error(`eval: ${set.name} count failed (${errorClass(err)}); details withheld`);
  process.exit(1);
}
