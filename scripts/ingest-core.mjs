// @ts-check
// The ingest run itself, with every side effect injected: the admin API (over
// HTTP in scripts/ingest.mjs, straight into the Worker in tests), the clock,
// the sleep between retries and polls, and the log. No Node APIs, so the
// Worker tests run this exact code against the real routes and local D1.
//
// One run (docs/plans/phase1.md "Ingest (changes vs r1)", FINDINGS B2):
//  1. GET /admin/hashes. Refuse unless the database has migration 0006
//     (external-content FTS keyed on rowid, row_hash): a full rewrite through
//     the old triggers reads ~46M rows (B3). Refuse a mixed acad year,
//     duplicate codes, a Worker embedding with another model, or (unless
//     allowMassDelete) a corpus smaller than 95% of D1 — all before any write.
//  2. Plan per module: text_hash differs → re-embed; only row_hash differs →
//     rewrite the row and re-upsert the vector with its stored values and new
//     metadata; both equal → skip.
//  3. Upsert in batches, concurrently, inside a write budget summed from each
//     response's D1 meta.rows_written. The last batch goes alone after the
//     others, so the run's last Vectorize mutation is well defined.
//  4. Only if no batch failed and the budget held: delete codes D1 has and the
//     corpus lacks (Vectorize first, then D1), one request at a time.
//  5. Rebuild the facets row; wait until Vectorize has processed the last
//     mutation (describe().processedUpToMutation, bounded poll); report the
//     data version for src/data-version.json.
import { dataVersion, rowHash } from '../src/rowhash.js';

export const DEFAULTS = Object.freeze({
  batchSize: 50,
  concurrency: 4,
  /** ADR 0002: a forced full re-ingest (~34.4k rows written) fits in one run. */
  writeBudget: 40_000,
  deleteBatchSize: 100,
  /** Abort if the corpus offers fewer than this share of the codes D1 holds. */
  massDeleteRatio: 0.95,
  maxAttempts: 5,
  waitTimeoutMs: 10 * 60_000,
  waitIntervalMs: 5_000,
  /**
   * Rows written per module before any batch has reported its own: measured
   * ~5.1 per upsert (row + index entries, docs/evidence/phase1/0006-cost.md),
   * rounded up. Once batches report, the highest per-module rate seen is used.
   */
  writesPerRowPrior: 6,
});

/** The schema 0006 must have left behind, as /admin/hashes reports it. */
export const REQUIRED_SCHEMA = 6;

/**
 * @typedef {NormalisedModule & { rowHash: string }} HashedModule
 * @typedef {{ textHash: string, rowHash: string | null }} StoredHashes
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, rowHashColumn: boolean, ok: boolean,
 * }} SchemaStatus
 * @typedef {{ schema: SchemaStatus, embeddingModel?: string, modules: Record<string, StoredHashes> | null }} HashesResponse
 * @typedef {{ status: number, body: any }} ApiResponse
 * @typedef {{
 *   get: (path: string) => Promise<ApiResponse>,
 *   post: (path: string, body: unknown) => Promise<ApiResponse>,
 * }} AdminApi
 * @typedef {{
 *   force?: boolean, from?: string | null, batchSize?: number, concurrency?: number, writeBudget?: number,
 *   allowMassDelete?: boolean, deleteBatchSize?: number, massDeleteRatio?: number, maxAttempts?: number,
 *   waitTimeoutMs?: number, waitIntervalMs?: number, writesPerRowPrior?: number, embeddingModel?: string | null,
 * }} IngestOptions
 * @typedef {'done' | 'refused' | 'failed' | 'budget' | 'wait-timeout'} IngestStatus
 * @typedef {{
 *   status: IngestStatus, message: string,
 *   plan: { embed: number, rowOnly: number, unchanged: number, deletes: number },
 *   upserted: number, embedded: number, failed: number, deleted: number,
 *   rowsRead: number, rowsWritten: number, resumeFrom: string | null,
 *   lastMutationId: string | null, dataVersion: string | null,
 * }} IngestResult
 */

/**
 * What to do with each module. Pure.
 * @template {{ code: string, textHash: string, rowHash: string }} M
 * @param {M[]} modules
 * @param {Record<string, StoredHashes>} stored code -> hashes D1 holds
 * @param {{ force: boolean }} options
 */
export function planIngest(modules, stored, { force }) {
  /** @type {M[]} */
  const embed = [];
  /** @type {M[]} */
  const rowOnly = [];
  let unchanged = 0;
  for (const m of modules) {
    const s = stored[m.code];
    if (force || !s || s.textHash !== m.textHash) embed.push(m);
    else if (s.rowHash !== m.rowHash) rowOnly.push(m);
    else unchanged++;
  }
  const offered = new Set(modules.map((m) => m.code));
  const deletes = Object.keys(stored).filter((c) => !offered.has(c)).sort();
  return { embed, rowOnly, unchanged, deletes };
}

/**
 * @param {{
 *   modules: NormalisedModule[], facetsBody: unknown, api: AdminApi, options?: IngestOptions,
 *   log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} args
 * @returns {Promise<IngestResult>}
 */
export async function runIngest({ modules, facetsBody, api, options = {}, log = () => {}, sleep = defaultSleep, now = Date.now }) {
  const o = { ...DEFAULTS, force: false, from: null, allowMassDelete: false, embeddingModel: null, ...options };
  /** @type {IngestResult} */
  const result = {
    status: 'done', message: '', plan: { embed: 0, rowOnly: 0, unchanged: 0, deletes: 0 },
    upserted: 0, embedded: 0, failed: 0, deleted: 0, rowsRead: 0, rowsWritten: 0,
    resumeFrom: null, lastMutationId: null, dataVersion: null,
  };
  /** @param {IngestStatus} status @param {string} message */
  const stop = (status, message) => {
    result.status = status;
    result.message = message;
    log(message);
    return result;
  };

  // 1. What D1 holds, and whether it is safe to write to.
  const hashesRes = await api.get('/admin/hashes');
  if (hashesRes.status !== 200) {
    return stop('refused', `GET /admin/hashes -> HTTP ${hashesRes.status}. Is the Worker running with INGEST_SECRET bound?`);
  }
  const hashes = /** @type {HashesResponse} */ (hashesRes.body);
  const schemaProblem = describeSchemaProblem(hashes.schema);
  if (schemaProblem) return stop('refused', schemaProblem);
  if (o.embeddingModel && hashes.embeddingModel && hashes.embeddingModel !== o.embeddingModel) {
    return stop('refused', `The Worker embeds with ${hashes.embeddingModel} but text_hash is computed for ${o.embeddingModel}; `
      + 'unset EMBEDDING_MODEL or update scripts/lib.mjs EMBEDDING_MODEL so the hashes describe the vectors.');
  }
  const stored = /** @type {Record<string, StoredHashes>} */ (hashes.modules);

  const years = [...new Set(modules.map((m) => m.acadYear))];
  if (years.length !== 1) return stop('refused', `The corpus mixes acad years (${years.join(', ')}); one database holds one year.`);
  const seen = new Set();
  const dupes = modules.filter((m) => (seen.has(m.code) ? true : (seen.add(m.code), false))).map((m) => m.code);
  if (dupes.length) return stop('refused', `Duplicate module codes in the corpus: ${dupes.slice(0, 10).join(', ')}.`);

  const d1Count = Object.keys(stored).length;
  if (d1Count > 0 && modules.length < o.massDeleteRatio * d1Count && !o.allowMassDelete) {
    return stop('refused', `The corpus offers ${modules.length} modules but D1 holds ${d1Count} `
      + `(${((modules.length / d1Count) * 100).toFixed(1)}% < ${o.massDeleteRatio * 100}%). Nothing was written. `
      + 'If the drop is real, rerun with --allow-mass-delete.');
  }

  // 2. Plan.
  /** @type {HashedModule[]} */
  const hashed = await Promise.all(modules.map(async (m) => ({ ...m, rowHash: await rowHash(m) })));
  const plan = planIngest(hashed, stored, { force: o.force });
  result.plan = { embed: plan.embed.length, rowOnly: plan.rowOnly.length, unchanged: plan.unchanged, deletes: plan.deletes.length };
  log(`plan               ${plan.embed.length} to embed, ${plan.rowOnly.length} row-only, ${plan.unchanged} unchanged, ${plan.deletes.length} to delete`);

  // In code order, so a run stopped by the budget resumes from one code.
  /** @type {(HashedModule & { reembed: boolean })[]} */
  let work = [
    ...plan.embed.map((m) => ({ ...m, reembed: true })),
    ...plan.rowOnly.map((m) => ({ ...m, reembed: false })),
  ].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  if (o.from) {
    const from = o.from;
    const before = work.length;
    work = work.filter((m) => m.code >= from);
    log(`--from ${from}       skipping ${before - work.length} modules before it`);
  }
  /** @type {(HashedModule & { reembed: boolean })[][]} */
  const batches = [];
  for (let i = 0; i < work.length; i += o.batchSize) batches.push(work.slice(i, i + o.batchSize));

  // 3. Upserts inside the write budget.
  let reserved = 0;
  /** Highest rows written per module any batch has reported; null before the first. */
  /** @type {number | null} */
  let maxRate = null;
  let budgetHit = false;
  /**
   * Rows a batch of `rows` modules may write: at the worst per-module rate a
   * batch of this run has shown, or the prior before any has reported.
   * @param {number} rows
   */
  const estimate = (rows) => Math.ceil(rows * (maxRate ?? o.writesPerRowPrior));
  /** @param {number} rows @returns {number | null} the reservation, or null if over budget */
  const reserve = (rows) => {
    const need = estimate(rows);
    if (result.rowsWritten + reserved + need > o.writeBudget) return null;
    reserved += need;
    return need;
  };

  /** @param {string} path @param {unknown} body @param {string} label */
  const send = async (path, body, label) => {
    for (let attempt = 1; ; attempt++) {
      const res = await api.post(path, body);
      if (res.status === 200) return res.body;
      // Workers AI throttles under load; back off rather than losing the batch.
      if (attempt < o.maxAttempts && (res.status === 429 || res.status >= 500)) {
        const wait = 2 ** attempt * 1000;
        log(`  ${label}: HTTP ${res.status}, retrying in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      log(`  ${label} FAILED after ${attempt} attempts: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
      return null;
    }
  };
  /** @param {any} body */
  const account = (body) => {
    result.rowsRead += Number(body?.meta?.rows_read ?? 0);
    result.rowsWritten += Number(body?.meta?.rows_written ?? 0);
  };

  /** @param {(HashedModule & { reembed: boolean })[]} batch @param {number} held */
  const upsertBatch = async (batch, held) => {
    // rowHash travels along but the Worker recomputes it from what it binds.
    const body = await send('/admin/ingest', { modules: batch }, `batch ${batch[0].code}…`);
    reserved -= held;
    if (!body) { result.failed += batch.length; return; }
    account(body);
    const rate = Number(body?.meta?.rows_written ?? 0) / batch.length;
    maxRate = maxRate === null ? rate : Math.max(maxRate, rate);
    result.upserted += Number(body.upserted ?? batch.length);
    result.embedded += Number(body.embedded ?? 0);
    if (body.mutationId) result.lastMutationId = String(body.mutationId);
  };

  const queue = batches.slice(0, -1);
  const tail = batches.at(-1);
  /** @type {string | null} */
  let firstUnsent = null;
  const started = now();
  const progress = () => log(`  ${result.upserted + result.failed}/${work.length}  written ${result.rowsWritten}  failed ${result.failed}  ${((now() - started) / 1000).toFixed(0)}s`);
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    while (queue.length && !budgetHit) {
      const batch = /** @type {(HashedModule & { reembed: boolean })[]} */ (queue[0]);
      const held = reserve(batch.length);
      if (held === null) { budgetHit = true; firstUnsent = batch[0].code; break; }
      queue.shift();
      await upsertBatch(batch, held);
      progress();
    }
  }));
  if (tail && !budgetHit) {
    const held = reserve(tail.length);
    if (held === null) { budgetHit = true; firstUnsent = tail[0].code; }
    else { await upsertBatch(tail, held); progress(); }
  }

  const facets = async () => {
    const body = await send('/admin/facets', facetsBody, 'facets');
    if (body) {
      log(`facets rebuilt      ${body.faculties} faculties, ${body.levels} levels, ${body.ng} NG (list updated ${body.ngListUpdatedAsAt})`);
    } else {
      log('facets rebuild FAILED — /facets will fall back to live aggregates');
    }
  };

  if (budgetHit) {
    result.resumeFrom = firstUnsent;
    if (result.upserted > 0) await facets();
    return stop('budget', `Write budget: the next batch would take rows written past --write-budget ${o.writeBudget} `
      + `(${result.rowsWritten} written so far). Stopped cleanly: ${result.upserted} of ${work.length} modules upserted, `
      + 'no deletes run, src/data-version.json not written. To resume, rerun the same command '
      + `${o.force ? `with --from ${firstUnsent} ` : ''}once the day's D1 write headroom allows `
      + `(the hash skip sends only what is still pending${o.force ? '; --force alone would start over' : ''}).`);
  }
  if (result.failed > 0) {
    if (result.upserted > 0) await facets();
    return stop('failed', `${result.failed} modules failed; deletes skipped. Rerun the same command: the hash skip retries only what failed.`);
  }

  // 4. Deletes, last, Vectorize before D1 (inside /admin/delete), one at a time.
  for (let i = 0; i < plan.deletes.length; i += o.deleteBatchSize) {
    const codes = plan.deletes.slice(i, i + o.deleteBatchSize);
    const held = reserve(codes.length);
    if (held === null) {
      result.resumeFrom = codes[0];
      await facets();
      return stop('budget', `Write budget reached before deleting ${plan.deletes.length - result.deleted} modules `
        + `(${result.rowsWritten} rows written). Rerun the same command to finish the deletes.`);
    }
    const body = await send('/admin/delete', { codes }, `delete ${codes[0]}…`);
    reserved -= held;
    if (!body) {
      await facets();
      return stop('failed', `Deleting ${codes.length} modules from ${codes[0]} failed; rerun the same command.`);
    }
    account(body);
    result.deleted += Number(body.deleted ?? 0);
    if (body.mutationId) result.lastMutationId = String(body.mutationId);
  }
  if (plan.deletes.length) log(`deleted            ${result.deleted} (${plan.deletes.slice(0, 10).join(', ')}${plan.deletes.length > 10 ? ', …' : ''})`);

  // 5. Facets (always: the NG list date can change with no row changing), the
  // Vectorize mutation wait, the data version.
  await facets();
  if (result.lastMutationId) {
    const waited = await waitForMutation(api, result.lastMutationId, { timeoutMs: o.waitTimeoutMs, intervalMs: o.waitIntervalMs, sleep, now, log });
    if (!waited) {
      return stop('wait-timeout', `Vectorize had not processed mutation ${result.lastMutationId} after ${o.waitTimeoutMs / 1000}s. `
        + 'D1 is complete; run npm run verify once `wrangler vectorize info` shows it, then write the data version by rerunning (nothing left to send).');
    }
  }
  result.dataVersion = await dataVersion(hashed);
  return stop('done', `done               ${result.upserted} upserted (${result.embedded} embedded), ${result.deleted} deleted, `
    + `${result.rowsRead} rows read, ${result.rowsWritten} rows written; data version ${result.dataVersion}`);
}

/**
 * Why the database must not be written by this ingest, or null.
 * @param {SchemaStatus | undefined} schema
 */
export function describeSchemaProblem(schema) {
  if (schema?.ok) return null;
  const missing = !schema ? ['a schema report (is the Worker older than this script?)'] : [
    ...(schema.version === null || schema.version < REQUIRED_SCHEMA ? [`meta('schema') >= ${REQUIRED_SCHEMA} (found ${schema.version ?? 'none'})`] : []),
    ...(schema.ftsExternal ? [] : ["external-content modules_fts (content='modules')"]),
    ...(schema.rowidTriggers ? [] : ['FTS triggers keyed on rowid']),
    ...(schema.rowHashColumn ? [] : ['the modules.row_hash column']),
  ];
  return `Refusing to ingest: the target database lacks migration 0006 (${missing.join('; ')}). `
    + 'Rewriting rows through the pre-0006 FTS triggers reads ~46M rows for a full re-ingest (FINDINGS B3). '
    + 'Apply migrations/0006_fts_external.sql first (docs/decisions/0002-phase1-remote-ops.md).';
}

/**
 * Polls GET /admin/vectorize until describe().processedUpToMutation is
 * `mutationId` (Vectorize processes mutations in order, so everything before
 * it is applied too). Bounded: false after `timeoutMs`.
 * @param {AdminApi} api
 * @param {string} mutationId
 * @param {{ timeoutMs: number, intervalMs: number, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void }} o
 */
export async function waitForMutation(api, mutationId, { timeoutMs, intervalMs, sleep, now, log }) {
  const deadline = now() + timeoutMs;
  for (let polls = 1; ; polls++) {
    const res = await api.get('/admin/vectorize');
    const processed = res.status === 200 ? res.body?.processedUpToMutation : null;
    if (processed !== null && processed !== undefined && String(processed) === mutationId) {
      log(`vectorize          processed up to ${mutationId} (${polls} poll${polls === 1 ? '' : 's'}, ${res.body.vectorCount} vectors)`);
      return true;
    }
    if (now() + intervalMs > deadline) return false;
    if (polls === 1) log(`vectorize          waiting for mutation ${mutationId} (processed up to ${processed ?? 'unknown'})`);
    await sleep(intervalMs);
  }
}

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
