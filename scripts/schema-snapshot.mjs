// @ts-check
// Rebuild proof for the D1 schema (Phase 0, ADR 0001). Entirely local: every
// wrangler call carries --local and --persist-to a fresh temp dir, and uses the
// test config, whose D1 id is not production's.
//
// 1. Builds a database from empty with `wrangler d1 migrations apply`, runs the
//    exact pragma query used for the read-only remote capture, normalises, and
//    diffs against test/fixtures/remote-schema.json.
// 2. Builds the old recipe (schema.sql + 0002–0005, all from 3b18041) and diffs
//    normalised sqlite_master.sql and pragma_index_xinfo between the two local
//    builds, covering index columns, trigger bodies and the FTS tokenize option.
//
// Exits non-zero on any difference. Usage: npm run db:rebuild-check
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG = join(ROOT, 'test/wrangler.test.jsonc');
const WRANGLER = join(ROOT, 'node_modules/.bin/wrangler');
const QUERY_FILE = join(ROOT, 'test/fixtures/schema-query.sql');
const EVIDENCE_QUERY_FILE = join(ROOT, 'docs/evidence/phase0/remote-schema-query.sql');
const REMOTE_SNAPSHOT = join(ROOT, 'test/fixtures/remote-schema.json');
const EVIDENCE_SNAPSHOT = join(ROOT, 'docs/evidence/phase0/remote-schema.json');
const OLD_RECIPE_COMMIT = '3b18041';
const OLD_RECIPE_FILES = [
  'schema.sql',
  'migrations/0002_fts.sql',
  'migrations/0003_ng.sql',
  'migrations/0004_meta.sql',
  'migrations/0005_rank.sql',
];
const DB = 'nusmods';

// Internal tables: Cloudflare's (_cf_), wrangler's migration tracking (d1_)
// and SQLite's own (sqlite_). The FTS shadow tables are real schema and stay.
const INTERNAL_RE = /^(_cf_|d1_|sqlite_)/;

const MASTER_SQL =
  'SELECT type, name, tbl_name, sql FROM sqlite_master';
const INDEX_XINFO_SQL =
  'SELECT m.name AS idx, m.tbl_name AS tbl, x.seqno, x.cid, x.name, x."desc", x.coll, x."key" ' +
  "FROM sqlite_master m, pragma_index_xinfo(m.name) x WHERE m.type = 'index'";

/**
 * Runs wrangler with --local forced on, and refuses to continue if its output
 * suggests it touched anything remote.
 * @param {string[]} args
 * @returns {string} stdout
 */
function wrangler(args) {
  if (!args.includes('--local')) throw new Error(`refusing to run wrangler without --local: ${args.join(' ')}`);
  const res = spawnSync(WRANGLER, [...args, '-c', CONFIG], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  // Local runs print two fixed hint lines mentioning --remote; anything else
  // that says "remote" means wrangler went somewhere it should not have.
  const hints = /^.*(To execute on your remote database, add a --remote flag|Use --remote if you want to access the remote instance).*$/gm;
  if (/remote/i.test(output.replace(hints, ''))) {
    throw new Error(`wrangler output mentions a remote connection; stopping.\n${output}`);
  }
  if (res.status !== 0) throw new Error(`wrangler ${args.join(' ')} failed (exit ${res.status}):\n${output}`);
  return res.stdout;
}

/**
 * Executes SQL against a local persisted D1 and returns the rows of the last
 * statement (wrangler wraps each statement as `{ results, success, meta }`).
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
 * Accepts either a bare row array or wrangler's `[{ results }]` envelope.
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

/**
 * Canonical JSON (sorted keys) so row comparison ignores key order.
 * @param {Record<string, unknown>} row
 */
function canonical(row) {
  return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))));
}

/**
 * Normalises rows of the remote-capture pragma query: drops anything naming an
 * internal table, canonicalises, sorts.
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

/**
 * Strips SQL comments and collapses whitespace. Safe for this schema, which has
 * no `--` or `/*` inside string literals.
 * @param {unknown} sql
 */
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
 * Multiset diff of two sorted string lists. Returns human-readable lines.
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

async function main() {
  const problems = [];

  const [fixtureQuery, evidenceQuery] = await Promise.all([readFile(QUERY_FILE), readFile(EVIDENCE_QUERY_FILE)]);
  if (!fixtureQuery.equals(evidenceQuery)) {
    problems.push(`${QUERY_FILE} is not byte-identical to ${EVIDENCE_QUERY_FILE}`);
  }

  const tmp = await mkdtemp(join(tmpdir(), 'vnm-schema-'));
  try {
    // Build 1: migrations from empty.
    const fresh = join(tmp, 'migrations');
    wrangler(['d1', 'migrations', 'apply', DB, '--local', '--persist-to', fresh]);
    const applied = queryRows(fresh, 'SELECT name FROM d1_migrations ORDER BY id').map((r) => r.name);
    console.log(`migrations applied: ${applied.join(', ')}`);

    const remote = normalisePragmaRows(unwrap(JSON.parse(await readFile(REMOTE_SNAPSHOT, 'utf8'))));
    // The fixture is the evidence capture with wrangler's envelope removed;
    // it must not drift from what was actually read from production.
    const evidence = normalisePragmaRows(unwrap(JSON.parse(await readFile(EVIDENCE_SNAPSHOT, 'utf8'))));
    problems.push(...diffRows('evidence-vs-fixture', evidence, remote));
    const local = normalisePragmaRows(queryFile(fresh, QUERY_FILE));
    const remoteDiff = diffRows('remote-vs-migrations', remote, local);
    console.log(`pragma snapshot: ${local.length} local rows vs ${remote.length} remote rows, ${remoteDiff.length} differences`);
    problems.push(...remoteDiff);

    // Build 2: the old by-hand recipe, every file as deployed at 3b18041.
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
