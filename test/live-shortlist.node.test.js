// @ts-check
// scripts/live-shortlist-plan.mjs: the shortlist's live check's arguments, its
// seeded draw of the shortlist and the 404 codes, the calls it plans, and the
// reading and comparing of totals, on the fixture (the production modules live
// in .data/, which CI doesn't have), with no network. The browser half,
// scripts/live-shortlist.mjs, is run by hand: against the local UI server before the
// PR, against production after the deploy (docs/operations.md, "Live checks").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { csvTotals, draw404, GAP_MS, loadData, makePlan, parseArgs, PRODUCTION_URL, readTotals, refData, rng, SLOTS, STUDY, totalsProblems } from '../scripts/live-shortlist-plan.mjs';
import { toCsv } from '../public/csv.js';
import { totalLines } from '../public/shortlist.js';
import { oracleShown } from './oracle/oracle.mjs';
import { reference } from './web/shortlist-reference.node.mjs';
import { parseCsv } from './web/rfc4180.node.mjs';

const data = await loadData('fixture');
const plan = makePlan(data, 6);
const byCode = new Map(data.modules.map((m) => [m.code, m]));

describe('arguments', () => {
  it('defaults to production: its URL, the production modules, seed 6, a log under .data/, and sends', () => {
    expect(parseArgs([])).toEqual({ url: PRODUCTION_URL, log: '.data/live-shortlist.jsonl', corpus: 'production', seed: 6, plan: false });
    expect(PRODUCTION_URL).toBe('https://nusmodfinder.rcn.sh');
  });

  it('a local server draws from the fixture; --plan sends nothing', () => {
    expect(parseArgs(['--url', 'http://127.0.0.1:8911', '--plan'])).toMatchObject({ url: 'http://127.0.0.1:8911', corpus: 'fixture', plan: true });
    expect(parseArgs(['--url', 'http://localhost:9000', '--corpus', 'production', '--seed', '7'])).toMatchObject({ corpus: 'production', seed: 7 });
  });

  it('refuses a URL with a path, an unknown argument, a bad corpus or seed', () => {
    expect(() => parseArgs(['--url', 'http://127.0.0.1:8911/x'])).toThrow(/origin/);
    expect(() => parseArgs(['--dry-run'])).toThrow(/unknown/);
    expect(() => parseArgs(['--corpus', 'holdout'])).toThrow(/corpus/);
    expect(() => parseArgs(['--seed', 'x'])).toThrow(/seed/);
    expect(() => parseArgs(['--log'])).toThrow(/incomplete/);
  });

  it('calls start at least 4 s apart, and nothing lowers it', () => {
    expect(GAP_MS).toBe(4_000);
  });
});

describe('the shortlist draw', () => {
  it('6 picks then 2 backups, 8 distinct codes, none in another\'s group', () => {
    expect(plan.entries.map((e) => e.which)).toEqual([...Array(6).fill('pick'), 'alt', 'alt']);
    expect(new Set(plan.entries.map((e) => e.code)).size).toBe(8);
    const { groupOf } = refData(data);
    for (const e of plan.entries) for (const o of plan.entries) if (o !== e) expect(groupOf(e.code), `${e.code} and ${o.code}`).not.toContain(o.code);
  });

  it('spans Sem 1 and Sem 2, with a closed, a to-confirm and a Business entry', () => {
    expect(new Set(plan.entries.map((e) => e.sem))).toEqual(new Set(['1', '2']));
    expect(plan.entries.some((e) => e.status === 'closed' && e.standing === 'out')).toBe(true);
    expect(plan.entries.some((e) => e.standing === 'confirm')).toBe(true);
    expect(plan.entries.filter((e) => e.faculty === 'NUS Business School')).toHaveLength(1);
    expect(plan.entries.map((e) => e.standing)).toEqual(SLOTS.map((s) => s.want));
  });

  it('each status is the exchange oracle\'s at the entry\'s semester, and each standing the reference\'s over the whole list', () => {
    for (const e of plan.entries) {
      expect(e.status, e.code).toBe(oracleShown(byCode.get(e.code), { sem: Number(e.sem) === 1 ? 1 : 2, study: STUDY }));
    }
    const ref = reference(plan.entries, STUDY, [], refData(data));
    expect(ref.standings.map((s) => s.standing)).toEqual(plan.entries.map((e) => e.standing));
    expect(plan.totals).toEqual(ref.totals);
    // A closed entry is never counted; the Business pick is "only if invited" (no `inv`).
    const units = (/** @type {string} */ sem, /** @type {string} */ st) => plan.entries.filter((e) => e.which === 'pick' && e.sem === sem && e.standing === st).reduce((a, e) => a + e.credits, 0);
    for (const s of /** @type {const} */ (['1', '2'])) expect(plan.totals[s]).toEqual({ counted: units(s, 'counted'), confirm: units(s, 'confirm'), invite: units(s, 'invite') });
  });

  it('the link holds the entries in rank order, at ug2, opening the view', () => {
    const params = new URLSearchParams(plan.link);
    expect(params.get('ng')).toBe('1');
    expect(params.get('study')).toBe(STUDY);
    expect(params.get('view')).toBe('shortlist');
    expect(params.getAll('pick')).toEqual(plan.entries.filter((e) => e.which === 'pick').map((e) => `${e.code}.${e.sem}`));
    expect(params.getAll('alt')).toEqual(plan.entries.filter((e) => e.which === 'alt').map((e) => `${e.code}.${e.sem}`));
  });

  it('the same seed draws the same list, whatever the modules\' order; another seed differs', () => {
    expect(makePlan({ ...data, modules: [...data.modules].reverse() }, 6).entries).toEqual(plan.entries);
    expect(makePlan(data, 7).entries.map((e) => e.code)).not.toEqual(plan.entries.map((e) => e.code));
  });
});

describe('the 404 codes and the calls', () => {
  it('one code of each kind, none offered; the NG-listed one has no classes, the catalogue-only one isn\'t NG-listed', () => {
    expect(plan.missing.map((m) => m.kind)).toEqual(['ng-listed', 'catalogue-only', 'unknown']);
    const [listed, catalogue, unknown] = plan.missing;
    for (const m of plan.missing) expect(byCode.has(m.code), m.code).toBe(false);
    expect(data.unscheduled.map((m) => m.code)).toContain(listed.code);
    expect(data.catalogueOnly).toContain(catalogue.code);
    expect(data.unscheduled.map((m) => m.code)).not.toContain(catalogue.code);
    expect(data.catalogueCodes.has(unknown.code)).toBe(false);
    expect(data.catalogueOnly).not.toContain(unknown.code);
  });

  it('a known code can\'t stand for the unknown one', () => {
    expect(() => draw404({ ...data, catalogueCodes: new Set([...data.catalogueCodes, 'CS9999']) }, rng(6))).toThrow(/known code/);
  });

  it('12 calls: /facets, the 8 entries\' /module, the 3 404s\', each once', () => {
    expect(plan.calls).toEqual(['/facets', ...plan.entries.map((e) => `/module/${e.code}`), ...plan.missing.map((m) => `/module/${m.code}`)]);
    expect(new Set(plan.calls).size).toBe(12);
  });
});

describe('reading and comparing totals', () => {
  const ref = { 1: { counted: 8, confirm: 4, invite: 4 }, 2: { counted: 4.5, confirm: 0, invite: 0 } };

  it('reads the CSV\'s totals as the page words them (shortlist.js totalLines), through the file\'s own writer', () => {
    /** @param {string} sem @param {any} t */
    const lines = (sem, t) => totalLines(/** @type {'1' | '2'} */ (sem), { hours: 0, pending: 0, economics: 0, overlap: false, ...t }, { exchange: true, year: '2026/27' });
    const columns = [{ key: 'a', label: 'Section' }, { key: 'b', label: 'Code' }, { key: 'c', label: 'Title' }];
    const doc = /** @type {any} */ ({
      columns, head: [{ label: 'Made', value: '-1 day' }], form: { intro: 'x', tables: [], applicants: [] }, courseReg: { heading: 'CourseReg', rules: [], page: 'p' }, closing: [],
      sections: [{ heading: 'Sem 1', groups: [], totals: lines('1', ref[1]) }, { heading: 'Sem 2', groups: [], totals: lines('2', ref[2]) }],
    });
    const records = parseCsv(toCsv(doc).slice(1));
    const sep = records.findIndex((r) => r.every((f) => f === ''));
    const got = csvTotals(records.slice(sep + 1));
    expect(got).toEqual({ 1: { ...ref[1], atLeast: false }, 2: { ...ref[2], atLeast: false } });
    expect(totalsProblems('the CSV', ref, got)).toEqual([]);
  });

  it('reads the view\'s card text; "at least" is read, and fails', () => {
    expect(readTotals(['8 units counted, if NUS accepts you into each', 'plus 4 units to confirm with NUS', 'plus 4 units only if invited', '8 units is about 20 hours a week'])).toEqual({ counted: 8, confirm: 4, invite: 4, atLeast: false });
    expect(readTotals(['at least 4.5 units counted, if NUS accepts you into each'])).toEqual({ counted: 4.5, confirm: 0, invite: 0, atLeast: true });
    expect(readTotals(['nothing here'])).toBeNull();
    const got = { 1: { ...ref[1], atLeast: false }, 2: { ...ref[2], atLeast: true } };
    expect(totalsProblems('the view', ref, got)).toEqual(['the view: Sem 2 says "at least" (a row not loaded)']);
  });

  it('names each difference, and a semester missing', () => {
    const got = { 1: { counted: 4, confirm: 4, invite: 0, atLeast: false } };
    expect(totalsProblems('the view', ref, got)).toEqual([
      'the view: Sem 1 counted 4, the reference 8', 'the view: Sem 1 invite 0, the reference 4', 'the view: no Sem 2 totals',
    ]);
  });

  it('the view\'s and the CSV\'s wording stay what the readers read (the page\'s own sources)', () => {
    const view = readFileSync(new URL('../public/shortlist-view.js', import.meta.url), 'utf8');
    for (const s of [' units counted, if NUS accepts you into each', ' units to confirm with NUS', ' units only if invited', 'picks`)', 'sl-sum']) expect(view).toContain(s);
  });
});
