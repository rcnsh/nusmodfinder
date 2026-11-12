// @ts-check
// The count log (eval/count-log.md; the self-test set's beside its own ledger): one row per
// `eval:count` call, and per passing `eval:representatives --route` call. Its `route` column
// names the ADR 0003 no-look route a count was taken for, which
// `eval:lock -- --evidence no-look <row>` cites. A row without the column reads as route ''.
import { existsSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ledgerRows } from './ledger.mjs';

/** ADR 0003's no-look routes; test/eval/lock.node.test.js ties them to the ADR. */
export const NO_LOOK_ROUTES = Object.freeze(['representative-only', 'answerable-floor', 'group-first', 'gated-without-a-look']);

/** The route cell of a row written without a route. */
export const NO_ROUTE = '—';

export const COUNT_LOG_HEADER = `# Count log

Append-only. One row per \`npm run eval:count\` call, which only the custodian runs, and per passing
\`npm run eval:representatives -- --route\` call. A count prints one integer and no verdict, so it is
not a look (ADR 0003). The holdout ledger never reads this file and refuses a row copied from it.
\`route\` names the no-look route the row was taken for (ADR 0003); a ranking-lock change can cite such a row once (\`eval:lock -- --evidence no-look <row>\`).

| date | set | kind | run | count | route |
|---|---|---|---|---|---|
`;

const COLUMNS = ['date', 'set', 'kind', 'run', 'count', 'route'];

/**
 * @typedef {{ date: string, set: string, kind: string, run: string, count: string, route: string }} CountLogRow
 */

/**
 * The log's rows, keyed by the header's column names (a log from before the route column has
 * route ''). Row n of `eval:lock -- --evidence no-look <n>` is the nth element, 1-based.
 * @param {string} text
 * @returns {CountLogRow[]}
 */
export function countLogRows(text) {
  const header = text.split('\n').map((l) => l.trim()).find((l) => l.startsWith('|'));
  const names = header ? header.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()) : COLUMNS;
  return ledgerRows(text).map((cells) => {
    /** @type {Record<string, string>} */
    const row = Object.fromEntries(COLUMNS.map((c) => [c, '']));
    names.forEach((name, i) => { if (COLUMNS.includes(name)) row[name] = cells[i] ?? ''; });
    return /** @type {CountLogRow} */ (row);
  });
}

/**
 * Throws unless `route` is undefined or one of NO_LOOK_ROUTES.
 * @param {string | undefined} route
 */
export function assertRoute(route) {
  if (route !== undefined && !NO_LOOK_ROUTES.includes(route)) {
    throw new Error(`--route must be one of ADR 0003's no-look routes (${NO_LOOK_ROUTES.join(', ')}), got ${JSON.stringify(route)}`);
  }
}

/**
 * Appends one row, creating the log with its header if it is missing.
 * @param {string} path
 * @param {Omit<CountLogRow, 'date' | 'route'> & { route?: string }} row
 */
export async function appendCountRow(path, row) {
  if (!existsSync(path)) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, COUNT_LOG_HEADER);
  }
  const cells = [new Date().toISOString().slice(0, 10), row.set, row.kind, row.run, row.count, row.route ?? NO_ROUTE];
  await appendFile(path, `| ${cells.map((c) => c.replace(/[|\n]/g, ' ')).join(' | ')} |\n`);
}
