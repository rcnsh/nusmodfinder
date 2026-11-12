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
//   stored columns, or is missing;
// - value drift (with a bundle, after runbook step 8): a sampled vector's
//   values differ from the bundle's bits.
//
// runPreDeployVerify is runbook step 5 (`npm run verify -- --pre-deploy`,
// Phase 3 3-0, B2-1): D1 against the manifest and the bundle, before the
// deploy, with no Vectorize read at all.
import { catalogueKey, dataVersion } from '../src/rowhash.js';
import { base64ToFloat32, decodeFilterRow, rowsKey } from '../src/vector-bundle.js';

/**
 * @typedef {{
 *   ok: boolean, d1Rows: number, vectors: number,
 *   missingVectors: string[], extraVectors: string[],
 *   rowHashDrift: { code: string, stored: string, recomputed: string }[], rowHashMissing: string[],
 *   sampleChecked: number, sampleMissingVectors: string[],
 *   metadataDrift: { code: string, expected: unknown, actual: unknown }[],
 *   valueDrift: string[], valuesChecked: number,
 *   rowsRead: number,
 * }} VerifyReport `valueDrift`/`valuesChecked`: only with a bundle.
 */

/**
 * @param {{
 *   api: import('./ingest-core.mjs').AdminApi,
 *   listVectorIds: () => Promise<string[]>,
 *   sampleSize?: number, sample?: string[], bundle?: import('../src/vector-bundle.js').Bundle,
 * }} args `bundle`: also compare the sampled vectors' values with its bits.
 * @returns {Promise<VerifyReport>}
 */
export async function runVerify({ api, listVectorIds, sampleSize = 100, sample, bundle }) {
  const res = await api.post('/admin/verify', { ...(sample ? { sample } : { sampleSize }), ...(bundle ? { returnValues: true } : {}) });
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
    valueDrift: [], valuesChecked: 0,
    rowsRead: Number(d1.meta?.rows_read ?? 0),
  };
  if (bundle) {
    const row = new Map(bundle.codes.map((c, i) => [c, i]));
    for (const [code, b64] of Object.entries(/** @type {Record<string, string>} */ (d1.sample.values ?? {}))) {
      report.valuesChecked++;
      const i = row.get(code);
      const got = base64ToFloat32(b64);
      const want = i === undefined ? null : bundle.vectors.subarray(i * bundle.dims, (i + 1) * bundle.dims);
      if (!want || got.length !== want.length || got.some((x, k) => x !== want[k])) report.valueDrift.push(code);
    }
  }
  report.ok = [missingVectors, extraVectors, report.rowHashDrift, report.rowHashMissing, report.sampleMissingVectors, report.metadataDrift, report.valueDrift]
    .every((list) => list.length === 0);
  return report;
}

/**
 * @typedef {{
 *   ok: boolean, d1Rows: number, bundleRows: number,
 *   rowsKey: { d1: string, manifest: string, bundle: string },
 *   dataVersion: { d1: string | null, committed: string, manifest: string, bundle: string },
 *   catalogueKey: { d1: string | null, file: string },
 *   missingInBundle: string[], extraInBundle: string[],
 *   fieldDrift: { code: string, d1: unknown, bundle: unknown }[],
 *   rowHashDrift: { code: string, stored: string, recomputed: string }[], rowHashMissing: string[],
 *   unknownReasons: { code: string, id: string }[], rowsRead: number,
 *   acadYear: { d1: string | null, ngReasons: string, ngUnscheduled: string },
 *   unscheduled: { missing: string[], withRow: string[], notNg: string[] },
 * }} PreDeployReport
 *   `unknownReasons`: stored ng_rules ids the Worker's reason texts (data/ng-reasons.json) lack (Phase 4, B3-5).
 *   `acadYear` (6A): D1's `acad_year` (null when its rows hold more than one, or none) and the
 *   year of each file this deploy ships that names one.
 *   `unscheduled` (6A): against data/ng-unscheduled.json, the NG codes with no D1 row that it
 *   lacks (`missing`), and its codes that have a row (`withRow`) or are off the NG list (`notNg`).
 * @typedef {{ ngReasonsAcadYear: string, unscheduled: { acadYear: string, codes: string[] }, ngCodes: string[] }} PreDeployDataFiles
 *   The year files this deploy ships and the codes on the NG list for D1's year.
 */

/**
 * Runbook step 5: D1's (code, text_hash) pairs equal the manifest's rowsKey,
 * D1's data version (from its row_hashes) equals the committed one, and the
 * bundle's codes and filter table equal D1's fields, and each row's exam
 * dates (5A) name exactly the bundle's exam semesters. 6A: data/ng-reasons.json's and
 * data/ng-unscheduled.json's acadYear equal D1's acad_year, and the latter's
 * codes are exactly the NG codes without a D1 row. Reads D1 once through
 * /admin/verify `{ preDeploy: true }`, which makes no Vectorize call. Phase 7 7D: D1's
 * catalogueKey (its catalogue_only codes) equals the bundled catalogue file's.
 * @param {{
 *   api: import('./ingest-core.mjs').AdminApi, bundle: import('../src/vector-bundle.js').Bundle,
 *   manifest: { rowsKey: string, dataVersion: string }, committedDataVersion: string,
 *   knownReason: (id: string) => boolean, dataFiles: PreDeployDataFiles,
 *   catalogue: import('./catalogue-check.mjs').BundledCatalogue,
 * }} args `knownReason`: whether the reason texts this deploy ships know a rule id; `catalogue`: the bundled catalogue file
 * @returns {Promise<PreDeployReport>}
 */
export async function runPreDeployVerify({ api, bundle, manifest, committedDataVersion, knownReason, dataFiles, catalogue }) {
  const res = await api.post('/admin/verify', { preDeploy: true });
  if (res.status !== 200 || !Array.isArray(res.body?.rows)) {
    throw new Error(`POST /admin/verify (preDeploy) -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  /** @type {{ code: string, textHash: string, rowHash: string | null, semesters: number[], level: number | null,
   *   credits: number | null, faculty: string | null, ng: boolean, ngSemesters: number[], examSemesters: number[],
   *   su: boolean, suGrading: boolean, workloadHours: number | null, prereqNone: boolean, prereqCohortOnly: boolean,
   *   ngAllow: number, ngRules: Record<string, string[]> | null,
   *   examDates?: import('../src/rowhash.js').ExamDate[], acadYear?: string }[]} */
  const rows = res.body.rows;
  const d1Key = await rowsKey(rows);
  const d1Version = rows.every((r) => typeof r.rowHash === 'string')
    ? await dataVersion(rows.map((r) => ({ code: r.code, rowHash: /** @type {string} */ (r.rowHash) })))
    : null;
  const index = new Map(bundle.codes.map((c, i) => [c, i]));
  const held = new Set(rows.map((r) => r.code));
  /** @type {PreDeployReport['fieldDrift']} */
  const fieldDrift = [];
  for (const r of rows) {
    const i = index.get(r.code);
    if (i === undefined) continue;
    // Every filter field, 3H's and Phase 4's included, in decodeFilterRow's order.
    const d1 = {
      semesters: r.semesters, level: r.level, credits: r.credits, faculty: r.faculty, ng: r.ng, ngSemesters: r.ngSemesters,
      ngAllow: r.ngAllow, examSemesters: r.examSemesters, su: r.su, suGrading: r.suGrading, workloadHours: r.workloadHours,
      prereqNone: r.prereqNone, prereqCohortOnly: r.prereqCohortOnly,
    };
    const b = decodeFilterRow(bundle, i);
    if (JSON.stringify(d1) !== JSON.stringify(b)) { fieldDrift.push({ code: r.code, d1, bundle: b }); continue; }
    // 5A: exam_dates is not in the bundle, but its semesters must be the
    // bundle's exam semesters. A Worker too old to answer examDates has none.
    const examDates = r.examDates ?? [];
    if (JSON.stringify(examDates.map((d) => d.sem)) !== JSON.stringify(b.examSemesters)) {
      fieldDrift.push({ code: r.code, d1: { examDates }, bundle: { examSemesters: b.examSemesters } });
    }
  }
  /** @type {PreDeployReport['unknownReasons']} */
  const unknownReasons = [];
  for (const r of rows) {
    for (const id of new Set(Object.values(r.ngRules ?? {}).flat())) if (!knownReason(id)) unknownReasons.push({ code: r.code, id });
  }
  // 6A: one year in D1, and every file that names a year names it.
  const years = new Set(rows.map((r) => r.acadYear));
  const d1Year = years.size === 1 ? /** @type {string | null} */ ([...years][0] ?? null) : null;
  const ng = new Set(dataFiles.ngCodes);
  const inFile = new Set(dataFiles.unscheduled.codes);
  const sorted = (/** @type {Iterable<string>} */ xs) => [...xs].sort();
  /** @type {PreDeployReport} */
  const report = {
    ok: false, d1Rows: rows.length, bundleRows: bundle.count,
    rowsKey: { d1: d1Key, manifest: manifest.rowsKey, bundle: bundle.header.rowsKey },
    catalogueKey: { d1: typeof res.body.catalogueKey === 'string' ? res.body.catalogueKey : null, file: await catalogueKey(catalogue.codes) },
    dataVersion: { d1: d1Version, committed: committedDataVersion, manifest: manifest.dataVersion, bundle: bundle.header.dataVersion },
    missingInBundle: rows.map((r) => r.code).filter((c) => !index.has(c)).sort(),
    extraInBundle: bundle.codes.filter((c) => !held.has(c)),
    fieldDrift,
    rowHashDrift: res.body.rowHash?.drift ?? [], rowHashMissing: res.body.rowHash?.missing ?? [],
    unknownReasons, rowsRead: Number(res.body.meta?.rows_read ?? 0),
    acadYear: { d1: d1Year, ngReasons: dataFiles.ngReasonsAcadYear, ngUnscheduled: dataFiles.unscheduled.acadYear },
    unscheduled: {
      missing: sorted([...ng].filter((c) => !held.has(c) && !inFile.has(c))),
      withRow: sorted([...inFile].filter((c) => held.has(c))),
      notNg: sorted([...inFile].filter((c) => !ng.has(c))),
    },
  };
  const keys = Object.values(report.rowsKey);
  const versions = Object.values(report.dataVersion);
  const acadYears = Object.values(report.acadYear);
  report.ok = keys.every((k) => k === keys[0]) && versions.every((v) => v === versions[0])
    && report.catalogueKey.d1 === report.catalogueKey.file
    && d1Year !== null && acadYears.every((y) => y === d1Year)
    && [report.missingInBundle, report.extraInBundle, report.fieldDrift, report.rowHashDrift, report.rowHashMissing, report.unknownReasons,
      report.unscheduled.missing, report.unscheduled.withRow, report.unscheduled.notNg]
      .every((l) => l.length === 0);
  return report;
}

/**
 * Human-readable lines for a pre-deploy report.
 * @param {PreDeployReport} r
 */
export function formatPreDeployReport(r) {
  const agree = (/** @type {Record<string, unknown>} */ o) => (new Set(Object.values(o)).size === 1 ? 'agree' : 'DIFFER');
  /** @param {string} label @param {unknown[]} list @param {(x: any) => string} [show] */
  const line = (label, list, show = String) =>
    `${label.padEnd(20)}${list.length}${list.length ? `  ${list.slice(0, 10).map(show).join(', ')}${list.length > 10 ? ', …' : ''}` : ''}`;
  return [
    `D1 rows            ${r.d1Rows}`,
    `bundle rows        ${r.bundleRows}`,
    `rowsKey            ${agree(r.rowsKey)}  ${Object.entries(r.rowsKey).map(([k, v]) => `${k} ${v.slice(0, 12)}`).join(', ')}`,
    `data version       ${agree(r.dataVersion)}  ${Object.entries(r.dataVersion).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    `catalogueKey       ${r.catalogueKey.d1 !== null && agree(r.catalogueKey) === 'agree' ? 'agree' : 'DIFFER'}  d1 ${r.catalogueKey.d1 ?? 'none (no catalogue_only, or a Worker from before 7D)'}, file ${r.catalogueKey.file}`,
    line('missing in bundle', r.missingInBundle),
    line('extra in bundle', r.extraInBundle),
    line('field drift', r.fieldDrift, (d) => d.code),
    line('row_hash drift', r.rowHashDrift, (d) => d.code),
    line('row_hash missing', r.rowHashMissing),
    line('unknown reason ids', r.unknownReasons, (u) => `${u.code} ${u.id}`),
    `acad year          ${r.acadYear.d1 !== null && agree(r.acadYear) === 'agree' ? 'agree' : 'DIFFER'}  ${Object.entries(r.acadYear).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    line('NG, no row, no file', r.unscheduled.missing),
    line('file code with row', r.unscheduled.withRow),
    line('file code not NG', r.unscheduled.notNg),
    `D1 rows read       ${r.rowsRead} (log it in remote-ops.md)`,
    r.ok ? 'OK: D1, the manifest and the bundle agree; the deploy may proceed' : 'DRIFT: do not deploy (runbook step 5)',
  ];
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
    ...(r.valuesChecked ? [`values sample      ${r.valuesChecked}`, line('value drift', r.valueDrift)] : []),
    `D1 rows read       ${r.rowsRead}`,
    r.ok ? 'OK: D1 and Vectorize agree' : 'DRIFT: D1 and Vectorize disagree (rerun ingest; see docs/REFERENCE.md "Re-ingesting")',
  ];
}
