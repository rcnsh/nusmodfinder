// @ts-check
// Shared helpers for the Phase 0 characterisation tests in this directory.
import { env } from 'cloudflare:workers';
import { fixture } from '../helpers.js';

/**
 * One SQL statement the Worker executed: its text, its bound values, and the
 * D1 meta (rows read/written) when the call returned a result object.
 * @typedef {{ sql: string, binds: unknown[], method: string }} DbCall
 */

/**
 * Wraps the test D1 binding so every statement the Worker runs is logged.
 * Pass the result as `env: { DB }` to `call()`.
 * @param {DbCall[]} log
 * @returns {D1Database}
 */
export function recordingDb(log) {
  const db = env.DB;
  /**
   * @param {D1PreparedStatement} stmt
   * @param {string} sql
   * @param {unknown[]} binds
   * @returns {D1PreparedStatement}
   */
  const wrap = (stmt, sql, binds) => /** @type {any} */ ({
    inner: stmt,
    bind: (/** @type {unknown[]} */ ...args) => wrap(stmt.bind(...args), sql, args),
    first: (/** @type {any} */ col) => { log.push({ sql, binds, method: 'first' }); return stmt.first(col); },
    all: () => { log.push({ sql, binds, method: 'all' }); return stmt.all(); },
    run: () => { log.push({ sql, binds, method: 'run' }); return stmt.run(); },
    raw: (/** @type {any} */ opts) => { log.push({ sql, binds, method: 'raw' }); return stmt.raw(opts); },
  });
  return /** @type {any} */ ({
    prepare: (/** @type {string} */ sql) => wrap(db.prepare(sql), sql, []),
    batch: (/** @type {any[]} */ stmts) => db.batch(stmts.map((s) => s.inner ?? s)),
    exec: (/** @type {string} */ q) => db.exec(q),
  });
}

/** The FTS statement in a log, if the Worker ran one. */
export const ftsCalls = (/** @type {DbCall[]} */ log) => log.filter((c) => c.sql.includes('modules_fts MATCH'));

/** Resolves to 'pending' if `p` has not settled within `ms`. */
export const settlesWithin = (/** @type {Promise<unknown>} */ p, ms = 100) =>
  Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

/**
 * A synthetic module in the shape /admin/ingest takes. `text` and `textHash`
 * follow the title/department/faculty/description rule of scripts/lib.mjs, but
 * the hash is a stand-in: these tests never compare it to lib's sha256.
 * @param {Partial<NormalisedModule> & { code: string, title: string }} over
 * @returns {NormalisedModule}
 */
export function syntheticModule(over) {
  const base = {
    description: `${over.title} description.`,
    credits: 4, department: 'Test Department', faculty: 'Test Faculty',
    level: Number(over.code.match(/\d/)?.[0] ?? 1), semesters: [1], workload: null,
    prerequisite: null, preclusion: null, acadYear: fixture.source.acadYear, ng: false, ngSemesters: [],
  };
  const m = { ...base, ...over };
  const text = [m.title, m.department, m.faculty, m.description].filter(Boolean).join('. ');
  return { text, textHash: `hash-of:${text}`, ...m };
}

/** @param {{ code: string }[]} results */
export const codes = (results) => results.map((r) => r.code);
