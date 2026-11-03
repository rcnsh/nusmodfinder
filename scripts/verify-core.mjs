// @ts-check
// Do D1 and Vectorize agree? The comparison behind `npm run verify`, with the
// admin API and the vector id listing injected (no Node APIs), so Worker tests
// run it against the real /admin/verify route and the fake index.
//
// Drift (docs/plans/phase1.md "Ingest (changes vs r1)"):
// - missing vectors: D1 codes with no vector id (from `wrangler vectorize
//   list-vectors`, ids only);
// - extra vectors: vector ids with no D1 row;
// - metadata drift: for a sample of at most 100 codes, Vectorize metadata
//   (getByIds) differs from what the D1 row implies;
// - row_hash drift: a stored row_hash differs from one recomputed from the
//   stored columns, or is missing.

/**
 * @typedef {{
 *   ok: boolean, d1Rows: number, vectors: number,
 *   missingVectors: string[], extraVectors: string[],
 *   rowHashDrift: { code: string, stored: string, recomputed: string }[], rowHashMissing: string[],
 *   sampleChecked: number, sampleMissingVectors: string[],
 *   metadataDrift: { code: string, expected: unknown, actual: unknown }[],
 *   rowsRead: number,
 * }} VerifyReport
 */

/**
 * @param {{
 *   api: import('./ingest-core.mjs').AdminApi,
 *   listVectorIds: () => Promise<string[]>,
 *   sampleSize?: number, sample?: string[],
 * }} args
 * @returns {Promise<VerifyReport>}
 */
export async function runVerify({ api, listVectorIds, sampleSize = 100, sample }) {
  const res = await api.post('/admin/verify', sample ? { sample } : { sampleSize });
  if (res.status !== 200) {
    throw new Error(`POST /admin/verify -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  const d1 = res.body;
  const ids = new Set(await listVectorIds());
  const codes = new Set(/** @type {string[]} */ (d1.codes));
  const missingVectors = [...codes].filter((c) => !ids.has(c)).sort();
  const extraVectors = [...ids].filter((c) => !codes.has(c)).sort();
  /** @type {VerifyReport} */
  const report = {
    ok: false, d1Rows: codes.size, vectors: ids.size, missingVectors, extraVectors,
    rowHashDrift: d1.rowHash.drift, rowHashMissing: d1.rowHash.missing,
    sampleChecked: d1.sample.checked, sampleMissingVectors: d1.sample.missingVectors, metadataDrift: d1.sample.metadataDrift,
    rowsRead: Number(d1.meta?.rows_read ?? 0),
  };
  report.ok = [missingVectors, extraVectors, report.rowHashDrift, report.rowHashMissing, report.sampleMissingVectors, report.metadataDrift]
    .every((list) => list.length === 0);
  return report;
}

/**
 * Human-readable lines for a report.
 * @param {VerifyReport} r
 */
export function formatReport(r) {
  /** @param {string} label @param {unknown[]} list @param {(x: any) => string} [show] */
  const line = (label, list, show = String) =>
    `${label.padEnd(20)}${list.length}${list.length ? `  ${list.slice(0, 10).map(show).join(', ')}${list.length > 10 ? ', …' : ''}` : ''}`;
  return [
    `D1 rows            ${r.d1Rows}`,
    `vectors            ${r.vectors}`,
    line('missing vectors', r.missingVectors),
    line('extra vectors', r.extraVectors),
    line('row_hash drift', r.rowHashDrift, (d) => d.code),
    line('row_hash missing', r.rowHashMissing),
    `metadata sample    ${r.sampleChecked}`,
    line('metadata drift', r.metadataDrift, (d) => d.code),
    line('sample w/o vector', r.sampleMissingVectors),
    `D1 rows read       ${r.rowsRead}`,
    r.ok ? 'OK: D1 and Vectorize agree' : 'DRIFT: D1 and Vectorize disagree (rerun ingest; see README "Re-ingesting")',
  ];
}
