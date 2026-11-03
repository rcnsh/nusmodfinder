// @ts-check
// Writes (never runs) the SQL file for applying one migration to the remote D1
// with `wrangler d1 execute --remote --file` (ADR 0001, docs/plans/phase1.md r3).
//
//   node scripts/remote-migration.mjs 0006_fts_external [--bootstrap]
//
// Output: /tmp/vnm-remote-<name>.sql =
//   [--bootstrap] wrangler's d1_migrations DDL + INSERT OR IGNORE rows for the
//                 hand-applied 0001–0005,
//   the migration body, verbatim,
//   INSERT INTO d1_migrations(name) VALUES('<file>').
// Migration files stay clean (no d1_migrations insert) because local apply,
// applyD1Migrations and the rebuild check record the row themselves.
//
// Also prints an estimate of the rows the body writes, from a local run over
// the full pinned corpus in node:sqlite (total_changes() plus the entries of
// every index the body creates). Skipped with a note if .data/ is absent.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MIGRATIONS_DIR = join(ROOT, 'migrations');

/** Wrangler's own table DDL (cli.js `initMigrationsTable`), byte for byte. */
export const WRANGLER_MIGRATIONS_DDL =
  'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

/** Applied to production by hand before migration tracking existed (ADR 0001). */
export const BOOTSTRAP_APPLIED = ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql'];

/** @param {string} name `0006_fts_external` or `0006_fts_external.sql` */
export function migrationFile(name) {
  const file = name.endsWith('.sql') ? name : `${name}.sql`;
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`not a migration file name: ${name}`);
  return file;
}

/** @param {string} file */
export function outputPath(file) {
  return `/tmp/vnm-remote-${file.replace(/\.sql$/, '')}.sql`;
}

/**
 * The wrapper SQL. Pure, so the test can assert its exact structure.
 * @param {{ file: string, body: string, bootstrap: boolean }} opts
 */
export function remoteWrapper({ file, body, bootstrap }) {
  if (BOOTSTRAP_APPLIED.includes(file)) throw new Error(`${file} is one of the hand-applied migrations`);
  if (/d1_migrations/i.test(body.replace(/--[^\n]*/g, ''))) throw new Error(`${file} must not touch d1_migrations itself`);
  const parts = [];
  if (bootstrap) {
    parts.push(`${WRANGLER_MIGRATIONS_DDL};`);
    parts.push(`INSERT OR IGNORE INTO d1_migrations(name) VALUES ${BOOTSTRAP_APPLIED.map((f) => `('${f}')`).join(', ')};`);
  }
  parts.push(body.trimEnd());
  parts.push(`INSERT INTO d1_migrations(name) VALUES('${file}');`);
  return `${parts.join('\n')}\n`;
}

/**
 * Applies every migration before `file`, loads `modules`, then runs `file`
 * and counts what it wrote.
 * @param {string} file
 * @param {NormalisedModule[]} modules
 * @returns {Promise<{ totalChanges: number, indexEntries: Record<string, number>, rowsWritten: number }>}
 */
export async function estimateWrites(file, modules) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  const earlier = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < file).sort();
  for (const f of earlier) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  const cols = new Set(db.prepare('SELECT name FROM pragma_table_xinfo(\'modules\')').all().map((r) => String(r.name)));
  const insert = db.prepare(`INSERT INTO modules (code, title, description, credits, department, faculty, level,
      semesters, workload, prerequisite, preclusion, acad_year, text_hash${cols.has('ng') ? ', ng, ng_semesters' : ''})
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?${cols.has('ng') ? ',?,?' : ''})`);
  db.exec('BEGIN');
  for (const m of modules) {
    insert.run(m.code, m.title, m.description, m.credits, m.department, m.faculty, m.level,
      JSON.stringify(m.semesters), m.workload, m.prerequisite, m.preclusion, m.acadYear, m.textHash,
      ...(cols.has('ng') ? [m.ng ? 1 : 0, JSON.stringify(m.ngSemesters ?? [])] : []));
  }
  db.exec('COMMIT');

  const indexes = () => new Map(db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all()
    .map((r) => [String(r.name), { tbl: String(r.tbl_name), sql: String(r.sql) }]));
  const before = indexes();
  const changes = () => Number(db.prepare('SELECT total_changes() AS c').get()?.c);
  const c0 = changes();
  db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  const totalChanges = changes() - c0;

  // CREATE INDEX is not DML, so total_changes() misses its entries; D1 bills
  // them as rows written. Count each new index's rows (partial: its WHERE).
  /** @type {Record<string, number>} */
  const indexEntries = {};
  for (const [name, { tbl, sql }] of indexes()) {
    if (before.has(name)) continue;
    const where = sql.match(/\bWHERE\b([\s\S]*)$/i)?.[1];
    indexEntries[name] = Number(db.prepare(`SELECT count(*) AS n FROM "${tbl}"${where ? ` WHERE ${where}` : ''}`).get()?.n);
  }
  db.close();
  const rowsWritten = totalChanges + Object.values(indexEntries).reduce((a, b) => a + b, 0);
  return { totalChanges, indexEntries, rowsWritten };
}

async function main() {
  const args = process.argv.slice(2);
  const bootstrap = args.includes('--bootstrap');
  const names = args.filter((a) => !a.startsWith('--'));
  if (names.length !== 1) {
    console.error('usage: node scripts/remote-migration.mjs <migration name> [--bootstrap]');
    process.exit(2);
  }
  const file = migrationFile(names[0]);
  const body = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const out = outputPath(file);
  writeFileSync(out, remoteWrapper({ file, body, bootstrap }));
  console.log(`wrote ${out} (${bootstrap ? 'with' : 'without'} d1_migrations bootstrap); not executed`);

  let modules;
  try {
    const { loadPinnedCorpus } = await import('./pinned-corpus.mjs');
    modules = (await loadPinnedCorpus()).modules;
  } catch (err) {
    console.log(`no rows-written estimate: ${/** @type {Error} */ (err).message}`);
    return;
  }
  const est = await estimateWrites(file, modules);
  console.log(`estimated rows written by ${file} over ${modules.length} modules (node:sqlite): ${est.rowsWritten}`);
  console.log(`  total_changes(): ${est.totalChanges}`);
  for (const [name, n] of Object.entries(est.indexEntries)) console.log(`  index ${name}: ${n} entries`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
