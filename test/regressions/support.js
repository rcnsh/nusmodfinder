// @ts-check
import { env } from 'cloudflare:workers';
import { fixture } from '../helpers.js';

/** @typedef {{ sql: string, binds: unknown[], method: string, session: string | null }} DbCall */

/**
 * @param {DbCall[]} log
 * @param {{ hang?: (sql: string) => boolean }} [options]
 * @returns {D1Database}
 */
export function recordingDb(log, options = {}) {
  const db = env.DB;
  const hang = options.hang ?? (() => false);
  /**
   * @param {D1PreparedStatement} stmt
   * @param {string} sql
   * @param {unknown[]} binds
   * @param {string | null} session
   * @returns {D1PreparedStatement}
   */
  const wrap = (stmt, sql, binds, session) => {
    /** @param {string} method @param {() => Promise<any>} run */
    const exec = (method, run) => {
      log.push({ sql, binds, method, session });
      return hang(sql) ? new Promise(() => {}) : run();
    };
    return /** @type {any} */ ({
      inner: stmt,
      bind: (/** @type {unknown[]} */ ...args) => wrap(stmt.bind(...args), sql, args, session),
      first: (/** @type {any} */ col) => exec('first', () => stmt.first(col)),
      all: () => exec('all', () => stmt.all()),
      run: () => exec('run', () => stmt.run()),
      raw: (/** @type {any} */ opts) => exec('raw', () => stmt.raw(opts)),
    });
  };
  /**
   * @param {D1Database | D1DatabaseSession} target
   * @param {string | null} session
   */
  const facade = (target, session) => ({
    prepare: (/** @type {string} */ sql) => wrap(target.prepare(sql), sql, [], session),
    batch: (/** @type {any[]} */ stmts) => target.batch(stmts.map((s) => s.inner ?? s)),
  });
  return /** @type {any} */ ({
    ...facade(db, null),
    exec: (/** @type {string} */ q) => db.exec(q),
    withSession: (/** @type {any} */ constraint) => ({
      ...facade(db.withSession(constraint), String(constraint ?? 'first-unconstrained')),
      getBookmark: () => null,
    }),
  });
}

export const ftsCalls = (/** @type {DbCall[]} */ log) => log.filter((c) => c.sql.includes('modules_fts MATCH'));

export const settlesWithin = (/** @type {Promise<unknown>} */ p, ms = 100) =>
  Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

/**
 * @param {Partial<NormalisedModule> & { code: string, title: string }} over
 * @returns {NormalisedModule}
 */
export function syntheticModule(over) {
  const base = {
    description: `${over.title} description.`,
    credits: 4, department: 'Test Department', faculty: 'Test Faculty',
    level: Number(over.code.match(/\d/)?.[0] ?? 1), semesters: [1], workload: null,
    prerequisite: null, preclusion: null, acadYear: fixture.source.acadYear, ng: false, ngSemesters: [],
    examSemesters: [], su: false, gradingBasis: null, workloadHours: null, prereqNone: true, prereqCohortOnly: false,
    ngAllow: 0, ngRules: null, examDates: [],
  };
  const m = { ...base, ...over };
  const text = [m.title, m.department, m.faculty, m.description].filter(Boolean).join('. ');
  return { text, textHash: `hash-of:${text}`, ...m };
}

/** @param {{ code: string }[]} results */
export const codes = (results) => results.map((r) => r.code);
/**
 * @param {any[]} results
 * @returns {string[]}
 */
export const shownCodes = (results) => results.flatMap((r) => [r.code, ...(r.variants ?? []).map((/** @type {{ code: string }} */ v) => v.code)]);
