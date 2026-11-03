// @ts-check
// FTS5 shadow-table writes per ingest operation, over the full pinned corpus,
// in node:sqlite (local D1's meta.rows_written does not see them; see
// 0006-cost.md). Quoted by ingest-cost.md; the per-module figures set the
// FTS terms of the write estimate in scripts/ingest-core.mjs.
//
//   node docs/evidence/phase1/fts-writes.mjs
//
// Method: migrations 0001–0006 into an in-memory database, then the exact
// statements /admin/ingest and /admin/delete run (src/ingest.js), in batches
// of 50 like `npm run ingest`. Each batch is one transaction, and its
// total_changes() delta counts every row inserted, updated or deleted,
// trigger and FTS5-internal statements included. FTS writes = that delta
// minus the same statements' delta on a twin database whose three FTS
// triggers are dropped (everything else identical), so the `modules` rows and
// the trigger statements themselves cancel out.
// Needs the pinned corpus in .data/ (scripts/pinned-corpus.mjs). No network.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { loadPinnedCorpus } from '../../../scripts/pinned-corpus.mjs';
import { ROW_COLUMNS, boundTuple, rowHash } from '../../../src/rowhash.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BATCH = 50;

/** The /admin/ingest upsert, verbatim apart from whitespace. */
const UPSERT = `INSERT INTO modules (${ROW_COLUMNS.join(', ')}, row_hash)
  VALUES (${ROW_COLUMNS.map(() => '?').join(',')},?)
  ON CONFLICT(code) DO UPDATE SET
    title=excluded.title, description=excluded.description, credits=excluded.credits,
    department=excluded.department, faculty=excluded.faculty, level=excluded.level,
    semesters=excluded.semesters, workload=excluded.workload,
    prerequisite=excluded.prerequisite, preclusion=excluded.preclusion,
    acad_year=excluded.acad_year, text_hash=excluded.text_hash,
    ng=excluded.ng, ng_semesters=excluded.ng_semesters, row_hash=excluded.row_hash`;

/** @param {boolean} ftsTriggers */
function open(ftsTriggers) {
  const db = new DatabaseSync(':memory:');
  const dir = join(ROOT, 'migrations');
  for (const f of readdirSync(dir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  if (!ftsTriggers) for (const t of ['modules_fts_insert', 'modules_fts_delete', 'modules_fts_update']) db.exec(`DROP TRIGGER ${t}`);
  return db;
}

/** @param {DatabaseSync} db */
const changes = (db) => Number(db.prepare('SELECT total_changes() AS c').get()?.c);

/**
 * Runs `step(db, batch)` per batch on both twins; FTS writes per batch.
 * @param {{ fts: DatabaseSync, bare: DatabaseSync }} dbs
 * @param {any[][]} batches
 * @param {(db: DatabaseSync, batch: any[]) => void} step
 */
function measure(dbs, batches, step) {
  const perBatch = batches.map((batch) => {
    /** @param {DatabaseSync} db */
    const delta = (db) => {
      const c0 = changes(db);
      db.exec('BEGIN');
      step(db, batch);
      db.exec('COMMIT');
      return changes(db) - c0;
    };
    const withFts = delta(dbs.fts);
    return { withFts, fts: withFts - delta(dbs.bare) };
  });
  const modules = batches.reduce((n, b) => n + b.length, 0);
  const fts = perBatch.reduce((n, b) => n + b.fts, 0);
  return {
    modules, ftsShadowWrites: fts, perModule: (fts / Math.max(modules, 1)).toFixed(2),
    maxFtsWritesInOneBatch: Math.max(0, ...perBatch.map((b) => b.fts)),
    totalChanges: perBatch.reduce((n, b) => n + b.withFts, 0),
  };
}

/** @template T @param {T[]} xs @returns {T[][]} */
const batched = (xs) => Array.from({ length: Math.ceil(xs.length / BATCH) }, (_, i) => xs.slice(i * BATCH, (i + 1) * BATCH));

/** @param {DatabaseSync} db @param {any[]} batch */
const upsert = (db, batch) => {
  const stmt = db.prepare(UPSERT);
  for (const m of batch) stmt.run(...boundTuple(m), m.rowHash);
};

const corpus = await loadPinnedCorpus();
const modules = await Promise.all(corpus.modules.map(async (m) => ({ ...m, rowHash: await rowHash(m) })));
const dbs = { fts: open(true), bare: open(false) };

const report = {
  // An empty 0006 database loaded through the ingest upsert.
  coldLoad: measure(dbs, batched(modules), upsert),
  // The planned remote run: every row re-posted with the same title and description.
  forcedReingest: measure(dbs, batched(modules), upsert),
  // A title change on every 10th module (the update trigger: FTS 'delete' + insert).
  titleChange: measure(dbs, batched(modules.filter((_, i) => i % 10 === 0).map((m) => ({ ...m, title: `${m.title} (revised)` }))), upsert),
  // /admin/delete: the hash-clearing UPDATE, then DELETE (the FTS delete trigger).
  delete: measure(dbs, batched(modules.filter((_, i) => i % 10 === 5).map((m) => m.code)), (db, codes) => {
    const marks = codes.map(() => '?').join(',');
    db.prepare(`UPDATE modules SET text_hash = '', row_hash = NULL WHERE code IN (${marks})`).run(...codes);
    db.prepare(`DELETE FROM modules WHERE code IN (${marks})`).run(...codes);
  }),
};
for (const db of Object.values(dbs)) db.close();
console.log(JSON.stringify(report));
