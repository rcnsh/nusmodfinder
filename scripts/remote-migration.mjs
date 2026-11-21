// @ts-check
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const MIGRATIONS_DIR = join(ROOT, 'migrations');

export const WRANGLER_MIGRATIONS_DDL =
  'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';

export const BOOTSTRAP_APPLIED = ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql'];

/** @param {string} name */
export function migrationFile(name) {
  const file = name.endsWith('.sql') ? name : `${name}.sql`;
  if (!/^\d{4}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`not a migration file name: ${name}`);
  return file;
}

/** @param {string} file */
export function outputPath(file) {
  return `/tmp/vnm-remote-${file.replace(/\.sql$/, '')}.sql`;
}

/** @param {{ file: string, body: string, bootstrap: boolean }} opts */
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
