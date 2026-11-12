// @ts-check
// What scripts/p5-live.mjs (Phase 5 5G's live checks) does, before it sends
// anything: its arguments, and the seeded draw of the codes it checks, from
// the production-normalised modules (or the fixture, for the local UI server).
// Node only and pure but for loading the modules, so test/p5-live.node.test.js
// runs it; the browser half is p5-live.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bitOf, STUDIES } from '../src/ng-bit.js';
import { moduleWorkload } from '../src/workload.js';
import { oracle } from '../test/sc1/oracle.node.mjs';
import { productionCorpus } from './corpus-manifest.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PRODUCTION_URL = 'https://nusmodfinder.rcn.sh';
/** Requests start at least this far apart. */
export const GAP_MS = 4_000;
const PER_STRATUM = 4;

// ---------- arguments ----------

/**
 * @param {string[]} argv
 * @returns {{ url: string, log: string, corpus: 'production' | 'fixture', expectCommit: string, seed: number, dryRun: boolean }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { dryRun = true; continue; }
    if (!['--url', '--log', '--corpus', '--expect-commit', '--seed'].includes(a) || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${a}`);
    opts[a.slice(2)] = argv[++i];
  }
  const url = new URL(opts.url ?? PRODUCTION_URL);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--url is the site\'s origin, with no path');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const corpus = opts.corpus ?? (local ? 'fixture' : 'production');
  if (corpus !== 'production' && corpus !== 'fixture') throw new Error('--corpus is production or fixture');
  const seed = Number(opts.seed ?? 5);
  if (!Number.isInteger(seed)) throw new Error('--seed is an integer');
  return {
    url: url.origin, log: opts.log ?? 'docs/evidence/phase5/p5-live.jsonl', corpus,
    expectCommit: opts['expect-commit'] ?? (local ? 'none' : ''), seed, dryRun,
  };
}

// ---------- the draw ----------

/** mulberry32: a small seeded generator, so the draw is the same on every run. @param {number} seed */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * `n` items in a seeded order (sorted by code first, so the input order doesn't matter).
 * @template {{ code: string }} T
 * @param {T[]} list
 * @param {number} n
 * @param {() => number} r
 * @returns {T[]}
 */
export function draw(list, n, r) {
  const out = [...list].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, n);
}

const NOT_LISTED = 'ng-list:not-listed';
const NOT_IN_SEM = 'ng-list:not-in-semester';

/**
 * A normalised module's stored reason ids at an allow-mask bit (bitOf), as
 * /module answers them (src/ng-reasons.js exchangeAt): a course off the NG
 * list stores none and reads as "not listed".
 * @param {any} m @param {number} bit
 * @returns {string[]}
 */
const rulesAt = (m, bit) => {
  const rules = typeof m.ngRules === 'string' ? JSON.parse(m.ngRules) : m.ngRules;
  return rules?.[String(Math.log2(bit))] ?? (m.ng ? [] : [NOT_LISTED]);
};
/** Whether the stored mask opens the course at a bit (bitOf). @param {any} m @param {number} bit */
const allowedAt = (m, bit) => (Number(m.ngAllow ?? 0) & bit) !== 0;

/** The SC2 strata, in draw order; a code goes to the first stratum it fits. */
export const STRATA = Object.freeze(/** @type {const} */ ([
  ['exams in two semesters', (/** @type {any} */ m) => [1, 2].every((s) => (m.examDates ?? []).some((/** @type {any} */ e) => e.sem === s))],
  ['cohort-only prerequisite', (/** @type {any} */ m) => m.prereqCohortOnly === true],
  ['no workload', (/** @type {any} */ m) => moduleWorkload(m.workload ?? null) === null],
  ['two or more notes', (/** @type {any} */ m) => Array.from({ length: 15 }, (_, i) => 1 << i).some((bit) => allowedAt(m, bit) && rulesAt(m, bit).length >= 2)],
]));

/**
 * 20 codes for SC2: 4 from each stratum, then 4 plain ones (in none of them).
 * @param {any[]} modules
 * @param {() => number} r
 * @returns {{ stratum: string, m: any }[]}
 */
export function drawSc2(modules, r) {
  const taken = new Set();
  /** @type {{ stratum: string, m: any }[]} */
  const out = [];
  for (const [name, fits] of STRATA) {
    for (const m of draw(modules.filter((x) => !taken.has(x.code) && fits(x)), PER_STRATUM, r)) { taken.add(m.code); out.push({ stratum: name, m }); }
  }
  const plain = modules.filter((x) => !taken.has(x.code) && !STRATA.some(([, fits]) => fits(x)));
  for (const m of draw(plain, PER_STRATUM, r)) out.push({ stratum: 'plain', m });
  return out;
}

/**
 * The three kinds of closed code, so each kind of explanation is seen live,
 * each with the stamp the page must give it at semester `sem` (fixed here, so
 * a live /module answer that lost its reasons can't pass by being explained
 * the same wrong way on both sides).
 */
export const CLOSED_KINDS = Object.freeze(/** @type {const} */ ([
  ['not on the NG list', (/** @type {string[]} */ ids) => ids.includes(NOT_LISTED), () => 'Not for exchange students'],
  ['on the NG list for the other semester only', (/** @type {string[]} */ ids) => ids.length === 1 && ids[0] === NOT_IN_SEM, (/** @type {1 | 2} */ sem) => `Not on the NG list for Sem ${sem}`],
  ['closed by a restriction', (/** @type {string[]} */ ids) => ids.length > 0 && !ids.includes(NOT_LISTED) && !(ids.length === 1 && ids[0] === NOT_IN_SEM), (/** @type {1 | 2} */ sem) => `Not open in Sem ${sem}`],
]));

/**
 * 3 closed codes (one of each kind) at a drawn semester and year of study, and
 * 1 partial code exchange mode empties there. Closed means closed by the
 * independent oracle (test/sc1/oracle.node.mjs) and by the stored bit. Each
 * closed code says the stamp it must show and whether the other semester is
 * open to the student (so "Switch to Sem N" must show), by the same two.
 * @param {any[]} modules
 * @param {() => number} r
 */
export function drawHidden(modules, r) {
  const ctxs = draw(/** @type {(1 | 2)[]} */ ([1, 2]).flatMap((sem) => STUDIES.map((study) => ({ code: `${sem}-${study}`, sem, study }))), 10, r);
  /** @type {{ kind: string, sem: 1 | 2, study: import('../src/ng-bit.js').Study, m: any, stamp: string, otherOpen: boolean }[]} */
  const closed = [];
  for (const [kind, fits, stamp] of CLOSED_KINDS) {
    for (const ctx of ctxs) {
      const bit = bitOf(ctx.sem, ctx.study);
      const pool = modules.filter((m) => !allowedAt(m, bit) && oracle(m, { sem: ctx.sem, study: ctx.study }) === 'closed' && fits(rulesAt(m, bit))
        && !closed.some((c) => c.m.code === m.code));
      const [m] = draw(pool, 1, r);
      if (m) {
        const other = ctx.sem === 1 ? 2 : 1;
        const otherOpen = allowedAt(m, bitOf(other, ctx.study)) && oracle(m, { sem: other, study: ctx.study }) !== 'closed';
        closed.push({ kind, sem: ctx.sem, study: ctx.study, m, stamp: stamp(ctx.sem), otherOpen });
        break;
      }
    }
  }
  /** @type {Map<string, any[]>} */
  const byPrefix = new Map();
  for (const m of modules) {
    const p = /^([A-Z]{1,4})(\d{2})/.exec(m.code);
    if (p) byPrefix.set(p[1] + p[2], [...(byPrefix.get(p[1] + p[2]) ?? []), m]);
  }
  /** @type {{ prefix: string, sem: 1 | 2, study: import('../src/ng-bit.js').Study, otherHasResults: boolean } | null} */
  let partial = null;
  for (const ctx of ctxs) {
    const other = ctx.sem === 1 ? 2 : 1;
    /** @param {any} m @param {1 | 2} sem */
    const open = (m, sem) => allowedAt(m, bitOf(sem, ctx.study)) && oracle(m, { sem, study: ctx.study }) !== 'closed';
    const empty = [...byPrefix].filter(([, ms]) => ms.every((m) => !open(m, ctx.sem))).map(([prefix, ms]) => ({ code: prefix, ms }));
    const [pick] = draw(empty, 1, r);
    if (pick) { partial = { prefix: pick.code, sem: ctx.sem, study: ctx.study, otherHasResults: pick.ms.some((m) => open(m, other)) }; break; }
  }
  return { closed, partial };
}

/**
 * The modules drawn from: production's corpus (`current`) normalised as ingest does,
 * or the fixture the local UI server holds.
 * @param {'production' | 'fixture'} corpus
 * @returns {Promise<any[]>}
 */
export async function loadModules(corpus) {
  if (corpus === 'fixture') return JSON.parse(readFileSync(`${ROOT}test/fixtures/corpus.json`, 'utf8')).modules;
  // Phase 7 7D: `current` (data/corpus.json), never the .data/cache download.
  return (await productionCorpus()).modules;
}
