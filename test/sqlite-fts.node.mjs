// @ts-check
import { DatabaseSync } from 'node:sqlite';

/**
 * @param {string[]} words
 * @returns {string[]}
 */
export function sqliteTerms(words) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(x, tokenize = 'porter unicode61');
           CREATE VIRTUAL TABLE v USING fts5vocab(t, 'instance');`);
  const insert = db.prepare('INSERT INTO t(rowid, x) VALUES (?, ?)');
  words.forEach((w, i) => insert.run(i + 1, w));
  /** @type {string[]} */
  const out = words.map(() => '');
  for (const r of db.prepare('SELECT doc, term FROM v ORDER BY doc, offset').all()) out[Number(r.doc) - 1] = String(r.term);
  db.close();
  return out;
}

/** @param {{ title: string, description?: string | null }[]} modules */
export function ftsIndex(modules) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(title, description, tokenize = 'porter unicode61', prefix = '2 3 4');
           CREATE VIRTUAL TABLE v USING fts5vocab(t, 'row');`);
  const insert = db.prepare('INSERT INTO t(title, description) VALUES (?, ?)');
  for (const m of modules) insert.run(m.title, m.description ?? null);
  const count = db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?');
  return {
    /** @param {string} expr */
    matches: (expr) => Number(/** @type {{ n: number }} */ (count.get(expr)).n),
    /** @returns {string[]} */
    terms: () => db.prepare('SELECT term FROM v ORDER BY term').all().map((r) => String(r.term)),
    close: () => db.close(),
  };
}

/** @param {number} seed */
export function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param {string[]} words
 * @param {number} seed
 */
export function typoVariants(words, seed) {
  const r = rng(seed);
  /** @type {Set<string>} */
  const out = new Set();
  for (const w of words) {
    if (!/^[a-z]{4,}$/.test(w)) continue;
    const i = 1 + Math.floor(r() * (w.length - 2));
    out.add(w.slice(0, i) + w.slice(i + 1));
    out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2));
    out.add(w.slice(0, i) + w[i] + w.slice(i));
    out.add(w.slice(0, Math.max(4, w.length - 1 - Math.floor(r() * 3))));
  }
  return [...out].filter((w) => /^[a-z]{4,}$/.test(w));
}
