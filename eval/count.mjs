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
import { answerableCount, isTaggedNoAnswer } from './lib/metrics.mjs';
import { layout, loadQrels, loadQueries, readSetJson, runFile, setKey } from './lib/sets.mjs';

const OPTIONS = /** @type {const} */ ({
  custodian: { type: 'boolean', default: false },
  set: { type: 'string' },
  holdout: { type: 'boolean', default: false },
  'set-dir': { type: 'string' },
  answerable: { type: 'boolean', default: false },
  'emptied-untagged': { type: 'boolean', default: false },
  run: { type: 'string' },
});
const TAKES = 'eval:count takes only --custodian, --set, --holdout, --set-dir, --answerable, --emptied-untagged and --run (it prints one integer, never ids or metrics)';

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
if (a.answerable === a['emptied-untagged']) refuse('give exactly one of --answerable or --emptied-untagged');
if (a.answerable) {
  if (set.gate !== 'test') refuse('--answerable counts the test set only (--set test)');
  if (a.run) refuse('--answerable takes no --run: it counts the queries and qrels');
} else {
  if (set.gate !== 'holdout') refuse('--emptied-untagged counts the holdout only (--holdout)');
  if (!a.run) refuse('--emptied-untagged needs --run <variant>, a run stored with --store-only');
}

const kind = a.answerable ? 'answerable' : 'emptied-untagged';

/** @returns {Promise<number>} */
async function counted() {
  await setKey();
  const verify = { verify: true };
  const querySet = await loadQueries(set, verify);
  if (a.answerable) return answerableCount(querySet.queries, await loadQrels(set, verify));
  /** @type {import('./lib/metrics.mjs').RunFile} */
  const run = await readSetJson(set, runFile(set, /** @type {string} */ (a.run)), verify);
  const sha = createHash('sha256').update(JSON.stringify(querySet.queries)).digest('hex');
  if (/** @type {any} */ (run.queries)?.sha256 !== sha) throw new RunFileError(`run ${a.run} was not made on these queries`);
  let n = 0;
  querySet.queries.forEach((q, i) => {
    const r = run.results?.[q.id];
    if (!r) throw new RunFileError(`run ${a.run} has no result for query #${i + 1}`);
    if (!isTaggedNoAnswer(q) && r.status === 200 && r.codes.length === 0) n++;
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
  const cells = [new Date().toISOString().slice(0, 10), set.name, `count: ${kind}`, a.run ?? '—', String(n)];
  await appendFile(log, `| ${cells.map((c) => c.replace(/[|\n]/g, ' ')).join(' | ')} |\n`);
  console.log(String(n));
} catch (err) {
  console.error(`eval: ${set.name} count failed (${errorClass(err)}); details withheld`);
  process.exit(1);
}
