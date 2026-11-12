// @ts-check
// Runbook step 8: bring the
// Vectorize standby level with the bundle. The admin API and the parsed
// bundle are injected and no Node API is used, so the Worker tests run this
// exact code against the real /admin/vectors route and the fake index.
//
// One run:
//  1. GET /admin/hashes. Refuse unless D1's (code, text_hash) pairs hash to
//     the bundle's rowsKey: the vectors must embed exactly the texts D1 holds.
//  2. Upsert every code D1 holds (nothing tracks which changed, so all of
//     them is the only complete rule), in batches of at most 1,000, the
//     values from the bundle (the sha-checked asset) and the metadata from
//     D1's rows (the route). Every batch's mutationId is kept.
//  3. deleteByIds for every index id D1 no longer holds: the index's ids
//     (listVectorIds) minus D1's codes, plus any codes the step-4 deletions
//     file names. The file alone is not enough: a resumed or retried step 4
//     loses codes it already deleted from D1 (PR #35 review).
//  4. Wait for the last mutation with ingest-core's waitForMutation.
// Then the caller runs `npm run verify` with a getByIds sample of values
// against the bundle (scripts/verify-core.mjs).
import { float32ToBase64, rowsKey } from '../src/vector-bundle.js';
import { waitForMutation } from './ingest-core.mjs';

export const STANDBY_BATCH = 1000;

/**
 * @typedef {import('../src/vector-bundle.js').Bundle} Bundle
 * @typedef {{
 *   status: 'done' | 'refused' | 'failed' | 'wait-timeout', message: string,
 *   upserted: number, deleted: number, mutations: string[], lastMutationId: string | null,
 * }} StandbyResult
 */

/**
 * Row `i`'s values, as stored in the bundle.
 * @param {Bundle} b
 * @param {number} i
 */
export const bundleRow = (b, i) => b.vectors.subarray(i * b.dims, (i + 1) * b.dims);

/**
 * @param {{
 *   api: import('./ingest-core.mjs').AdminApi, bundle: Bundle, deletes?: string[], batchSize?: number,
 *   listVectorIds?: () => Promise<string[]>,
 *   waitTimeoutMs?: number, waitIntervalMs?: number, sleep?: (ms: number) => Promise<void>, now?: () => number,
 *   log?: (line: string) => void,
 * }} args
 * @returns {Promise<StandbyResult>}
 */
export async function runStandby({
  api, bundle, deletes: listed = [], listVectorIds, batchSize = STANDBY_BATCH, waitTimeoutMs = 10 * 60_000, waitIntervalMs = 5_000,
  sleep = (ms) => new Promise((r) => { setTimeout(r, ms); }), now = Date.now, log = () => {},
}) {
  /** @type {StandbyResult} */
  const result = { status: 'done', message: '', upserted: 0, deleted: 0, mutations: [], lastMutationId: null };
  /** @param {StandbyResult['status']} status @param {string} message */
  const stop = (status, message) => { result.status = status; result.message = message; log(message); return result; };
  if (batchSize < 1 || batchSize > STANDBY_BATCH) return stop('refused', `batch size must be 1 to ${STANDBY_BATCH}`);

  const hashes = await api.get('/admin/hashes');
  if (hashes.status !== 200 || !hashes.body?.modules) {
    return stop('refused', `GET /admin/hashes -> HTTP ${hashes.status}. Is the Worker running with INGEST_SECRET bound?`);
  }
  /** @type {Record<string, { textHash: string }>} */
  const held = hashes.body.modules;
  const d1Key = await rowsKey(Object.entries(held).map(([code, h]) => ({ code, textHash: h.textHash })));
  if (d1Key !== bundle.header.rowsKey) {
    const inBundle = new Set(bundle.codes);
    const missing = Object.keys(held).filter((c) => !inBundle.has(c));
    return stop('refused', `D1's (code, text_hash) pairs do not match the bundle's rowsKey (D1 ${d1Key.slice(0, 12)}, `
      + `bundle ${bundle.header.rowsKey.slice(0, 12)}; ${missing.length} D1 codes not in the bundle${missing.length ? `: ${missing.slice(0, 5).join(', ')}` : ''}). `
      + 'Nothing was sent. Run runbook step 4 (the D1-only ingest) first, or build the bundle for what D1 holds.');
  }
  const stillHeld = listed.filter((c) => c in held);
  if (stillHeld.length) return stop('refused', `The deletions list names codes D1 still holds: ${stillHeld.slice(0, 10).join(', ')}. Nothing was sent.`);

  // Everything in the index that D1 no longer holds, with the file's codes as a floor.
  const orphans = listVectorIds ? (await listVectorIds()).filter((id) => !(id in held)) : [];
  const deletes = [...new Set([...listed, ...orphans])].sort();
  if (orphans.length) log(`  ${orphans.length} index ids not in D1 will be deleted`);

  /** @param {any} body */
  const sent = (body) => {
    if (body?.mutationId) {
      result.mutations.push(String(body.mutationId));
      result.lastMutationId = String(body.mutationId);
    }
    return { id: String(body?.mutationId), sentAt: typeof body?.sentAt === 'number' ? body.sentAt : null };
  };
  /** @type {{ id: string, sentAt: number | null } | null} */
  let last = null;
  for (let i = 0; i < bundle.count; i += batchSize) {
    const ids = bundle.codes.slice(i, i + batchSize);
    const values = bundle.vectors.subarray(i * bundle.dims, (i + ids.length) * bundle.dims);
    const res = await api.post('/admin/vectors', { ids, values: float32ToBase64(values) });
    if (res.status !== 200) {
      return stop('failed', `upsert of ${ids.length} vectors from ${ids[0]} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}. `
        + `${result.upserted} upserted before it. Rerun: every run upserts every code.`);
    }
    result.upserted += Number(res.body.upserted ?? ids.length);
    last = sent(res.body);
    log(`  upserted ${result.upserted}/${bundle.count}  mutation ${last.id}`);
  }
  for (let i = 0; i < deletes.length; i += batchSize) {
    const deleteIds = deletes.slice(i, i + batchSize);
    const res = await api.post('/admin/vectors', { deleteIds });
    if (res.status !== 200) {
      return stop('failed', `deleteByIds of ${deleteIds.length} codes from ${deleteIds[0]} -> HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}.`);
    }
    result.deleted += Number(res.body.deleted ?? deleteIds.length);
    last = sent(res.body);
  }
  if (!last) return stop('done', 'nothing to send (empty bundle)');
  const target = { id: last.id, sentAt: last.sentAt, earlier: result.mutations.slice(0, -1) };
  const waited = await waitForMutation(api, target, { timeoutMs: waitTimeoutMs, intervalMs: waitIntervalMs, sleep, now, log });
  if (!waited) {
    return stop('wait-timeout', `Vectorize had not processed mutation ${target.id} after ${waitTimeoutMs / 1000}s. `
      + 'Rerun later; then run npm run verify.');
  }
  return stop('done', `standby level: ${result.upserted} upserted, ${result.deleted} deleted, last mutation ${target.id} processed`);
}
