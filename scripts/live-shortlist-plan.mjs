// @ts-check
// What scripts/p6-live.mjs (Phase 6 6E's live checks) does before it sends
// anything: its arguments, the seeded draw of the shortlist it checks and the
// three 404 codes, the calls it will make, and the reading and comparing of
// totals. Node only and pure but for loading the data, so
// test/p6-live.node.test.js runs it with no network; the browser half is
// p6-live.mjs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { oracleShown } from '../test/sc1/oracle.mjs';
import { reference } from '../test/web/shortlist-reference.node.mjs';
import { productionCorpus } from './corpus-manifest.mjs';
import { catalogueOnlyRecords } from './lib.mjs';
import { GAP_MS, PRODUCTION_URL, draw, loadModules, rng } from './p5-live-plan.mjs';

export { GAP_MS, PRODUCTION_URL, rng };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The study level the shortlist is checked at (the 6B/6C/6D tests' own). */
export const STUDY = 'ug2';
/** The unknown code: well formed, in no list (test/ui's own unknown code). */
const UNKNOWN = 'CS9999';
const BIZ = 'NUS Business School';

// ---------- arguments ----------

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
  return { url: url.origin, log: opts.log ?? 'docs/evidence/phase6/p6-live.jsonl', corpus, seed, plan };
}

// ---------- the data ----------

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
 * What the site under check holds, from the repo: production's moduleInfo
 * normalised as ingest does, with data/'s groups and NG-listed codes with no
 * classes; or the fixture the local UI server seeds. The catalogue-only codes
 * are data/catalogue-only.json's (what the UI server seeds), and for
 * production also catalogue-only in `current`, the corpus ingest loads.
 * @param {'production' | 'fixture'} corpus
 * @returns {Promise<LiveData>}
 */
export async function loadData(corpus) {
  const modules = await loadModules(corpus);
  const dir = corpus === 'production' ? 'data' : 'test/fixtures';
  const file = readJson('data/catalogue-only.json');
  let catalogueOnly = /** @type {[string, string, string][]} */ (file.rows).map(([code]) => code);
  if (corpus === 'production') {
    // Phase 7 7D: data/catalogue-only.json is built from `current` (data/corpus.json); filtered
    // by it all the same, so a stale file can't send a code production doesn't hold.
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
 * The reference's view of the data (test/web/shortlist-reference.node.mjs).
 * @param {LiveData} data
 * @returns {import('../test/web/shortlist-reference.node.mjs').RefData}
 */
export function refData(data) {
  const byCode = new Map(data.modules.map((m) => [m.code, m]));
  const groupOf = new Map(data.groups.flatMap((g) => g.map((c) => [c, g.filter((x) => x !== c)])));
  return { rowOf: (c) => byCode.get(c), groupOf: (c) => groupOf.get(c) ?? [], reasons: data.reasons };
}

// ---------- the draw ----------

/**
 * The shortlist's 8 slots, in rank order: 6 picks then 2 backups, over both
 * semesters, with a counted, a to-confirm, a Business (only if invited) and a
 * closed entry. `want` is the slot's standing by the reference, which the
 * oracle must agree with (closed exactly when the slot is `out`).
 */
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
 *   `standing`: the reference's; `status`: the SC1 oracle's (with R3's year note) at the entry's semester
 */

/**
 * The shortlist: one seeded draw per slot from the modules with units taught
 * in the slot's semester (any semester for a to-confirm slot), a Business
 * course for the invite slot and none of Business or Law elsewhere, no two
 * from one group (so none is a duplicate). Each entry's standing is the
 * reference's over the whole list, and its status the oracle's.
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
      // To confirm is mostly R2's "not timetabled in this semester" note, so that slot may be untaught there.
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

/** The link's query string, as the page writes one. @param {{ which: string, code: string, sem: string }[]} entries */
export const shortlistLink = (entries) => `ng=1&study=${STUDY}&sem=1&${[...entries.filter((e) => e.which === 'pick'), ...entries.filter((e) => e.which === 'alt')]
  .map((e) => `${e.which}=${e.code}.${e.sem}`).join('&')}&view=shortlist`;

/**
 * One 404 code of each kind /module answers (src/modules.js notFound), each
 * absent from the offered modules: an NG-listed code with no classes, a
 * catalogue-only code (not NG-listed), and a code in no list at all.
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
 * Everything the check knows before it sends anything.
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

// ---------- the totals ----------

/**
 * @typedef {{ counted: number, confirm: number, invite: number, atLeast: boolean }} ReadTotals
 */

/**
 * A semester's totals as the view or the CSV words them: "8 units counted,
 * if…" (the view) or "Sem 1: 8 units picked, if…" (the CSV), then "plus 4
 * units to confirm with NUS" and "plus 4 units only if invited" when not 0.
 * @param {string[]} lines the semester's lines (or one text holding them all)
 * @returns {ReadTotals | null} null when no counted line is there
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
 * The CSV's totals: its tail rows labelled "Sem N totals", by semester.
 * @param {string[][]} tail the rows after the separator, [label, value, …]
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
 * What differs between the reference's totals and the ones read, as lines
 * ([] when they agree): each semester's counted, to-confirm and
 * only-if-invited units, and no "at least" (every row loaded).
 * @param {string} where the view, the CSV
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
