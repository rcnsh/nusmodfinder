// @ts-check
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oracleShown } from '../test/oracle/oracle.mjs';
import { reference } from '../test/web/shortlist-reference.node.mjs';
import { productionCorpus } from './corpus-manifest.mjs';
import { catalogueOnlyRecords } from './lib.mjs';
import { GAP_MS, PRODUCTION_URL, draw, loadModules, rng } from './live-check-plan.mjs';

export { GAP_MS, PRODUCTION_URL, rng };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const STUDY = 'ug2';
const UNKNOWN = 'CS9999';
const BIZ = 'NUS Business School';

/**
 * @param {string[]} argv
 * @returns {{ url: string, log: string, corpus: 'production' | 'fixture', seed: number, plan: boolean }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const opts = {};
  let plan = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--plan') { plan = true; continue; }
    if (!['--url', '--log', '--corpus', '--seed'].includes(a) || i + 1 >= argv.length) throw new Error(`unknown or incomplete argument: ${a}`);
    opts[a.slice(2)] = argv[++i];
  }
  const url = new URL(opts.url ?? PRODUCTION_URL);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('--url is the site\'s origin, with no path');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const corpus = opts.corpus ?? (local ? 'fixture' : 'production');
  if (corpus !== 'production' && corpus !== 'fixture') throw new Error('--corpus is production or fixture');
  const seed = Number(opts.seed ?? 6);
  if (!Number.isInteger(seed)) throw new Error('--seed is an integer');
  return { url: url.origin, log: opts.log ?? '.data/live-shortlist.jsonl', corpus, seed, plan };
}

/**
 * @typedef {{
 *   corpus: 'production' | 'fixture',
 *   modules: any[],
 *   groups: string[][],
 *   unscheduled: { code: string }[],
 *   catalogueOnly: string[],
 *   catalogueCodes: Set<string>,
 *   reasons: Record<string, { kind: string, text: string }>,
 * }} LiveData
 */

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(`${ROOT}${rel}`, 'utf8'));

/**
 * @param {'production' | 'fixture'} corpus
 * @returns {Promise<LiveData>}
 */
export async function loadData(corpus) {
  const modules = await loadModules(corpus);
  const dir = corpus === 'production' ? 'data' : 'test/fixtures';
  const file = readJson('data/catalogue-only.json');
  let catalogueOnly = /** @type {[string, string, string][]} */ (file.rows).map(([code]) => code);
  if (corpus === 'production') {
    const current = new Set(catalogueOnlyRecords((await productionCorpus()).records).map((r) => r.code));
    catalogueOnly = catalogueOnly.filter((c) => current.has(c));
  }
  return {
    corpus,
    modules,
    groups: readJson(`${dir}/groups.json`).groups,
    unscheduled: readJson(`${dir}/ng-unscheduled.json`).modules,
    catalogueOnly,
    catalogueCodes: new Set(readJson('data/catalogue-codes.json').codes),
    reasons: readJson('data/ng-reasons.json').reasons,
  };
}

/**
 * @param {LiveData} data
 * @returns {import('../test/web/shortlist-reference.node.mjs').RefData}
 */
export function refData(data) {
  const byCode = new Map(data.modules.map((m) => [m.code, m]));
  const groupOf = new Map(data.groups.flatMap((g) => g.map((c) => [c, g.filter((x) => x !== c)])));
  return { rowOf: (c) => byCode.get(c), groupOf: (c) => groupOf.get(c) ?? [], reasons: data.reasons };
}

export const SLOTS = Object.freeze(/** @type {const} */ ([
  { which: 'pick', sem: '1', want: 'counted' },
  { which: 'pick', sem: '2', want: 'counted' },
  { which: 'pick', sem: '1', want: 'confirm' },
  { which: 'pick', sem: '1', want: 'invite' },
  { which: 'pick', sem: '2', want: 'out' },
  { which: 'pick', sem: '2', want: 'confirm' },
  { which: 'alt', sem: '1', want: 'counted' },
  { which: 'alt', sem: '2', want: 'counted' },
]));

/**
 * @typedef {{ which: 'pick' | 'alt', code: string, sem: '1' | '2', title: string, faculty: string | null, credits: number,
 *   standing: string, status: 'open' | 'note' | 'closed' }} PlannedEntry
 */

/**
 * @param {LiveData} data
 * @param {() => number} r
 * @returns {{ entries: PlannedEntry[], totals: Record<'1' | '2', import('../test/web/shortlist-reference.node.mjs').RefTotals>, link: string }}
 */
export function drawShortlist(data, r) {
  const ref = refData(data);
  /** @type {Set<string>} */
  const taken = new Set();
  /** @type {PlannedEntry[]} */
  const entries = [];
  for (const slot of SLOTS) {
    const sem = Number(slot.sem) === 1 ? 1 : 2;
    const pool = data.modules.filter((m) => {
      if (taken.has(m.code) || ref.groupOf(m.code).some((c) => taken.has(c))) return false;
      if (!(m.credits > 0) || (slot.want !== 'confirm' && !m.semesters.includes(sem))) return false;
      if ((slot.want === 'invite') !== (m.faculty === BIZ) || m.faculty === 'Law') return false;
      const [one] = reference([{ which: slot.which, code: m.code, sem: slot.sem }], STUDY, [], ref).standings;
      if (one.standing !== slot.want) return false;
      return (oracleShown(m, { sem, study: STUDY }) === 'closed') === (slot.want === 'out');
    });
    const [m] = draw(pool, 1, r);
    if (!m) throw new Error(`no ${data.corpus} module fits the slot ${slot.which} Sem ${slot.sem} ${slot.want}`);
    taken.add(m.code);
    entries.push({ which: slot.which, code: m.code, sem: slot.sem, title: m.title, faculty: m.faculty, credits: m.credits, standing: '', status: oracleShown(m, { sem, study: STUDY }) });
  }
  const whole = reference(entries, STUDY, [], ref);
  whole.standings.forEach((s, i) => { entries[i].standing = s.standing; });
  return { entries, totals: whole.totals, link: shortlistLink(entries) };
}

/** @param {{ which: string, code: string, sem: string }[]} entries */
export const shortlistLink = (entries) => `ng=1&study=${STUDY}&sem=1&${[...entries.filter((e) => e.which === 'pick'), ...entries.filter((e) => e.which === 'alt')]
  .map((e) => `${e.which}=${e.code}.${e.sem}`).join('&')}&view=shortlist`;

/**
 * @param {LiveData} data
 * @param {() => number} r
 * @returns {{ kind: 'ng-listed' | 'catalogue-only' | 'unknown', code: string }[]}
 */
export function draw404(data, r) {
  const offered = new Set(data.modules.map((m) => m.code));
  const unscheduled = new Set(data.unscheduled.map((m) => m.code));
  const [listed] = draw(data.unscheduled.filter((m) => !offered.has(m.code)), 1, r);
  const [catalogue] = draw(data.catalogueOnly.filter((c) => !offered.has(c) && !unscheduled.has(c)).map((code) => ({ code })), 1, r);
  if (!listed) throw new Error(`no ${data.corpus} NG-listed code without classes`);
  if (!catalogue) throw new Error('no catalogue-only code');
  if (offered.has(UNKNOWN) || unscheduled.has(UNKNOWN) || data.catalogueOnly.includes(UNKNOWN) || data.catalogueCodes.has(UNKNOWN)) {
    throw new Error(`${UNKNOWN} is a known code: pick another unknown code`);
  }
  return [{ kind: 'ng-listed', code: listed.code }, { kind: 'catalogue-only', code: catalogue.code }, { kind: 'unknown', code: UNKNOWN }];
}

/**
 * @param {LiveData} data
 * @param {number} seed
 */
export function makePlan(data, seed) {
  const r = rng(seed);
  const shortlist = drawShortlist(data, r);
  const missing = draw404(data, r);
  const calls = ['/facets', ...shortlist.entries.map((e) => `/module/${e.code}`), ...missing.map((m) => `/module/${m.code}`)];
  return { seed, corpus: data.corpus, ...shortlist, missing, calls };
}

/**
 * @typedef {{ counted: number, confirm: number, invite: number, atLeast: boolean }} ReadTotals
 */

/**
 * @param {string[]} lines
 * @returns {ReadTotals | null}
 */
export function readTotals(lines) {
  const text = lines.join('\n');
  const head = /(?:^|\n)(?:Sem [12]: )?(at least )?(\d+(?:\.\d+)?) units (?:counted|picked)\b/.exec(text);
  if (!head) return null;
  /** @param {RegExp} re */
  const plus = (re) => Number(re.exec(text)?.[1] ?? 0);
  return {
    counted: Number(head[2]), atLeast: Boolean(head[1]),
    confirm: plus(/plus (\d+(?:\.\d+)?) units to confirm with NUS/), invite: plus(/plus (\d+(?:\.\d+)?) units only if invited/),
  };
}

/**
 * @param {string[][]} tail
 * @returns {Record<string, ReadTotals | null>}
 */
export function csvTotals(tail) {
  /** @type {Record<string, string[]>} */
  const bySem = {};
  for (const [label, value] of tail) {
    const sem = /^Sem ([12]) totals$/.exec(label)?.[1];
    if (sem) (bySem[sem] ??= []).push(value);
  }
  return Object.fromEntries(Object.entries(bySem).map(([s, lines]) => [s, readTotals(lines)]));
}

/**
 * @param {string} where
 * @param {Record<'1' | '2', import('../test/web/shortlist-reference.node.mjs').RefTotals>} ref
 * @param {Record<string, ReadTotals | null>} got
 */
export function totalsProblems(where, ref, got) {
  const out = [];
  for (const s of /** @type {('1' | '2')[]} */ (['1', '2'])) {
    const g = got[s];
    if (!g) { out.push(`${where}: no Sem ${s} totals`); continue; }
    if (g.atLeast) out.push(`${where}: Sem ${s} says "at least" (a row not loaded)`);
    for (const k of /** @type {const} */ (['counted', 'confirm', 'invite'])) {
      if (g[k] !== ref[s][k]) out.push(`${where}: Sem ${s} ${k} ${g[k]}, the reference ${ref[s][k]}`);
    }
  }
  for (const s of Object.keys(got)) if (s !== '1' && s !== '2') out.push(`${where}: totals for "${s}"`);
  return out;
}
