// @ts-check
// The ingest run itself, with every side effect injected: the admin API (over
// HTTP in scripts/ingest.mjs, straight into the Worker in tests), the store
// for an unconfirmed Vectorize mutation, the clock, the sleep between retries
// and polls, and the log. No Node APIs, so the Worker tests run this exact
// code against the real routes and local D1.
//
// One run (docs/plans/phase1.md "Ingest (changes vs r1)", FINDINGS B2):
//  1. GET /admin/hashes. Refuse unless the database has migration 0006
//     (external-content FTS keyed on rowid, its four triggers, row_hash): a
//     full rewrite through the old triggers reads ~46M rows (B3). Refuse a
//     mixed acad year, duplicate codes, a Worker embedding with another model,
//     or (unless allowYearChange) a corpus for another acad year than D1
//     holds — all before any write.
//  2. Plan per module: text_hash differs → re-embed; only row_hash differs →
//     rewrite the row and re-upsert the vector with its stored values and new
//     metadata (the Worker re-embeds if the stored vector is not for this
//     text_hash); both equal → skip. Refuse (unless allowMassDelete) a plan
//     that deletes more than 5% of the codes D1 holds, before any write.
//  3. Upsert in batches, concurrently, inside a write budget. Each batch is
//     charged the larger of its D1 meta.rows_written and an estimate that
//     includes the FTS5 shadow-table writes local D1 does not report (and
//     remote D1 may bill). The last batch goes alone after the others, so the
//     run's last Vectorize mutation is well defined.
//  4. Only if no batch failed and the budget held: delete codes D1 has and the
//     corpus lacks (hashes cleared, Vectorize, then D1), one request at a time.
//  5. Rebuild the facets row; wait until Vectorize has processed the last
//     mutation (describe().processedUpToMutation, bounded poll) — this run's,
//     or one an earlier run sent and never saw confirmed; report the data
//     version for src/data-version.json.
import { dataVersion, rowHash } from '../src/rowhash.js';

export const DEFAULTS = Object.freeze({
  batchSize: 50,
  concurrency: 4,
  /** ADR 0002: a forced full re-ingest (~37k rows charged) fits in one run. */
  writeBudget: 40_000,
  deleteBatchSize: 100,
  /** Abort if the plan would delete more than (1 - this) of the codes D1 holds. */
  massDeleteRatio: 0.95,
  maxAttempts: 5,
  waitTimeoutMs: 10 * 60_000,
  waitIntervalMs: 5_000,
  // The write estimate per module, by what the upsert does to its row
  // (docs/evidence/phase1/ingest-cost.md, fts-writes.mjs). Table and index
  // rows, as local D1 reports them, measured over the full corpus and rounded
  // up: an INSERT ~7.1, an UPDATE ~5.1 (5.4 for field-only changes).
  writesPerInsert: 8,
  writesPerUpdate: 5.5,
  // FTS5 shadow-table writes, which local D1's meta does not show: an inserted
  // row 13.19 on average (cold load), a changed title/description 15.69; a row
  // whose indexed text is unchanged, 0 (the update trigger does not fire).
  ftsWritesPerInsert: 14,
  ftsWritesPerTextChange: 16,
  /**
   * One /admin/delete per code: the hash-clearing UPDATE (1), the DELETE
   * (row, primary key and ≤ 6 index entries), FTS 'delete' (2.92 measured).
   */
  writesPerDelete: 12,
});

/** The schema 0006 must have left behind, as /admin/hashes reports it. */
export const REQUIRED_SCHEMA = 6;

/**
 * @typedef {NormalisedModule & { rowHash: string }} HashedModule
 * @typedef {{ textHash: string, rowHash: string | null }} StoredHashes
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, missingTriggers?: string[],
 *   rowHashColumn: boolean, ok: boolean,
 * }} SchemaStatus
 * @typedef {{
 *   schema: SchemaStatus, embeddingModel?: string, acadYears?: Record<string, number> | null,
 *   modules: Record<string, StoredHashes> | null,
 * }} HashesResponse
 * @typedef {{ status: number, body: any }} ApiResponse
 * @typedef {{
 *   get: (path: string) => Promise<ApiResponse>,
 *   post: (path: string, body: unknown) => Promise<ApiResponse>,
 * }} AdminApi
 * @typedef {{
 *   read: () => Promise<string | null>,
 *   write: (mutationId: string | null) => Promise<void>,
 * }} PendingMutationStore The last Vectorize mutation id sent and not yet seen
 *   processed. Survives the run (scripts/ingest.mjs: .data/ingest-state.json),
 *   so a rerun with nothing to send still waits for it.
 * @typedef {{
 *   force?: boolean, from?: string | null, batchSize?: number, concurrency?: number, writeBudget?: number,
 *   allowMassDelete?: boolean, allowYearChange?: boolean, deleteBatchSize?: number, massDeleteRatio?: number,
 *   maxAttempts?: number, waitTimeoutMs?: number, waitIntervalMs?: number, embeddingModel?: string | null,
 *   writesPerInsert?: number, writesPerUpdate?: number, ftsWritesPerInsert?: number,
 *   ftsWritesPerTextChange?: number, writesPerDelete?: number,
 * }} IngestOptions
 * @typedef {'done' | 'refused' | 'failed' | 'budget' | 'wait-timeout'} IngestStatus
 * @typedef {{
 *   status: IngestStatus, message: string,
 *   plan: { embed: number, rowOnly: number, unchanged: number, deletes: number },
 *   upserted: number, embedded: number, failed: number, deleted: number,
 *   rowsRead: number, rowsWritten: number, rowsCharged: number, resumeFrom: string | null,
 *   lastMutationId: string | null, dataVersion: string | null,
 * }} IngestResult `rowsWritten` sums D1's meta.rows_written; `rowsCharged`
 *   is what the write budget counts (per batch, the larger of that and the
 *   estimate).
 * @typedef {'insert' | 'text' | 'row'} WriteKind what an upsert does to D1:
 *   inserts a row, changes its embedded text (and so, possibly, its FTS
 *   entry), or rewrites it with the same text
 */

/** @returns {PendingMutationStore} one that lasts as long as the run */
export function memoryPendingStore() {
  /** @type {string | null} */
  let id = null;
  return { read: async () => id, write: async (next) => { id = next; } };
}

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
 * What an upsert of `m` does to D1, for the write estimate.
 * @param {{ code: string, textHash: string }} m
 * @param {Record<string, StoredHashes>} stored
 * @returns {WriteKind}
 */
export function writeKind(m, stored) {
  const s = stored[m.code];
  if (!s) return 'insert';
  return s.textHash === m.textHash ? 'row' : 'text';
}

/**
 * @param {{
 *   modules: NormalisedModule[], facetsBody: unknown, api: AdminApi, options?: IngestOptions,
 *   pending?: PendingMutationStore,
 *   log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} args
 * @returns {Promise<IngestResult>}
 */
export async function runIngest({
  modules, facetsBody, api, options = {}, pending = memoryPendingStore(), log = () => {}, sleep = defaultSleep, now = Date.now,
}) {
  const o = { ...DEFAULTS, force: false, from: null, allowMassDelete: false, allowYearChange: false, embeddingModel: null, ...options };
  /** @type {IngestResult} */
  const result = {
    status: 'done', message: '', plan: { embed: 0, rowOnly: 0, unchanged: 0, deletes: 0 },
    upserted: 0, embedded: 0, failed: 0, deleted: 0, rowsRead: 0, rowsWritten: 0, rowsCharged: 0,
    resumeFrom: null, lastMutationId: null, dataVersion: null,
  };
  /** Writes of `pending`, in the order the mutation ids arrived. */
  /** @type {Promise<void>} */
  let persisted = Promise.resolve();
  /** Records a mutation id the moment Vectorize accepts it. @param {string} id */
  const sent = (id) => {
    result.lastMutationId = id;
    persisted = persisted.then(() => pending.write(id));
  };
  /** @param {IngestStatus} status @param {string} message */
  const stop = async (status, message) => {
    await persisted;
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
  const d1Count = Object.keys(stored).length;

  const years = [...new Set(modules.map((m) => m.acadYear))];
  if (years.length !== 1) return stop('refused', `The corpus mixes acad years (${years.join(', ')}); one database holds one year.`);
  const seen = new Set();
  const dupes = modules.filter((m) => (seen.has(m.code) ? true : (seen.add(m.code), false))).map((m) => m.code);
  if (dupes.length) return stop('refused', `Duplicate module codes in the corpus: ${dupes.slice(0, 10).join(', ')}.`);
  // The year D1 holds is the one most of its rows carry: stray rows of another
  // year are cleaned up (deleted or rewritten) by a run for D1's own year, but
  // a run for another year would rewrite the database to it. An empty
  // database holds no year, so any year loads into it.
  if (d1Count > 0 && (hashes.acadYears === null || typeof hashes.acadYears !== 'object')) {
    return stop('refused', 'GET /admin/hashes reports no acadYears: the Worker is older than this script. Nothing was written.');
  }
  const d1Years = Object.entries(hashes.acadYears ?? {}).sort(([, a], [, b]) => b - a);
  const heldYear = d1Years.length && (d1Years.length === 1 || d1Years[0][1] > d1Years[1][1]) ? d1Years[0][0] : null;
  if (d1Years.length && heldYear !== years[0] && !o.allowYearChange) {
    return stop('refused', `The corpus is for ${years[0]} but D1 holds `
      + `${d1Years.map(([y, n]) => `${y} (${n} rows)`).join(', ')}. Nothing was written. `
      + 'Ingesting would rewrite the database to the corpus year. If that is the intent, rerun with --allow-year-change.');
  }

  // 2. Plan.
  /** @type {HashedModule[]} */
  const hashed = await Promise.all(modules.map(async (m) => ({ ...m, rowHash: await rowHash(m) })));
  const plan = planIngest(hashed, stored, { force: o.force });
  result.plan = { embed: plan.embed.length, rowOnly: plan.rowOnly.length, unchanged: plan.unchanged, deletes: plan.deletes.length };
  log(`plan               ${plan.embed.length} to embed, ${plan.rowOnly.length} row-only, ${plan.unchanged} unchanged, ${plan.deletes.length} to delete`);
  // By what it removes, not by corpus size: a same-size corpus of other codes
  // deletes everything.
  if (d1Count > 0 && d1Count - plan.deletes.length < o.massDeleteRatio * d1Count && !o.allowMassDelete) {
    return stop('refused', `The corpus offers ${modules.length} modules and would delete ${plan.deletes.length} of the ${d1Count} modules D1 holds `
      + `(${((plan.deletes.length / d1Count) * 100).toFixed(1)}% > ${((1 - o.massDeleteRatio) * 100).toFixed(0)}%). Nothing was written. `
      + 'If the drop is real, rerun with --allow-mass-delete.');
  }

  // In code order, so a run stopped by the budget resumes from one code.
  /** @typedef {HashedModule & { reembed: boolean }} WorkItem */
  /** @type {WorkItem[]} */
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
  /** @type {WorkItem[][]} */
  const batches = [];
  for (let i = 0; i < work.length; i += o.batchSize) batches.push(work.slice(i, i + o.batchSize));

  // 3. Upserts inside the write budget.
  /** @type {Record<WriteKind, number>} */
  const perModule = {
    insert: o.writesPerInsert + o.ftsWritesPerInsert,
    text: o.writesPerUpdate + o.ftsWritesPerTextChange,
    row: o.writesPerUpdate,
  };
  /** @param {WorkItem[]} batch the estimated rows written, FTS shadow tables included */
  const estimateBatch = (batch) => Math.ceil(batch.reduce((n, m) => n + perModule[writeKind(m, stored)], 0));
  let reserved = 0;
  /** Highest meta.rows_written per module any batch has reported; null before the first. */
  /** @type {number | null} */
  let maxRate = null;
  let budgetHit = false;
  /**
   * Holds budget for a request: its estimate, or more if a batch of this run
   * has reported a higher per-module rate than the estimate assumes.
   * @param {number} estimate @param {number} rows @returns {number | null} the reservation, or null if over budget
   */
  const reserve = (estimate, rows) => {
    const need = Math.max(estimate, Math.ceil(rows * (maxRate ?? 0)));
    if (result.rowsCharged + reserved + need > o.writeBudget) return null;
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
  /**
   * Remote D1 may bill writes meta.rows_written leaves out (FTS5 shadow
   * tables), so the budget counts whichever is larger.
   * @param {any} body @param {number} estimate
   */
  const account = (body, estimate) => {
    const written = Number(body?.meta?.rows_written ?? 0);
    result.rowsRead += Number(body?.meta?.rows_read ?? 0);
    result.rowsWritten += written;
    result.rowsCharged += Math.max(written, estimate);
  };

  /** @param {WorkItem[]} batch @param {number} estimate @param {number} held */
  const upsertBatch = async (batch, estimate, held) => {
    // rowHash travels along but the Worker recomputes it from what it binds.
    const body = await send('/admin/ingest', { modules: batch }, `batch ${batch[0].code}…`);
    reserved -= held;
    if (!body) { result.failed += batch.length; return; }
    account(body, estimate);
    const rate = Number(body?.meta?.rows_written ?? 0) / batch.length;
    maxRate = maxRate === null ? rate : Math.max(maxRate, rate);
    result.upserted += Number(body.upserted ?? batch.length);
    result.embedded += Number(body.embedded ?? 0);
    if (body.mutationId) sent(String(body.mutationId));
  };

  const queue = batches.slice(0, -1);
  const tail = batches.at(-1);
  /** @type {string | null} */
  let firstUnsent = null;
  const started = now();
  const progress = () => log(`  ${result.upserted + result.failed}/${work.length}  charged ${result.rowsCharged} `
    + `(D1 reported ${result.rowsWritten})  failed ${result.failed}  ${((now() - started) / 1000).toFixed(0)}s`);
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    while (queue.length && !budgetHit) {
      const batch = /** @type {WorkItem[]} */ (queue[0]);
      const estimate = estimateBatch(batch);
      const held = reserve(estimate, batch.length);
      if (held === null) { budgetHit = true; firstUnsent = batch[0].code; break; }
      queue.shift();
      await upsertBatch(batch, estimate, held);
      progress();
    }
  }));
  if (tail && !budgetHit) {
    const estimate = estimateBatch(tail);
    const held = reserve(estimate, tail.length);
    if (held === null) { budgetHit = true; firstUnsent = tail[0].code; }
    else { await upsertBatch(tail, estimate, held); progress(); }
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
    return stop('budget', `Write budget: the next batch would take rows charged past --write-budget ${o.writeBudget} `
      + `(${result.rowsCharged} charged so far, ${result.rowsWritten} reported by D1). Stopped cleanly: `
      + `${result.upserted} of ${work.length} modules upserted, `
      + 'no deletes run, src/data-version.json not written. To resume, rerun the same command '
      + `${o.force ? `with --from ${firstUnsent} ` : ''}once the day's D1 write headroom allows `
      + `(the hash skip sends only what is still pending${o.force ? '; --force alone would start over' : ''}).`);
  }
  if (result.failed > 0) {
    if (result.upserted > 0) await facets();
    return stop('failed', `${result.failed} modules failed; deletes skipped. Rerun the same command: the hash skip retries only what failed.`);
  }

  // 4. Deletes, last, one request at a time (inside /admin/delete: hashes
  // cleared, Vectorize, then D1).
  for (let i = 0; i < plan.deletes.length; i += o.deleteBatchSize) {
    const codes = plan.deletes.slice(i, i + o.deleteBatchSize);
    const estimate = Math.ceil(codes.length * o.writesPerDelete);
    const held = reserve(estimate, codes.length);
    if (held === null) {
      result.resumeFrom = codes[0];
      await facets();
      return stop('budget', `Write budget reached before deleting ${plan.deletes.length - result.deleted} modules `
        + `(${result.rowsCharged} rows charged). Rerun the same command to finish the deletes.`);
    }
    const body = await send('/admin/delete', { codes }, `delete ${codes[0]}…`);
    reserved -= held;
    if (!body) {
      await facets();
      return stop('failed', `Deleting ${codes.length} modules from ${codes[0]} failed; rerun the same command.`);
    }
    account(body, estimate);
    result.deleted += Number(body.deleted ?? 0);
    if (body.mutationId) sent(String(body.mutationId));
  }
  if (plan.deletes.length) log(`deleted            ${result.deleted} (${plan.deletes.slice(0, 10).join(', ')}${plan.deletes.length > 10 ? ', …' : ''})`);

  // 5. Facets (always: the NG list date can change with no row changing), the
  // Vectorize mutation wait, the data version. Vectorize processes mutations
  // in order, so this run's last one covers any older pending one; a run that
  // sent nothing waits for the one an earlier run left unconfirmed.
  await facets();
  await persisted;
  const target = result.lastMutationId ?? await pending.read();
  if (target) {
    result.lastMutationId = target;
    const waited = await waitForMutation(api, target, { timeoutMs: o.waitTimeoutMs, intervalMs: o.waitIntervalMs, sleep, now, log });
    if (!waited) {
      return stop('wait-timeout', `Vectorize had not processed mutation ${target} after ${o.waitTimeoutMs / 1000}s. `
        + 'D1 is complete; rerun the same command once `wrangler vectorize info` shows it: with nothing left to send, '
        + 'it waits for that mutation and then writes the data version. Run npm run verify after.');
    }
    await pending.write(null);
  }
  result.dataVersion = await dataVersion(hashed);
  return stop('done', `done               ${result.upserted} upserted (${result.embedded} embedded), ${result.deleted} deleted, `
    + `${result.rowsRead} rows read, ${result.rowsCharged} rows charged (${result.rowsWritten} reported by D1); `
    + `data version ${result.dataVersion}`);
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
    ...(schema.missingTriggers?.length ? [`the triggers ${schema.missingTriggers.join(', ')}`] : []),
    ...(schema.rowHashColumn ? [] : ['the modules.row_hash column']),
  ];
  return `Refusing to ingest: the target database lacks migration 0006 (${missing.join('; ')}). `
    + 'Rewriting rows through the pre-0006 FTS triggers reads ~46M rows for a full re-ingest (FINDINGS B3), '
    + 'and without all four 0006 triggers the FTS index drifts from modules. '
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
