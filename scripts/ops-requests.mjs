// @ts-check
// Live-call totals (Phase 7 7C): docs/evidence/requests.tsv, typed by hand for
// rows 1-131 and the back-fill, and the run records under
// docs/evidence/ops/runs/.
//
//   npm run ops:requests
//
// In requests.tsv a `curl`, `fetch` or `browser …` row is one call. A `ref`
// row describes a batch in prose, so only the first count it states ("99
// requests", "4 Cloudflare API calls") is summed. Rows that state no count are
// listed, and so are rows that state one but describe more calls besides (a
// "1 /health before the deploy", "plus 7 re-sends"): the TSV total is a lower
// bound. A `correction` row is a note, not a call. In a run record every
// request it lists by path (or wrangler command) is a call.
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RUNS_DIR, readRunRecords } from './run-record.mjs';

export const TSV_PATH = fileURLToPath(new URL('../docs/evidence/requests.tsv', import.meta.url));
/**
 * "99 requests", "30 exchange /search calls", "4 Cloudflare API calls": a number, up to three
 * words with no digit (so "6,771 texts in 68 requests" is 68), then the noun.
 */
const STATED = /(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)\s+(?:[^\s\d,;()]+\s+){0,3}?(?:requests?|calls?)\b/;

/**
 * Phrases that mean a row describes calls beyond the count it states: a `/health` before the
 * deploy, "plus …", re-sends, a determinism check. A breakdown of the count ("43 requests:
 * /facets, 8 /module …") is not more.
 */
const MORE = /\/health before|\bplus\b|\bre-sends?\b|\bdeterminism check\b/i;

/** The calls a ref row's text states, or null when it states none. @param {string} text */
export function statedCalls(text) {
  const m = STATED.exec(text);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/** Whether a text that states a count also describes calls outside it. @param {string} text */
export function describesMore(text) {
  const m = STATED.exec(text);
  if (!m) return false;
  return MORE.test(text.slice(0, m.index)) || MORE.test(text.slice(m.index + m[0].length));
}

/**
 * @param {string} tsv
 * @returns {{ rows: number, oneCallRows: number, refRows: number, corrections: number, statedCalls: number,
 *   refRowsWithoutCount: number[], refRowsPartlyCounted: number[] }}
 */
export function tsvTotals(tsv) {
  const rows = tsv.trimEnd().split('\n').slice(1).filter(Boolean).map((l) => l.split('\t'));
  const out = {
    rows: rows.length, oneCallRows: 0, refRows: 0, corrections: 0, statedCalls: 0,
    refRowsWithoutCount: /** @type {number[]} */ ([]), refRowsPartlyCounted: /** @type {number[]} */ ([]),
  };
  for (const [n, kind, what = '', note = ''] of rows) {
    if (kind === 'correction') { out.corrections++; continue; }
    if (kind === 'ref') {
      out.refRows++;
      const fromWhat = statedCalls(what);
      const calls = fromWhat ?? statedCalls(note);
      if (calls === null) out.refRowsWithoutCount.push(Number(n));
      else {
        out.statedCalls += calls;
        if (describesMore(fromWhat === null ? note : what)) out.refRowsPartlyCounted.push(Number(n));
      }
      continue;
    }
    out.oneCallRows++;
    out.statedCalls++;
  }
  return out;
}

/**
 * @param {{ tsvPath?: string, runsDir?: string }} [o]
 */
export function opsRequests({ tsvPath = TSV_PATH, runsDir = RUNS_DIR } = {}) {
  const tsv = tsvTotals(readFileSync(tsvPath, 'utf8'));
  /** @type {Record<string, number>} */
  const byScript = {};
  /** @type {Record<string, number>} */
  const byPath = {};
  let requests = 0;
  let records = 0;
  for (const { record } of readRunRecords(runsDir)) {
    if (!record?.requests) continue;
    records++;
    for (const [path, n] of Object.entries(/** @type {Record<string, number>} */ (record.requests))) {
      requests += n;
      byPath[path] = (byPath[path] ?? 0) + n;
      byScript[record.script] = (byScript[record.script] ?? 0) + n;
    }
  }
  const total = tsv.statedCalls + requests;
  const lines = [
    `requests.tsv: ${tsv.rows} rows; ${tsv.oneCallRows} one-call rows (curl, fetch, browser); ${tsv.refRows} ref rows; ${tsv.corrections} corrections`,
    `  ${tsv.statedCalls} calls stated, a lower bound: ${tsv.refRowsWithoutCount.length} ref rows state no count (rows ${tsv.refRowsWithoutCount.join(', ') || 'none'})`,
    `  and ${tsv.refRowsPartlyCounted.length} state a count but describe more calls besides (rows ${tsv.refRowsPartlyCounted.join(', ') || 'none'})`,
    `run records: ${records} with requests, ${requests} requests`,
    ...Object.entries(byScript).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`),
    ...(Object.keys(byPath).length ? ['  by path:', ...Object.entries(byPath).sort((a, b) => b[1] - a[1]).map(([p, n]) => `    ${p}: ${n}`)] : []),
    `total: ${total} live calls stated (requests.tsv ${tsv.statedCalls} + run records ${requests})`,
  ];
  return { tsv, runs: { records, requests, byScript, byPath }, total, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of opsRequests().lines) console.log(line);
}
