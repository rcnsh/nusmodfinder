// @ts-check
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = join(ROOT, 'test/wrangler.test.jsonc');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const QUERY_FILE = join(ROOT, 'test/fixtures/schema-query.sql');
const REMOTE_SNAPSHOT = join(ROOT, 'test/fixtures/remote-schema.json');
const OLD_RECIPE_COMMIT = '9d48532';
const OLD_RECIPE_FILES = [
  'schema.sql',
  'migrations/0002_fts.sql',
  'migrations/0003_ng.sql',
  'migrations/0004_meta.sql',
  'migrations/0005_rank.sql',
];
const DB = 'nusmods';
const MIGRATIONS_DIR = join(ROOT, 'migrations');
const EXPECTED_SNAPSHOT = join(ROOT, 'test/fixtures/schema-full.json');
const REMOTE_MIGRATIONS = ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql'];

const INTERNAL_RE = /^(_cf_|d1_|sqlite_)/;

const MASTER_SQL =
  'SELECT type, name, tbl_name, sql FROM sqlite_master';
const INDEX_XINFO_SQL =
  'SELECT m.name AS idx, m.tbl_name AS tbl, x.seqno, x.cid, x.name, x."desc", x.coll, x."key" ' +
  "FROM sqlite_master m, pragma_index_xinfo(m.name) x WHERE m.type = 'index'";

/**
 * @param {string[]} args
 * @param {string} [config]
 * @returns {string}
 */
function wrangler(args, config = CONFIG) {
  if (!args.includes('--local')) throw new Error(`refusing to run wrangler without --local: ${args.join(' ')}`);
  const res = spawnSync(WRANGLER, [...args, '-c', config], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  const hints = /^.*(To execute on your remote database, add a --remote flag|Use --remote if you want to access the remote instance).*$/gm;
  if (/remote/i.test(output.replace(hints, ''))) {
    throw new Error(`wrangler output mentions a remote connection; stopping.\n${output}`);
  }
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status}):\n${output}`);
  return res.stdout;
}

/**
 * @param {string} persistTo
 * @param {{ file?: string, command?: string }} sql
 * @returns {Record<string, unknown>[]}
 */
function query(persistTo, sql) {
  const source = sql.file ? ['--file', sql.file] : ['--command', /** @type {string} */ (sql.command)];
  const out = wrangler(['d1', 'execute', DB, '--local', '--persist-to', persistTo, ...source, '--json']);
  return unwrap(JSON.parse(out));
}

/**
 * @param {unknown} data
 * @returns {Record<string, unknown>[]}
 */
export function unwrap(data) {
  if (!Array.isArray(data)) throw new Error('expected a JSON array');
  if (data.length > 0 && data.every((d) => d && typeof d === 'object' && 'results' in d)) {
    const last = data[data.length - 1];
    return /** @type {Record<string, unknown>[]} */ (last.results);
  }
  return /** @type {Record<string, unknown>[]} */ (data);
}

/** @param {Record<string, unknown>} row */
function canonical(row) {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
export function normalisePragmaRows(rows) {
  return rows
    .filter((r) => {
      if (r.kind === 'col' || r.kind === 'idx') return !INTERNAL_RE.test(String(r.tbl));
      if (r.kind === 'obj') return !INTERNAL_RE.test(String(r.b)) && !INTERNAL_RE.test(String(r.c));
      return true;
    })
    .map(canonical)
    .sort();
}

/** @param {unknown} sql */
export function normaliseSql(sql) {
  if (typeof sql !== 'string') return sql;
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function normaliseMaster(rows) {
  return rows
    .filter((r) => !INTERNAL_RE.test(String(r.name)) && !INTERNAL_RE.test(String(r.tbl_name)))
    .map((r) => canonical({ ...r, sql: normaliseSql(r.sql) }))
    .sort();
}

/**
 * @param {Record<string, unknown>[]} rows
 * @returns {string[]}
 */
function normaliseIndexXinfo(rows) {
  return rows.filter((r) => !INTERNAL_RE.test(String(r.tbl))).map(canonical).sort();
}

/**
 * @param {string} label
 * @param {string[]} expected
 * @param {string[]} actual
 * @returns {string[]}
 */
export function diffRows(label, expected, actual) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const r of expected) counts.set(r, (counts.get(r) ?? 0) + 1);
  for (const r of actual) counts.set(r, (counts.get(r) ?? 0) - 1);
  const lines = [];
  for (const [row, n] of counts) {
    for (let i = 0; i < Math.abs(n); i++) lines.push(`${label} ${n > 0 ? '-' : '+'} ${row}`);
  }
  return lines;
}

/**
 * @param {string} tmp
 * @param {string[]} files
 * @returns {Promise<string>}
 */
async function partialConfig(tmp, files) {
  const dir = join(tmp, 'migrations-subset');
  await mkdir(dir);
  for (const f of files) await writeFile(join(dir, f), await readFile(join(MIGRATIONS_DIR, f)));
  const text = (await readFile(CONFIG, 'utf8'))
    .replace('"main": "../src/index.js"', JSON.stringify({ main: join(ROOT, 'src/index.js') }).slice(1, -1))
    .replace('"migrations_dir": "../migrations"', JSON.stringify({ migrations_dir: dir }).slice(1, -1));
  if (!text.includes(dir)) throw new Error('could not point the partial config at the migration subset');
  const path = join(tmp, 'wrangler.subset.jsonc');
  await writeFile(path, text);
  return path;
}

/**
 * @param {string} persistTo
 * @param {string} [config]
 */
function applyMigrations(persistTo, config) {
  wrangler(['d1', 'migrations', 'apply', DB, '--local', '--persist-to', persistTo], config);
  return queryRows(persistTo, 'SELECT name FROM d1_migrations ORDER BY id').map((r) => String(r.name));
}

/** @param {string} persistTo */
function snapshot(persistTo) {
  return {
    pragma: normalisePragmaRows(queryFile(persistTo, QUERY_FILE)),
    master: normaliseMaster(queryRows(persistTo, MASTER_SQL)),
    indexXinfo: normaliseIndexXinfo(queryRows(persistTo, INDEX_XINFO_SQL)),
  };
}

/**
 * @param {string} path
 * @returns {Promise<{ pragma: unknown, master: unknown, indexXinfo: unknown, migrations: unknown }>}
 */
export async function loadCapture(path) {
  if ((await stat(path)).isDirectory()) {
    const read = async (/** @type {string} */ f) => JSON.parse(await readFile(join(path, f), 'utf8'));
    return { pragma: await read('pragma.json'), master: await read('master.json'), indexXinfo: await read('index_xinfo.json'), migrations: await read('d1_migrations.json') };
  }
  const all = JSON.parse(await readFile(path, 'utf8'));
  return {
    pragma: all.pragma,
    master: all.master,
    indexXinfo: all.indexXinfo ?? all.index_xinfo,
    migrations: all.migrations ?? all.d1_migrations,
  };
}

/**
 * @param {{ pragma: unknown, master: unknown, indexXinfo: unknown, migrations: unknown }} capture
 * @param {{ expected: { pragma: string[], master: string[], indexXinfo: string[] }, migrations: string[] }} want
 * @returns {string[]}
 */
export function compareRemote(capture, want) {
  const names = unwrap(capture.migrations).map((r) => String(r.name));
  return [
    ...diffRows('pragma', want.expected.pragma, normalisePragmaRows(unwrap(capture.pragma))),
    ...diffRows('sqlite_master', want.expected.master, normaliseMaster(unwrap(capture.master))),
    ...diffRows('index_xinfo', want.expected.indexXinfo, normaliseIndexXinfo(unwrap(capture.indexXinfo))),
    ...diffRows('d1_migrations', [...want.migrations].sort(), names.sort()),
  ];
}

/** @param {string} path */
async function compareRemoteMain(path) {
  const capture = await loadCapture(path);
  const expected = JSON.parse(await readFile(EXPECTED_SNAPSHOT, 'utf8'));
  const migrations = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied = unwrap(capture.migrations).map((r) => String(r.name));
  console.log(`production applied, in order: ${applied.join(', ')}`);
  const diff = compareRemote(capture, { expected, migrations });
  const counts = {
    pragma: unwrap(capture.pragma).length, master: unwrap(capture.master).length,
    indexXinfo: unwrap(capture.indexXinfo).length, migrations: applied.length,
  };
  console.log(`capture rows: pragma ${counts.pragma}, sqlite_master ${counts.master}, index_xinfo ${counts.indexXinfo}, d1_migrations ${counts.migrations}`);
  console.log(`snapshot: pragma ${expected.pragma.length}, sqlite_master ${expected.master.length}, index_xinfo ${expected.indexXinfo.length}; migrations/ ${migrations.length} files`);
  if (diff.length) {
    console.error(`\nproduction differs from the full-chain snapshot (${diff.length}):`);
    for (const d of diff) console.error(`  ${d}`);
    process.exit(1);
  }
  console.log(`production equals the full-chain snapshot (${EXPECTED_SNAPSHOT.slice(ROOT.length)}) in every section, with the same set of ${migrations.length} migrations`);
}

async function main() {
  const at = process.argv.indexOf('--compare-remote');
  if (at >= 0) {
    const path = process.argv[at + 1];
    if (!path) throw new Error('--compare-remote needs a capture file or directory');
    return compareRemoteMain(path);
  }
  const update = process.argv.includes('--update');
  const problems = [];

  const tmp = await mkdtemp(join(tmpdir(), 'vnm-schema-'));
  try {
    const fresh = join(tmp, 'migrations');
    const applied = applyMigrations(fresh, await partialConfig(tmp, REMOTE_MIGRATIONS));
    console.log(`build 1 (production before 0006) applied: ${applied.join(', ')}`);
    if (applied.join() !== REMOTE_MIGRATIONS.join()) problems.push(`build 1 applied ${applied.join(', ')}`);

    const remote = normalisePragmaRows(unwrap(JSON.parse(await readFile(REMOTE_SNAPSHOT, 'utf8'))));
    const local = normalisePragmaRows(queryFile(fresh, QUERY_FILE));
    const remoteDiff = diffRows('remote-vs-migrations', remote, local);
    console.log(`pragma snapshot: ${local.length} local rows vs ${remote.length} remote rows, ${remoteDiff.length} differences`);
    problems.push(...remoteDiff);

    const old = join(tmp, 'old-recipe');
    const sqlDir = join(tmp, 'old-sql');
    await mkdir(sqlDir);
    for (const file of OLD_RECIPE_FILES) {
      const body = execFileSync('git', ['show', `${OLD_RECIPE_COMMIT}:${file}`], { cwd: ROOT, encoding: 'utf8' });
      const path = join(sqlDir, file.replaceAll('/', '_'));
      await writeFile(path, body);
      wrangler(['d1', 'execute', DB, '--local', '--persist-to', old, '--file', path]);
    }

    const masterDiff = diffRows(
      'old-recipe-vs-migrations sqlite_master',
      normaliseMaster(queryRows(old, MASTER_SQL)),
      normaliseMaster(queryRows(fresh, MASTER_SQL)),
    );
    const xinfoDiff = diffRows(
      'old-recipe-vs-migrations index_xinfo',
      normaliseIndexXinfo(queryRows(old, INDEX_XINFO_SQL)),
      normaliseIndexXinfo(queryRows(fresh, INDEX_XINFO_SQL)),
    );
    const masterCount = normaliseMaster(queryRows(fresh, MASTER_SQL)).length;
    const xinfoCount = normaliseIndexXinfo(queryRows(fresh, INDEX_XINFO_SQL)).length;
    console.log(`sqlite_master: ${masterCount} objects, ${masterDiff.length} differences`);
    console.log(`index_xinfo: ${xinfoCount} rows, ${xinfoDiff.length} differences`);
    problems.push(...masterDiff, ...xinfoDiff);

    const full = join(tmp, 'full');
    const all = applyMigrations(full);
    console.log(`build 3 (full chain) applied: ${all.join(', ')}`);
    const actual = snapshot(full);
    if (update) {
      await writeFile(EXPECTED_SNAPSHOT, `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`wrote ${EXPECTED_SNAPSHOT}`);
    } else {
      const expected = JSON.parse(await readFile(EXPECTED_SNAPSHOT, 'utf8'));
      const fullDiff = [
        ...diffRows('schema-full-vs-migrations pragma', expected.pragma, actual.pragma),
        ...diffRows('schema-full-vs-migrations sqlite_master', expected.master, actual.master),
        ...diffRows('schema-full-vs-migrations index_xinfo', expected.indexXinfo, actual.indexXinfo),
      ];
      console.log(`full chain vs ${EXPECTED_SNAPSHOT.slice(ROOT.length)}: ${fullDiff.length} differences`);
      problems.push(...fullDiff);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  if (problems.length) {
    console.error(`\nschema rebuild check FAILED (${problems.length}):`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('schema rebuild check passed');
}

/**
 * @param {string} persistTo
 * @param {string} command
 */
function queryRows(persistTo, command) {
  return query(persistTo, { command });
}

/**
 * @param {string} persistTo
 * @param {string} file
 */
function queryFile(persistTo, file) {
  return query(persistTo, { file });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
