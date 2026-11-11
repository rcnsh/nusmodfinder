// @ts-check
// The semester representative's gate on the open sets (ADR 0003, draft
// amendment "representative-only changes are gated without a look"): between
// a baseline run and a candidate made with the same settings on the same
// queries and corpus, every list has the same status and the same sequence of
// group keys (groups-v1), and every position whose code differs shows, in the
// candidate, a member offered in the semester the request named where the
// baseline's member was not.
import { groupKeys } from './groups.mjs';
import { searchParams } from './sets.mjs';

/**
 * @typedef {import('./metrics.mjs').RunFile} RunFile
 * @typedef {import('./metrics.mjs').EvalQuery} EvalQuery
 * @typedef {{ lists: number, changedLists: number, changedCodes: number, problems: string[] }} RepresentativeReport
 */

/**
 * The semester the eval's request for `q` named under `config` (the runner's
 * own params), or undefined.
 * @param {EvalQuery} q @param {any} config
 */
export function requestSemester(q, config) {
  const params = searchParams(q, { unfiltered: config?.filters === false, strip: config?.strip ?? [], mode: config?.mode ?? 'hybrid' });
  return params.sem === undefined ? undefined : Number(params.sem);
}

/**
 * @param {{
 *   queries: EvalQuery[], run: RunFile, baseline: RunFile,
 *   groupOf: Map<string, string>, semestersOf: Map<string, number[]>,
 * }} o
 * @returns {RepresentativeReport}
 */
export function compareRepresentatives({ queries, run, baseline, groupOf, semestersOf }) {
  /** @type {string[]} */
  const problems = [];
  if (JSON.stringify(run.config) !== JSON.stringify(baseline.config)) problems.push('the two runs were made with different settings (config)');
  if (/** @type {any} */ (run.queries)?.sha256 !== /** @type {any} */ (baseline.queries)?.sha256) problems.push('the two runs were made on different queries');
  if (/** @type {any} */ (run.corpus)?.moduleInfoSha256 !== /** @type {any} */ (baseline.corpus)?.moduleInfoSha256) problems.push('the two runs were made on different corpora');
  const offered = (/** @type {string} */ c, /** @type {number} */ sem) => (semestersOf.get(c) ?? []).includes(sem);
  let changedLists = 0, changedCodes = 0;
  for (const q of queries) {
    const x = run.results?.[q.id];
    const y = baseline.results?.[q.id];
    if (!x || !y) { problems.push(`${q.id}: a run has no result`); continue; }
    if (x.status !== y.status) { problems.push(`${q.id}: status ${y.status} -> ${x.status}`); continue; }
    const a = x.codes ?? [], b = y.codes ?? [];
    if (JSON.stringify(groupKeys(a, groupOf)) !== JSON.stringify(groupKeys(b, groupOf))) {
      problems.push(`${q.id}: the group sequence differs (${b.slice(0, 5).join(',')}… -> ${a.slice(0, 5).join(',')}…)`);
      continue;
    }
    const sem = requestSemester(q, run.config);
    let changed = 0;
    a.forEach((code, i) => {
      if (code === b[i]) return;
      changed++;
      if (sem === undefined) problems.push(`${q.id} #${i + 1}: ${b[i]} -> ${code} with no semester named`);
      else if (offered(b[i], sem)) problems.push(`${q.id} #${i + 1}: ${b[i]} -> ${code}, but ${b[i]} is offered in semester ${sem}`);
      else if (!offered(code, sem)) problems.push(`${q.id} #${i + 1}: ${b[i]} -> ${code}, which is not offered in semester ${sem}`);
    });
    if (changed) { changedLists++; changedCodes += changed; }
  }
  return { lists: queries.length, changedLists, changedCodes, problems };
}
