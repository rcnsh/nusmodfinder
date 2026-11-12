// @ts-check
// Live-call totals from the run records under ops/runs/: every request a record
// lists, by path (or wrangler command), is one call.
//
//   npm run ops:requests
import { pathToFileURL } from 'node:url';
import { RUNS_DIR, readRunRecords } from './run-record.mjs';

/**
 * @param {{ runsDir?: string }} [o]
 */
export function opsRequests({ runsDir = RUNS_DIR } = {}) {
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
  const lines = [
    `run records: ${records} with requests, ${requests} requests`,
    ...Object.entries(byScript).sort((a, b) => b[1] - a[1]).map(([s, n]) => `  ${s}: ${n}`),
    ...(Object.keys(byPath).length ? ['  by path:', ...Object.entries(byPath).sort((a, b) => b[1] - a[1]).map(([p, n]) => `    ${p}: ${n}`)] : []),
  ];
  return { runs: { records, requests, byScript, byPath }, lines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of opsRequests().lines) console.log(line);
}
