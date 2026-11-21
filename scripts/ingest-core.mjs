// @ts-check
import { catalogueRowHash, dataVersion, ftsHash, rowHash } from '../src/rowhash.js';

export const DEFAULTS = Object.freeze({
  batchSize: 50,
  concurrency: 4,
  writeBudget: 40_000,
  deleteBatchSize: 100,
  massDeleteRatio: 0.95,
  maxAttempts: 5,
  waitTimeoutMs: 10 * 60_000,
  waitIntervalMs: 5_000,
  writesPerInsert: 8,
  writesPerUpdate: 5.5,
  ftsWritesPerInsert: 14,
  ftsWritesPerTextChange: 16,
  writesPerDelete: 12,
  writesPerCatalogueRow: 2,
  catalogueBatchSize: 100,
});

export const REQUIRED_SCHEMA = 6;

/**
 * @typedef {NormalisedModule & { rowHash: string, ftsHash: string }} HashedModule
 * @typedef {{ textHash: string, rowHash: string | null, ftsHash?: string }} StoredHashes
 * @typedef {{
 *   version: number | null, ftsExternal: boolean, rowidTriggers: boolean, missingTriggers?: string[],
 *   rowHashColumn: boolean, missingColumns?: string[], ok: boolean,
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
 * @typedef {{ id: string, sentAt: number | null, earlier?: string[] }} PendingMutation
 * @typedef {{
 *   read: () => Promise<PendingMutation | null>,
 *   write: (mutation: PendingMutation | null) => Promise<void>,
 * }} PendingMutationStore
 * @typedef {{
 *   force?: boolean, from?: string | null, batchSize?: number, concurrency?: number, writeBudget?: number,
 *   allowMassDelete?: boolean, allowYearChange?: boolean, deleteBatchSize?: number, massDeleteRatio?: number,
 *   maxAttempts?: number, waitTimeoutMs?: number, waitIntervalMs?: number, embeddingModel?: string | null,
 *   writesPerInsert?: number, writesPerUpdate?: number, ftsWritesPerInsert?: number,
 *   ftsWritesPerTextChange?: number, writesPerDelete?: number, writesPerCatalogueRow?: number,
 *   catalogueBatchSize?: number, signal?: AbortSignal,
 *   d1Only?: boolean, expectedDataVersion?: string | null,
 * }} IngestOptions
 * @typedef {'done' | 'refused' | 'failed' | 'budget' | 'wait-timeout' | 'interrupted'} IngestStatus
 * @typedef {{
 *   status: IngestStatus, message: string,
 *   plan: { embed: number, rowOnly: number, unchanged: number, deletes: number },
 *   upserted: number, embedded: number, failed: number, deleted: number,
 *   rowsRead: number, rowsWritten: number, rowsCharged: number, resumeFrom: string | null,
 *   lastMutationId: string | null, dataVersion: string | null, deletedCodes: string[],
 *   catalogue: { upserted: number, deleted: number } | null,
 * }} IngestResult
 * @typedef {'insert' | 'fts' | 'row'} WriteKind
 */

/** @returns {PendingMutationStore} */
export function memoryPendingStore() {
  /** @type {PendingMutation | null} */
  let p = null;
  return { read: async () => p, write: async (next) => { p = next; } };
}

/**
 * @template {{ code: string, textHash: string, rowHash: string }} M
 * @param {M[]} modules
 * @param {Record<string, StoredHashes>} stored
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
 * @param {{ code: string, textHash: string, ftsHash: string }} m
 * @param {Record<string, StoredHashes>} stored
 * @returns {WriteKind}
 */
export function writeKind(m, stored) {
  const s = stored[m.code];
  if (!s) return 'insert';
  const ftsChanged = typeof s.ftsHash === 'string' ? s.ftsHash !== m.ftsHash : s.textHash !== m.textHash;
  return ftsChanged ? 'fts' : 'row';
}

/**
 * @param {{
 *   modules: NormalisedModule[], facetsBody: unknown, api: AdminApi, options?: IngestOptions,
 *   pending?: PendingMutationStore, catalogue?: { code: string, title: string, description: string | null }[],
 *   log?: (line: string) => void, sleep?: (ms: number) => Promise<void>, now?: () => number,
 * }} args
 * @returns {Promise<IngestResult>}
 */
export async function runIngest({
  modules, facetsBody, api, options = {}, pending = memoryPendingStore(), log = () => {}, sleep = defaultSleep, now = Date.now,
  catalogue,
}) {
  const o = {
    ...DEFAULTS, force: false, from: null, allowMassDelete: false, allowYearChange: false, embeddingModel: null,
    d1Only: false, expectedDataVersion: null, ...options,
  };
  const mode = o.d1Only ? '?d1Only=1' : '';
  /** @type {IngestResult} */
  const result = {
    status: 'done', message: '', plan: { embed: 0, rowOnly: 0, unchanged: 0, deletes: 0 },
    upserted: 0, embedded: 0, failed: 0, deleted: 0, rowsRead: 0, rowsWritten: 0, rowsCharged: 0,
    resumeFrom: null, lastMutationId: null, dataVersion: null, deletedCodes: [], catalogue: null,
  };
  /** @type {Promise<void>} */
  let persisted = Promise.resolve();
  /** @type {PendingMutation | null} */
  let last = null;
  const carried = o.d1Only ? null : await pending.read().catch(() => null);
  /** @type {string[]} */
  const ownIds = carried ? [...(carried.earlier ?? []), carried.id] : [];
  let idOnly = carried !== null && carried.sentAt === null;
  const aborted = () => o.signal?.aborted === true;
  /** @type {{ ids: string[], error: string | null }} */
  const unrecorded = { ids: [], error: null };
  /**
   * @param {string} id
   * @param {unknown} sentAt
   */
  const sent = (id, sentAt) => {
    const p = { id, sentAt: !idOnly && typeof sentAt === 'number' && Number.isFinite(sentAt) ? sentAt : null, earlier: [...ownIds] };
    ownIds.push(id);
    if (ownIds.length > MAX_OWN_IDS) ownIds.splice(0, ownIds.length - MAX_OWN_IDS);
    result.lastMutationId = id;
    last = p;
    persisted = persisted.then(() => pending.write(p)).catch((err) => {
      unrecorded.ids.push(id);
      unrecorded.error = /** @type {Error} */ (err)?.message ?? String(err);
      log(`  could not record mutation ${id} in the pending store: ${unrecorded.error}`);
    });
  };
  const markIdOnly = () => {
    if (idOnly) return;
    idOnly = true;
    if (last) {
      const p = { ...last, sentAt: null };
      last = p;
      persisted = persisted.then(() => pending.write(p)).catch((err) => {
        unrecorded.ids.push(p.id);
        unrecorded.error = /** @type {Error} */ (err)?.message ?? String(err);
        log(`  could not record mutation ${p.id} in the pending store: ${unrecorded.error}`);
      });
    }
  };
  const unrecordedNote = () => (unrecorded.ids.length
    ? ` Could not record Vectorize mutation${unrecorded.ids.length === 1 ? '' : 's'} ${unrecorded.ids.join(', ')} `
      + `in the pending store (${unrecorded.error}), so a rerun cannot wait for ${unrecorded.ids.length === 1 ? 'it' : 'them'}: `
      + `fix the state file, wait until \`wrangler vectorize info\` reports processedUpToMutation ${unrecorded.ids.at(-1)} `
      + '(or a processedUpToDatetime after it was sent), then rerun the same command.'
    : '');
  /** @param {IngestStatus} status @param {string} message */
  const stop = async (status, message) => {
    await persisted;
    result.status = status;
    result.message = message + unrecordedNote();
    log(result.message);
    return result;
  };

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

  /** @type {Record<string, string> | null} */
  let catalogueStored = null;
  if (catalogue) {
    const res = await api.get('/admin/catalogue');
    if (res.status !== 200 || res.body?.ok !== true || !res.body.rows || typeof res.body.rows !== 'object') {
      return stop('refused', res.status === 200
        ? 'D1 has no catalogue_only table: apply migration 0008 (migrations/0008_catalogue.sql) first. Nothing was written.'
        : `GET /admin/catalogue -> HTTP ${res.status}: the Worker is older than this script (no catalogue routes). Nothing was written.`);
    }
    catalogueStored = /** @type {Record<string, string>} */ (res.body.rows);
  }

  /** @type {HashedModule[]} */
  const hashed = await Promise.all(modules.map(async (m) => ({ ...m, rowHash: await rowHash(m), ftsHash: await ftsHash(m) })));
  if (o.d1Only) {
    const computed = await dataVersion(hashed);
    if (!o.expectedDataVersion) {
      return stop('refused', 'A D1-only run needs the committed data version (src/data-version.json) to check against. Nothing was written.');
    }
    if (computed !== o.expectedDataVersion) {
      return stop('refused', `D1-only: the corpus has data version ${computed}, but src/data-version.json says ${o.expectedDataVersion}. `
        + 'The rows this run would write are not the ones runbook step 1 merged. Nothing was written.');
    }
  }
  const plan = planIngest(hashed, stored, { force: o.force });
  result.plan = { embed: plan.embed.length, rowOnly: plan.rowOnly.length, unchanged: plan.unchanged, deletes: plan.deletes.length };
  log(`plan               ${plan.embed.length} to embed, ${plan.rowOnly.length} row-only, ${plan.unchanged} unchanged, ${plan.deletes.length} to delete`);
  if (d1Count > 0 && d1Count - plan.deletes.length < o.massDeleteRatio * d1Count && !o.allowMassDelete) {
    return stop('refused', `The corpus offers ${modules.length} modules and would delete ${plan.deletes.length} of the ${d1Count} modules D1 holds `
      + `(${((plan.deletes.length / d1Count) * 100).toFixed(1)}% > ${((1 - o.massDeleteRatio) * 100).toFixed(0)}%). Nothing was written. `
      + 'If the drop is real, rerun with --allow-mass-delete.');
  }
  if (catalogue && catalogueStored && !o.allowMassDelete) {
    const held = Object.keys(catalogueStored);
    const keep = new Set(catalogue.map((r) => r.code));
    const drops = held.filter((c) => !keep.has(c)).length;
    if (held.length > 0 && held.length - drops < o.massDeleteRatio * held.length) {
      return stop('refused', `catalogue_only: the corpus has ${catalogue.length} catalogue-only codes and would delete ${drops} of the ${held.length} D1 holds `
        + `(${((drops / held.length) * 100).toFixed(1)}% > ${((1 - o.massDeleteRatio) * 100).toFixed(0)}%). Nothing was written. `
        + 'If the drop is real, rerun with --allow-mass-delete.');
    }
  }

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

  /** @type {Record<WriteKind, number>} */
  const perModule = {
    insert: o.writesPerInsert + o.ftsWritesPerInsert,
    fts: o.writesPerUpdate + o.ftsWritesPerTextChange,
    row: o.writesPerUpdate,
  };
  /** @param {WorkItem[]} batch */
  const estimateBatch = (batch) => Math.ceil(batch.reduce((n, m) => n + perModule[writeKind(m, stored)], 0));
  let reserved = 0;
  /** @type {number | null} */
  let maxRate = null;
  let budgetHit = false;
  /**
   * @param {number} estimate
   * @param {number} rows
   * @returns {number | null}
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
      if (res.status >= 500 && !o.d1Only && (path === '/admin/ingest' || path === '/admin/delete')) markIdOnly();
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
   * @param {any} body
   * @param {number} estimate
   */
  const account = (body, estimate) => {
    const written = Number(body?.meta?.rows_written ?? 0);
    result.rowsRead += Number(body?.meta?.rows_read ?? 0);
    result.rowsWritten += written;
    result.rowsCharged += Math.max(written, estimate);
  };

  /** @param {WorkItem[]} batch @param {number} estimate @param {number} held */
  const upsertBatch = async (batch, estimate, held) => {
    const body = await send(`/admin/ingest${mode}`, { modules: batch }, `batch ${batch[0].code}…`);
    reserved -= held;
    if (!body) { result.failed += batch.length; return; }
    account(body, estimate);
    const rate = Number(body?.meta?.rows_written ?? 0) / batch.length;
    maxRate = maxRate === null ? rate : Math.max(maxRate, rate);
    result.upserted += Number(body.upserted ?? batch.length);
    result.embedded += Number(body.embedded ?? 0);
    if (body.mutationId) sent(String(body.mutationId), body.sentAt);
  };

  const queue = batches.slice(0, -1);
  const tail = batches.at(-1);
  /** @type {string | null} */
  let firstUnsent = null;
  const started = now();
  const progress = () => log(`  ${result.upserted + result.failed}/${work.length}  charged ${result.rowsCharged} `
    + `(D1 reported ${result.rowsWritten})  failed ${result.failed}  ${((now() - started) / 1000).toFixed(0)}s`);
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, async () => {
    while (queue.length && !budgetHit && !aborted()) {
      const batch = /** @type {WorkItem[]} */ (queue[0]);
      const estimate = estimateBatch(batch);
      const held = reserve(estimate, batch.length);
      if (held === null) { budgetHit = true; firstUnsent = batch[0].code; break; }
      queue.shift();
      await upsertBatch(batch, estimate, held);
      progress();
    }
  }));
  if (tail && !budgetHit && !aborted()) {
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

  /** @param {string} where */
  const interrupted = (where) => stop('interrupted', `Interrupted ${where}: ${result.upserted} of ${work.length} modules upserted, `
    + `${result.deleted} deleted; every Vectorize mutation sent is in the pending store and src/data-version.json was not written. `
    + `Rerun the same command${o.force && result.resumeFrom ? ` with --from ${result.resumeFrom}` : ''}: the hash skip sends only `
    + 'what is still pending, and it waits for those mutations.');
  if (aborted() && !budgetHit) {
    const unsent = queue[0] ?? (result.upserted + result.failed < work.length ? tail : undefined);
    result.resumeFrom = unsent?.[0]?.code ?? null;
    return interrupted('during the upserts');
  }

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

  for (let i = 0; i < plan.deletes.length; i += o.deleteBatchSize) {
    const codes = plan.deletes.slice(i, i + o.deleteBatchSize);
    if (aborted()) return interrupted('during the deletes');
    const estimate = Math.ceil(codes.length * o.writesPerDelete);
    const held = reserve(estimate, codes.length);
    if (held === null) {
      result.resumeFrom = codes[0];
      await facets();
      return stop('budget', `Write budget reached before deleting ${plan.deletes.length - result.deleted} modules `
        + `(${result.rowsCharged} rows charged). Rerun the same command to finish the deletes.`);
    }
    const body = await send(`/admin/delete${mode}`, { codes }, `delete ${codes[0]}…`);
    reserved -= held;
    if (!body) {
      await facets();
      return stop('failed', `Deleting ${codes.length} modules from ${codes[0]} failed; rerun the same command.`);
    }
    account(body, estimate);
    result.deleted += Number(body.deleted ?? 0);
    if (Array.isArray(body.codes)) result.deletedCodes.push(...body.codes.map(String));
    if (body.mutationId) sent(String(body.mutationId), body.sentAt);
  }
  if (plan.deletes.length) log(`deleted            ${result.deleted} (${plan.deletes.slice(0, 10).join(', ')}${plan.deletes.length > 10 ? ', …' : ''})`);

  if (catalogue && catalogueStored) {
    const have = catalogueStored;
    const year = years[0];
    const want = await Promise.all(catalogue.map(async (r) => {
      const row = { code: r.code, title: r.title, description: r.description ?? null, acadYear: year };
      return { row, hash: await catalogueRowHash(row) };
    }));
    const keep = new Set(want.map((w) => w.row.code));
    const upserts = want.filter((w) => have[w.row.code] !== w.hash).map((w) => w.row)
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const drops = Object.keys(have).filter((c) => !keep.has(c)).sort();
    result.catalogue = { upserted: 0, deleted: 0 };
    /** @type {{ upsert: typeof upserts, delete: string[] }[]} */
    const calls = [];
    for (let i = 0; i < upserts.length; i += o.catalogueBatchSize) calls.push({ upsert: upserts.slice(i, i + o.catalogueBatchSize), delete: [] });
    for (let i = 0; i < drops.length; i += o.catalogueBatchSize) calls.push({ upsert: [], delete: drops.slice(i, i + o.catalogueBatchSize) });
    for (const call of calls) {
      if (aborted()) return interrupted('loading catalogue_only');
      const n = call.upsert.length + call.delete.length;
      const estimate = Math.ceil(n * o.writesPerCatalogueRow);
      const held = reserve(estimate, 0);
      if (held === null) {
        await facets();
        return stop('budget', `Write budget reached loading catalogue_only (${result.catalogue.upserted} of ${upserts.length} rows written, `
          + `${result.catalogue.deleted} of ${drops.length} deleted; ${result.rowsCharged} rows charged). Rerun the same command to finish: `
          + 'only rows still different are sent.');
      }
      const body = await send('/admin/catalogue', call, `catalogue ${call.upsert[0]?.code ?? call.delete[0]}…`);
      reserved -= held;
      if (!body) {
        await facets();
        return stop('failed', 'Loading catalogue_only failed; rerun the same command (only rows still different are sent).');
      }
      account(body, estimate);
      result.catalogue.upserted += Number(body.upserted ?? 0);
      result.catalogue.deleted += Number(body.deleted ?? 0);
    }
    log(`catalogue_only     ${result.catalogue.upserted} written, ${result.catalogue.deleted} deleted, ${want.length - upserts.length} unchanged`);
  }

  await facets();
  await persisted;
  if (o.d1Only) {
    result.dataVersion = await dataVersion(hashed);
    return stop('done', `done (D1 only)     ${result.upserted} rows written, ${result.deleted} deleted, `
      + `${result.rowsRead} rows read, ${result.rowsCharged} rows charged (${result.rowsWritten} reported by D1); `
      + `data version ${result.dataVersion} = src/data-version.json; no Vectorize or Workers AI call`);
  }
  if (unrecorded.ids.length) {
    return stop('failed', `D1 and Vectorize writes are complete (${result.upserted} upserted, ${result.deleted} deleted), `
      + 'but src/data-version.json was not written.');
  }
  /** @type {PendingMutation | null} */
  let target = last;
  if (!target) {
    try {
      target = await pending.read();
    } catch (err) {
      return stop('failed', `Could not read the pending store (${/** @type {Error} */ (err).message}), so whether an earlier `
        + 'run left a Vectorize mutation unconfirmed is unknown; src/data-version.json was not written. Fix the state file and rerun.');
    }
  }
  if (target) {
    result.lastMutationId = target.id;
    const waited = await waitForMutation(api, target, { timeoutMs: o.waitTimeoutMs, intervalMs: o.waitIntervalMs, sleep, now, log, signal: o.signal });
    if (!waited && aborted()) return interrupted(`waiting for Vectorize mutation ${target.id}`);
    if (!waited) {
      return stop('wait-timeout', `Vectorize had not processed mutation ${target.id} after ${o.waitTimeoutMs / 1000}s. `
        + 'D1 is complete; rerun the same command once `wrangler vectorize info` shows it: with nothing left to send, '
        + 'it waits for that mutation and then writes the data version. Run npm run verify after.');
    }
    await pending.write(null).catch((err) => log(`  could not clear the pending store: ${/** @type {Error} */ (err).message}`));
  }
  result.dataVersion = await dataVersion(hashed);
  return stop('done', `done               ${result.upserted} upserted (${result.embedded} embedded), ${result.deleted} deleted, `
    + `${result.rowsRead} rows read, ${result.rowsCharged} rows charged (${result.rowsWritten} reported by D1); `
    + `data version ${result.dataVersion}`);
}

const COLUMN_MIGRATIONS = Object.freeze({
  ng_allow: '0009_exchange.sql', ng_rules: '0009_exchange.sql', exam_dates: '0010_exam_dates.sql',
});

/** @param {string[]} columns */
function migrationsFor(columns) {
  /** @type {Map<string, string[]>} */
  const by = new Map();
  for (const c of columns) {
    const file = /** @type {Record<string, string>} */ (COLUMN_MIGRATIONS)[c] ?? 'the migration that adds it';
    by.set(file, [...(by.get(file) ?? []), c]);
  }
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([file, cols]) => `${file.endsWith('.sql') ? `migrations/${file}` : file} for ${cols.join(', ')}`).join('; ');
}

/** @param {SchemaStatus | undefined} schema */
export function describeSchemaProblem(schema) {
  if (schema?.ok && schema.missingColumns !== undefined) return null;
  const only0006 = schema && schema.version !== null && schema.version >= REQUIRED_SCHEMA && schema.ftsExternal
    && schema.rowidTriggers && !schema.missingTriggers?.length && schema.rowHashColumn;
  if (only0006) {
    return schema.missingColumns === undefined
      ? 'Refusing to ingest: the Worker reports no column check (is it older than this script?). Deploy it first.'
      : `Refusing to ingest: modules lacks the columns ${schema.missingColumns.join(', ')}. `
        + `Apply the migrations that add them first (${migrationsFor(schema.missingColumns)}), with scripts/remote-migration.mjs.`;
  }
  const missing = !schema ? ['a schema report (is the Worker older than this script?)'] : [
    ...(schema.version === null || schema.version < REQUIRED_SCHEMA ? [`meta('schema') >= ${REQUIRED_SCHEMA} (found ${schema.version ?? 'none'})`] : []),
    ...(schema.ftsExternal ? [] : ["external-content modules_fts (content='modules')"]),
    ...(schema.rowidTriggers ? [] : ['FTS triggers keyed on rowid']),
    ...(schema.missingTriggers?.length ? [`the triggers ${schema.missingTriggers.join(', ')}`] : []),
    ...(schema.rowHashColumn ? [] : ['the modules.row_hash column']),
  ];
  return `Refusing to ingest: the target database lacks migration 0006 (${missing.join('; ')}). `
    + 'Rewriting rows through the pre-0006 FTS triggers reads ~46M rows for a full re-ingest, '
    + 'and without all four 0006 triggers the FTS index drifts from modules. '
    + 'Apply migrations/0006_fts_external.sql first (ADR 0002).';
}

/** @param {unknown} v */
const epochMs = (v) => {
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/**
 * @param {AdminApi} api
 * @param {PendingMutation} target
 * @param {{ timeoutMs: number, intervalMs: number, sleep: (ms: number) => Promise<void>, now: () => number, log: (line: string) => void, signal?: AbortSignal }} o
 */
export async function waitForMutation(api, target, { timeoutMs, intervalMs, sleep, now, log, signal }) {
  const deadline = now() + timeoutMs;
  for (let polls = 1; ; polls++) {
    const res = await api.get('/admin/vectorize');
    const info = res.status === 200 ? res.body : null;
    const processed = info?.processedUpToMutation ?? null;
    const processedAt = epochMs(info?.processedUpToDatetime);
    const byId = processed !== null && String(processed) === target.id;
    const ours = processed !== null && (target.earlier ?? []).includes(String(processed));
    const byTime = target.sentAt !== null && processedAt !== null && processedAt > target.sentAt && !ours;
    if (byId || byTime) {
      const how = byId ? `up to ${target.id}` : `up to ${processed} at ${new Date(/** @type {number} */ (processedAt)).toISOString()}, `
        + `after ${target.id} was sent (${new Date(/** @type {number} */ (target.sentAt)).toISOString()})`;
      log(`vectorize          processed ${how} (${polls} poll${polls === 1 ? '' : 's'}, ${info.vectorCount} vectors)`);
      return true;
    }
    if (signal?.aborted || now() + intervalMs > deadline) return false;
    if (polls === 1) log(`vectorize          waiting for mutation ${target.id} (processed up to ${processed ?? 'unknown'})`);
    await sleep(intervalMs);
  }
}

const MAX_OWN_IDS = 2_000;

/** @param {number} ms */
const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
