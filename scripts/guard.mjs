// @ts-check
// The deploy guard's comparisons: what D1 holds
// against what the deploy ships, read over D1's REST query (scripts/d1-rest.mjs) and computed
// by src/admin-hashes.js, the code GET /admin/hashes runs.
//
// Each comparison is one entry in GUARD_CHECKS: how to compute D1's value, what it must equal,
// and what to do when it doesn't. A check with a `field` also goes into the `deploy/*` tag under
// that name, and rollback compares D1 with the target's tag on it. catalogueKey is the
// third: D1's from its catalogue_only codes (the SELECT src/admin-hashes.js runs over the same
// query), against the bundled catalogue file's (data/catalogue-codes.json, which the deploy
// reads and passes in as `catalogue`).
//
// Every row's hash is recomputed from the row's columns (src/admin-hashes.js, with
// src/rowhash.js's functions, as ingest writes them), so the data version is over the rows D1
// actually holds, not over the row_hash values it stores. Two `integrity` checks refuse any row
// whose stored row_hash is not its columns' hash, in modules (rowHashes) and catalogue_only
// (catalogueRows, whose hash covers the year); they run in rollback's data check too.
//
// No Node APIs (the Worker test harness imports this).
import { adminHashes } from '../src/admin-hashes.js';
import { DEFAULT_MODEL } from '../src/embedding.js';
import { catalogueKey, dataVersion } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';

/**
 * @typedef {import('../src/admin-hashes.js').AdminHashes} AdminHashes
 * @typedef {{
 *   hashes: AdminHashes & { modules: Record<string, import('../src/admin-hashes.js').ModuleHashes> },
 *   query: import('../src/admin-hashes.js').Query,
 *   bundle?: { entry: { rowsKey: string, count: number } }, committed?: string, catalogue?: { codes: string[] },
 * }} GuardContext `bundle`, `committed` and `catalogue` (the bundled catalogue file) are the deploy's (rollback has none)
 * @typedef {{
 *   name: string, field?: string, integrity?: boolean, label?: string, source?: string,
 *   d1: (ctx: GuardContext) => Promise<string | null>,
 *   expected: (ctx: GuardContext) => string | Promise<string>,
 *   fix?: string, describe?: (d1: string | null) => string,
 * }} GuardCheck `field`: the tag key rollback compares on; `integrity`: D1 against itself, so rollback runs it
 *   too (no tag field); `label`, `source`, `fix`: the refusal's words; `describe`: the whole refusal, for a
 *   value `short` would cut
 * @typedef {{ name: string, field?: string, d1: string | null, expected: string, ok: boolean, message: string }} CheckResult
 */

/** @param {string | null} v */
const short = (v) => (v === null ? 'unknown' : v.length > 16 ? `${v.slice(0, 12)}…` : v);

/** What an integrity check reads when every row's row_hash is its columns' hash. */
export const NO_DRIFT = 'none';
/** How many codes a drift refusal names. */
const DRIFT_SHOWN = 10;
/** @param {string[] | null | undefined} drift */
const driftValue = (drift) => (!Array.isArray(drift) ? null : drift.length === 0 ? NO_DRIFT
  : `${drift.length}: ${drift.slice(0, DRIFT_SHOWN).join(', ')}${drift.length > DRIFT_SHOWN ? ', …' : ''}`);
/** @param {string} table @param {string | null} d1 */
const driftMessage = (table, d1) => (d1 === null
  ? `D1 reported no row_hash check for ${table} (a Worker or reader without the row_hash integrity check).`
  : `${d1.split(':')[0]} of D1's ${table} rows ${d1.startsWith('1:') ? 'has a row_hash that is not its' : 'have a row_hash that is not their'} columns' hash (${d1.slice(d1.indexOf(':') + 2)}): `
    + 'their columns changed behind row_hash (a hand `d1 execute`, an older writer, a one-table restore). '
    + 'Run the D1-only ingest (runbook step 4): it rewrites them.');

/** @type {GuardCheck[]} */
export const GUARD_CHECKS = [
  {
    name: 'rowsKey',
    label: 'rowsKey, over its (code, text_hash) pairs,',
    source: 'the production bundle\'s',
    d1: async ({ hashes }) => rowsKey(Object.entries(hashes.modules).map(([code, h]) => ({ code, textHash: h.textHash }))),
    expected: ({ bundle }) => /** @type {NonNullable<GuardContext['bundle']>} */ (bundle).entry.rowsKey,
    fix: 'D1 does not hold the texts the bundle embeds: run the D1-only ingest (runbook step 4) first.',
  },
  {
    name: 'dataVersion',
    field: 'dataVersion',
    label: 'data version',
    source: 'src/data-version.json',
    d1: async ({ hashes }) => {
      const rows = Object.entries(hashes.modules);
      return rows.every(([, h]) => typeof h.rowHash === 'string')
        ? dataVersion(rows.map(([code, h]) => ({ code, rowHash: /** @type {string} */ (h.rowHash) })))
        : null;
    },
    expected: ({ committed }) => /** @type {string} */ (committed),
    fix: 'D1 holds other rows than the committed ones: run the D1-only ingest (runbook step 4) first.',
  },
  {
    // D1's modules rows against their own row_hash, recomputed from their columns.
    name: 'rowHashes',
    integrity: true,
    d1: async ({ hashes }) => driftValue(hashes.rowHashDrift),
    expected: () => NO_DRIFT,
    describe: (d1) => driftMessage('modules', d1),
  },
  {
    // The Worker answers not-offered for the bundled file's codes and names the title
    // D1's catalogue_only holds, so the two must hold the same codes.
    name: 'catalogueKey',
    field: 'catalogueKey',
    label: 'catalogueKey, over its catalogue_only codes,',
    source: 'the bundled catalogue file\'s (data/catalogue-codes.json)',
    d1: async ({ hashes }) => hashes.catalogueKey ?? null,
    expected: ({ catalogue }) => catalogueKey(/** @type {NonNullable<GuardContext['catalogue']>} */ (catalogue).codes),
    fix: 'D1\'s catalogue_only is not the codes the Worker answers not-offered for: load it from `current` (the D1-only ingest, '
      + 'runbook step 4), or rebuild the file (node scripts/build-catalogue-data.mjs --corpus production).',
  },
  {
    // catalogue_only rows (the titles search names) against their own row_hash. The
    // bundled file holds codes only, which catalogueKey covers.
    name: 'catalogueRows',
    integrity: true,
    d1: async ({ hashes }) => driftValue(hashes.catalogueDrift),
    expected: () => NO_DRIFT,
    describe: (d1) => driftMessage('catalogue_only', d1),
  },
];

/**
 * The /admin/hashes body, over the REST client.
 * @param {import('./d1-rest.mjs').D1Client} client
 * @returns {Promise<Pick<GuardContext, 'hashes' | 'query'>>}
 */
export async function readD1(client) {
  const hashes = await adminHashes(client.query, { embeddingModel: DEFAULT_MODEL });
  if (!hashes.modules) throw new Error(`D1's schema check failed, so its hashes can't be read: ${JSON.stringify(hashes.schema)}`);
  return { hashes: /** @type {GuardContext['hashes']} */ (hashes), query: client.query };
}

/**
 * @param {GuardCheck} c @param {string | null} d1 @param {string} expected
 * @returns {CheckResult}
 */
const result = (c, d1, expected) => ({
  name: c.name, ...(c.field ? { field: c.field } : {}), d1, expected, ok: d1 === expected,
  message: c.describe ? c.describe(d1)
    : `D1's ${c.label ?? c.name} is ${short(d1)}, ${c.source ?? 'the expected value'} says ${short(expected)}.${c.fix ? ` ${c.fix}` : ''}`,
});

/**
 * Runs every check against what the deploy ships.
 * @param {{ client: import('./d1-rest.mjs').D1Client, bundle: NonNullable<GuardContext['bundle']>, committed: string,
 *   catalogue: NonNullable<GuardContext['catalogue']>, checks?: GuardCheck[] }} o
 * @returns {Promise<{ ok: boolean, modules: number, results: CheckResult[], values: Record<string, string | null> }>}
 */
export async function runGuard({ client, bundle, committed, catalogue, checks = GUARD_CHECKS }) {
  const ctx = { ...(await readD1(client)), bundle, committed, catalogue };
  /** @type {CheckResult[]} */
  const results = [];
  for (const c of checks) results.push(result(c, await c.d1(ctx), await c.expected(ctx)));
  return {
    ok: results.every((r) => r.ok), modules: Object.keys(ctx.hashes.modules).length, results,
    values: Object.fromEntries(results.filter((r) => r.field).map((r) => [/** @type {string} */ (r.field), r.d1])),
  };
}

/**
 * Rollback's data check: every check with a `field`, D1 against the target tag's value; and every
 * `integrity` check, D1 against itself.
 * @param {{ client: import('./d1-rest.mjs').D1Client, fields: Record<string, string>, checks?: GuardCheck[] }} o
 * @returns {Promise<{ ok: boolean, results: CheckResult[], values: Record<string, string | null> }>}
 */
export async function compareWithTag({ client, fields, checks = GUARD_CHECKS }) {
  const ctx = await readD1(client);
  /** @type {CheckResult[]} */
  const results = [];
  /** @type {Record<string, string | null>} */
  const values = {};
  for (const c of checks.filter((x) => x.field || x.integrity)) {
    const d1 = await c.d1(ctx);
    if (!c.field) { results.push(result(c, d1, await c.expected(ctx))); continue; }
    const field = c.field;
    values[field] = d1;
    if (!(field in fields)) {
      results.push({ name: c.name, field, d1, expected: '', ok: false, message: `the target's tag has no ${field}, so D1's (${short(d1)}) can't be checked against it.` });
    } else {
      results.push(result({ ...c, source: `the target's tag (${field})`, fix: undefined }, d1, fields[field]));
    }
  }
  return { ok: results.every((r) => r.ok), results, values };
}
