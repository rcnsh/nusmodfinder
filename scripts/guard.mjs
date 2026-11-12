// @ts-check
// The deploy guard's comparisons (Phase 7 7B; Phase 3 3-0's B-2 and B3-4): what D1 holds
// against what the deploy ships, read over D1's REST query (scripts/d1-rest.mjs) and computed
// by src/admin-hashes.js, the code GET /admin/hashes runs.
//
// Each comparison is one entry in GUARD_CHECKS: how to compute D1's value, what it must equal,
// and what to do when it doesn't. A check with a `field` also goes into the `deploy/*` tag under
// that name, and rollback compares D1 with the target's tag on it. 7D's catalogueKey is one more
// entry here (its `d1` reads `catalogue_only` through `ctx.query`).
//
// No Node APIs (the Worker test harness imports this).
import { adminHashes } from '../src/admin-hashes.js';
import { DEFAULT_MODEL } from '../src/embedding.js';
import { dataVersion } from '../src/rowhash.js';
import { rowsKey } from '../src/vector-bundle.js';

/**
 * @typedef {import('../src/admin-hashes.js').AdminHashes} AdminHashes
 * @typedef {{
 *   hashes: AdminHashes & { modules: Record<string, import('../src/admin-hashes.js').ModuleHashes> },
 *   query: import('../src/admin-hashes.js').Query,
 *   bundle?: { entry: { rowsKey: string, count: number } }, committed?: string,
 * }} GuardContext `bundle` and `committed` are the deploy's (rollback has neither)
 * @typedef {{
 *   name: string, field?: string, label?: string, source?: string,
 *   d1: (ctx: GuardContext) => Promise<string | null>,
 *   expected: (ctx: GuardContext) => string | Promise<string>,
 *   fix?: string,
 * }} GuardCheck `field`: the tag key rollback compares on; `label`, `source`, `fix`: the refusal's words
 * @typedef {{ name: string, field?: string, d1: string | null, expected: string, ok: boolean, message: string }} CheckResult
 */

/** @param {string | null} v */
const short = (v) => (v === null ? 'unknown' : v.length > 16 ? `${v.slice(0, 12)}…` : v);

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
  message: `D1's ${c.label ?? c.name} is ${short(d1)}, ${c.source ?? 'the expected value'} says ${short(expected)}.${c.fix ? ` ${c.fix}` : ''}`,
});

/**
 * Runs every check against what the deploy ships.
 * @param {{ client: import('./d1-rest.mjs').D1Client, bundle: NonNullable<GuardContext['bundle']>, committed: string, checks?: GuardCheck[] }} o
 * @returns {Promise<{ ok: boolean, modules: number, results: CheckResult[], values: Record<string, string | null> }>}
 */
export async function runGuard({ client, bundle, committed, checks = GUARD_CHECKS }) {
  const ctx = { ...(await readD1(client)), bundle, committed };
  /** @type {CheckResult[]} */
  const results = [];
  for (const c of checks) results.push(result(c, await c.d1(ctx), await c.expected(ctx)));
  return {
    ok: results.every((r) => r.ok), modules: Object.keys(ctx.hashes.modules).length, results,
    values: Object.fromEntries(results.filter((r) => r.field).map((r) => [/** @type {string} */ (r.field), r.d1])),
  };
}

/**
 * Rollback's data check: every check with a `field`, D1 against the target tag's value.
 * @param {{ client: import('./d1-rest.mjs').D1Client, fields: Record<string, string>, checks?: GuardCheck[] }} o
 * @returns {Promise<{ ok: boolean, results: CheckResult[], values: Record<string, string | null> }>}
 */
export async function compareWithTag({ client, fields, checks = GUARD_CHECKS }) {
  const ctx = await readD1(client);
  /** @type {CheckResult[]} */
  const results = [];
  for (const c of checks.filter((x) => x.field)) {
    const field = /** @type {string} */ (c.field);
    const d1 = await c.d1(ctx);
    if (!(field in fields)) {
      results.push({ name: c.name, field, d1, expected: '', ok: false, message: `the target's tag has no ${field}, so D1's (${short(d1)}) can't be checked against it.` });
    } else {
      results.push(result({ ...c, source: `the target's tag (${field})`, fix: undefined }, d1, fields[field]));
    }
  }
  return { ok: results.every((r) => r.ok), results, values: Object.fromEntries(results.map((r) => [/** @type {string} */ (r.field), r.d1])) };
}
