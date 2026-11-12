// @ts-check
// SC1 path tests (docs/plans/phase4.md 4E): over production's corpus
// (`current` in data/corpus.json, D1 seeded through /admin/ingest) and the
// production bundle, vocabulary, groups and catalogue (Phase 7 7D), for each
// of the 15 (sem, study) combinations, every exchange-mode path shows
// exactly the modules the independent oracle (test/sc1/oracle.mjs)
// calls open or noted:
// - set equality per path filter: the lexical filter SQL over every D1 row,
//   compileMask over every bundle row, the D1 recheck over every row;
// - the standby (the fake Vectorize holding the bundle's vectors, then the
//   recheck): no leaks (its recall@50 floor is a fact of the pinned corpus,
//   asserted in test/full/sc1-pinned.test.js; here it is logged);
// - pins, 3F variants and a not-offered code's `related`: a code search for
//   every NG code shows it exactly when the oracle does; no closed variant;
//   no closed neighbour;
// - Phase 5 5C-api's `exchangeBySem`: with no sem, each semester's status on
//   a shown NG code's card equals the oracle's for that semester;
// - R3 (ADR 0008): the year-of-study note, read from the prerequisite at
//   request time, is on a card and in /module/:code exactly where the
//   oracle's own reading of the prerequisite puts it, on the pins, the bundle,
//   the standby, the mask route and exchangeBySem; it never hides a course;
// - R6-2 (ADR 0010): GRO's level 4000 note, read from the row's level and
//   faculty at request time, is on every card and /module/:code entry where
//   the oracle's own reading (code and faculty) puts it, and nowhere else: the
//   pins over every NG code, exchangeBySem and every offered code's 15
//   entries; it never hides a course;
// - Phase 6 6A: /module/:code's `exchange`, what the shortlist reads, equals
//   the oracle's (with R3 and R6-2) for every offered code, NG-listed or not, and for
//   every NG-listed code with no classes (data/ng-unscheduled.json), whose
//   404 answers it; a typed one is
//   never ranked.
// - Phase 6 6C: the shortlist (public/shortlist.js) over the same answers, at
//   Sem 1 and Sem 2, each study level and browse mode: a closed case is never
//   counted, has no form number and carries its stamp (test/shortlist-sc1.js).
// Its own vitest project and CI job (`npm run test:sc1`), with its own
// timeout. Skipped without `current` restored (npm run corpus -- restore) and
// the production bundle; the sc1 CI job sets PRODUCTION_CORPUS=1, so a missing
// one fails there instead, and its guard fails on any skipped test.
import { env } from 'cloudflare:workers';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import catalogueFile from 'catalogue-only-data';
import { denseBundle } from '../../src/dense.js';
import { groups } from '../../src/group-data.js';
import { filterSql } from '../../src/lexical.js';
import { RESULT_COLUMNS } from '../../src/modules.js';
import { unscheduled } from '../../src/ng-unscheduled.js';
import { storedVectorMetadata } from '../../src/rowhash.js';
import { localMatchesFilters } from '../../src/search.js';
import { STUDIES } from '../../src/ng-bit.js';
import { compileMask } from '../../src/vector-bundle.js';
import { createFakes } from '../fakes.js';
import { adminCall, call, callJson, seed } from '../helpers.js';
import { shortlistAgainstOracle } from '../shortlist-sc1.js';
import * as live from './oracle.mjs';
import { COMBOS, QUERIES, shownCodes as shown } from './shared.js';

const corpus = inject('corpus');
// Phase 7 7E: the oracle for the corpus's year (test/sc1/oracle.mjs picks it); the live year's without one.
const { levelNoteOf, oracle, oracleShown, yearNoteOf } = corpus ? await live.oracleFor(corpus.acadYear) : live;

describe.skipIf(!corpus)('SC1: every exchange-mode path agrees with the oracle', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  /** @param {string} code @param {(typeof COMBOS)[number]} k */
  const shownByOracle = (code, k) => oracle(/** @type {NormalisedModule} */ (moduleOf.get(code)), { sem: k.sem, study: k.study }) !== 'closed';
  /** @param {(typeof COMBOS)[number]} k */
  const oracleSet = (k) => c.modules.filter((m) => shownByOracle(m.code, k)).map((m) => m.code).sort();
  /** Whether an exchange entry carries R3's note. @param {any} e */
  const hasYear = (e) => (e?.reasons ?? []).some((/** @type {any} */ r) => r.id === 'prereq:year-of-study');
  /** How many times an exchange entry carries R6-2's note (once at most). @param {any} e */
  const groCount = (e) => (e?.reasons ?? []).filter((/** @type {any} */ r) => r.id === 'gro:level-4000').length;
  /**
   * What is wrong with a card's exchange entry against the oracle with R3 and R6-2, or ''.
   * @param {NormalisedModule} m @param {any} e @param {1 | 2 | 'any'} sem @param {import('../../src/ng-bit.js').Study} study
   */
  const entryWrong = (m, e, sem, study) => {
    const want = oracleShown(m, { sem, study });
    const year = want !== 'closed' && yearNoteOf(m, study) !== null;
    const gro = want !== 'closed' && levelNoteOf(m, study) !== null ? 1 : 0;
    return e?.status === want && hasYear(e) === year && groCount(e) === gro ? ''
      : `${m.code} ${study} sem ${sem}: ${e?.status}${hasYear(e) ? ' +year' : ''}${groCount(e) ? ` +gro×${groCount(e)}` : ''}, oracle ${want}${year ? ' +year' : ''}${gro ? ' +gro' : ''}`;
  };
  const fakes = createFakes();

  beforeAll(async () => {
    // ~18k searches each log a line; keep the output to what the tests report.
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await seed({ modules: c.modules, fakes });
    // The standby holds the bundle's vectors, so it and the bundle rank in one space.
    const b = denseBundle();
    fakes.vectorize.vectors = new Map(b.codes.map((code, i) => [code, {
      id: code, values: Array.from(b.vectors.subarray(i * b.dims, (i + 1) * b.dims)),
      metadata: storedVectorMetadata(/** @type {NormalisedModule} */ (moduleOf.get(code))),
    }]));
    const rows = /** @type {[string, string, string | null][]} */ (catalogueFile.rows).slice(0, 200);
    const upsert = rows.map(([code, title, description]) => ({ code, title, description, acadYear: c.acadYear }));
    for (let i = 0; i < upsert.length; i += 100) {
      const res = await adminCall('/admin/catalogue', createFakes(), { upsert: upsert.slice(i, i + 100) });
      if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
    }
  }, 600_000);
  afterAll(() => { vi.restoreAllMocks(); });

  it('set equality: the lexical filter SQL, the bundle mask and the D1 recheck each equal the oracle\'s open ∪ note', async () => {
    const b = denseBundle();
    const { results: rows } = /** @type {D1Result<import('../../src/modules.js').ResultRow>} */ (
      await env.DB.prepare(`SELECT ${RESULT_COLUMNS} FROM modules`).all());
    expect(rows.length).toBe(c.modules.length);
    for (const k of COMBOS) {
      const want = oracleSet(k);
      expect(want.length, k.qs).toBeGreaterThan(500);
      const { clauses, binds } = filterSql(k.echo);
      const { results } = /** @type {D1Result<{ code: string }>} */ (
        await env.DB.prepare(`SELECT m.code FROM modules m WHERE ${clauses.join(' AND ')} ORDER BY m.code`).bind(...binds).all());
      expect(results.map((r) => r.code), `lexical ${k.qs}`).toEqual(want);
      const mask = /** @type {(i: number) => boolean} */ (compileMask(b, k.echo));
      expect(b.codes.filter((_, i) => mask(i)).sort(), `bundle ${k.qs}`).toEqual(want);
      expect(rows.filter((r) => localMatchesFilters(r, k.echo)).map((r) => r.code).sort(), `recheck ${k.qs}`).toEqual(want);
    }
  }, 300_000);

  it('the standby and the bundle leak nothing; the standby\'s recall@50 against the bundle is logged', async () => {
    /** @type {string[]} */
    const recalls = [];
    for (const k of COMBOS) {
      let sum = 0;
      for (const q of QUERIES) {
        const path = `/search?q=${encodeURIComponent(q)}&${k.qs}&mode=vector&topK=50`;
        const bundle = await callJson(path, { fakes, env: { COLLAPSE_GROUPS: 'off' } });
        const standby = await callJson(path, { fakes, env: { DENSE_BACKEND: 'vectorize', COLLAPSE_GROUPS: 'off' } });
        for (const code of shown(standby.body)) expect(shownByOracle(code, k), `${path} standby ${code}`).toBe(true);
        for (const code of shown(bundle.body)) expect(shownByOracle(code, k), `${path} bundle ${code}`).toBe(true);
        const want = new Set(shown(bundle.body));
        sum += want.size ? shown(standby.body).filter((x) => want.has(x)).length / want.size : 1;
      }
      const mean = sum / QUERIES.length;
      recalls.push(`${k.qs} ${mean.toFixed(3)}`);
    }
    console.info(`SC1 standby recall@50 by combination:\n  ${recalls.join('\n  ')}`);
  }, 600_000);

  it('pins: a code search for every NG code shows it exactly when the oracle does, with the oracle\'s status, R3 note and R6-2 note', async () => {
    const ngCodes = c.modules.filter((m) => m.ng).map((m) => m.code);
    expect(ngCodes.length).toBeGreaterThan(1000);
    /** @type {string[]} */
    const wrong = [];
    let years = 0;
    let gros = 0;
    for (const code of ngCodes) {
      const m = /** @type {NormalisedModule} */ (moduleOf.get(code));
      for (const k of COMBOS) {
        const { body } = await callJson(`/search?q=${code}&${k.qs}&mode=lexical&topK=5`, { fakes });
        if (shown(body).includes(code) !== shownByOracle(code, k)) wrong.push(`${code} ${k.qs}`);
        const card = body.results.find((/** @type {any} */ r) => r.code === code);
        if (!card) continue;
        const bad = entryWrong(m, card.exchange, k.sem, k.study);
        if (bad) wrong.push(bad);
        if (hasYear(card.exchange)) years++;
        gros += groCount(card.exchange);
      }
    }
    expect(wrong).toEqual([]);
    // R3 reaches real cards: AR4601 and others at a home year below theirs.
    expect(years).toBeGreaterThan(20);
    // R6-2 reaches real cards: 245 level 4000 NG courses outside Law, each at some undergraduate (sem, study).
    expect(gros).toBeGreaterThan(1000);
  }, 600_000);

  it('R3: the year-of-study note on the bundle, the standby, a vector-only search, the mask route and /module/:code', async () => {
    // NUS glues keywords to "must" ("DANDmust be Year 4"), so no word boundary before it.
    const yearCodes = c.modules.filter((m) => m.ng && /must\s*be\s*(?:in\s*)?year\s*\d/i.test(m.prerequisite ?? ''));
    // The 10 NG courses whose prerequisite names a year: 9 handled, EE4204 left alone (its year is an alternative).
    expect(yearCodes.length).toBeGreaterThanOrEqual(10);
    expect(yearCodes.filter((m) => yearNoteOf(m, 'ug1') !== null).length).toBeGreaterThanOrEqual(9);
    /** @type {string[]} */
    const wrong = [];
    let cards = 0;
    for (const m of yearCodes) {
      const prefix = m.code.slice(0, m.code.search(/\d/) + 2);
      for (const k of COMBOS) {
        for (const [q, extra, envOver] of /** @type {[string, string, Record<string, string>][]} */ ([
          [m.title, '', {}], [m.title, '&mode=vector', {}], [m.title, '', { DENSE_BACKEND: 'vectorize' }], [prefix, '', {}],
        ])) {
          const path = `/search?q=${encodeURIComponent(q)}&${k.qs}&topK=50${extra}`;
          const { body } = await callJson(path, { fakes, env: envOver });
          const card = body.results.find((/** @type {any} */ r) => r.code === m.code);
          if (!card) continue;
          cards++;
          const bad = entryWrong(m, card.exchange, k.sem, k.study);
          if (bad) wrong.push(`${path} ${envOver.DENSE_BACKEND ?? ''}: ${bad}`);
          if (k.sem === 'any') {
            for (const sem of /** @type {const} */ ([1, 2])) {
              const bySem = entryWrong(m, card.exchangeBySem?.[sem], sem, k.study);
              if (bySem) wrong.push(`${path} exchangeBySem: ${bySem}`);
            }
          }
        }
      }
      const { body } = await callJson(`/module/${m.code}`);
      for (const e of body.exchange) {
        const bad = entryWrong(m, e, e.sem, e.study);
        if (bad) wrong.push(`/module: ${bad}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(cards).toBeGreaterThan(100);
  }, 600_000);

  it('exchangeBySem (Phase 5 5C-api): with no sem, each semester\'s entry on a shown NG code\'s card equals the oracle\'s (with R3 and R6-2)', async () => {
    const ngModules = c.modules.filter((m) => m.ng);
    /** @type {string[]} */
    const wrong = [];
    let checked = 0;
    for (const m of ngModules) {
      for (const study of STUDIES) {
        const { body } = await callJson(`/search?q=${m.code}&ng=1&study=${study}&mode=lexical&topK=5`, { fakes });
        const card = body.results.find((/** @type {any} */ r) => r.code === m.code);
        if (!card) continue;
        for (const sem of /** @type {const} */ ([1, 2])) {
          const bad = entryWrong(m, card.exchangeBySem?.[sem], sem, study);
          if (bad) wrong.push(`exchangeBySem: ${bad}`);
          checked++;
        }
      }
    }
    expect(wrong).toEqual([]);
    expect(checked).toBeGreaterThan(5000);
  }, 600_000);

  it('6A: /module/:code\'s exchange equals the oracle\'s (with R3 and R6-2) for every offered code and every NG-listed code with no classes', async () => {
    /** @type {string[]} */
    const wrong = [];
    let entries = 0;
    /** Offered codes whose /module answer carries R6-2's note somewhere. @type {Set<string>} */
    const groCodes = new Set();
    for (const m of c.modules) {
      const { status, body } = await callJson(`/module/${m.code}`);
      if (status !== 200) { wrong.push(`${m.code}: HTTP ${status}`); continue; }
      for (const e of body.exchange) {
        const bad = entryWrong(m, e, e.sem, e.study);
        if (bad) wrong.push(`/module: ${bad}`);
        if (groCount(e)) groCodes.add(m.code);
        entries++;
      }
    }
    // R6-2's reach over the offered codes: every one on the NG list. Its size is a fact of the
    // corpus (245 over the pinned one, docs/evidence/phase6/gates.md "R6-2"), so it is logged.
    expect(groCodes.size).toBeGreaterThan(0);
    expect([...groCodes].every((code) => moduleOf.get(code)?.ng)).toBe(true);
    const classless = [...unscheduled().values()];
    expect(classless.length).toBeGreaterThan(0);
    console.info(`6A over production: R6-2's note on ${groCodes.size} offered codes; ${classless.length} NG-listed codes with no classes`);
    for (const u of classless) {
      const m = /** @type {NormalisedModule} */ (/** @type {unknown} */ ({
        code: u.code, title: u.title, department: u.department, faculty: u.faculty, level: u.level,
        semesters: [], ng: true, ngSemesters: u.ngSemesters, prerequisite: u.prerequisite,
      }));
      const { status, body } = await callJson(`/module/${u.code}`);
      if (status !== 404 || body.kind !== 'ng-listed') { wrong.push(`${u.code}: HTTP ${status} ${body.kind}`); continue; }
      for (const e of body.exchange) {
        const bad = entryWrong(m, e, e.sem, e.study);
        if (bad) wrong.push(`/module 404: ${bad}`);
        entries++;
      }
      for (const k of COMBOS) {
        const typed = await callJson(`/search?q=${u.code}&${k.qs}&mode=lexical&topK=5`, { fakes });
        if (shown(typed.body).includes(u.code)) wrong.push(`${u.code} ${k.qs}: ranked`);
        if (typed.body.noMatch?.reason !== 'ng-unscheduled') wrong.push(`${u.code} ${k.qs}: noMatch ${typed.body.noMatch?.reason}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(entries).toBe((c.modules.length + classless.length) * 15);
  }, 600_000);

  it('6C: the shortlist over every offered code and every NG-listed code with no classes agrees with the oracle', async () => {
    const classless = [...unscheduled().values()].map((u) => ({
      code: u.code, title: u.title, department: u.department, faculty: u.faculty, level: u.level,
      semesters: [], ng: true, ngSemesters: u.ngSemesters, prerequisite: u.prerequisite,
    }));
    const all = [...c.modules, ...classless];
    /** @type {typeof fetch} */
    const pageFetch = /** @type {any} */ ((/** @type {string} */ url) => call(String(url), { fakes }));
    const { wrong, closed, shown, browse } = await shortlistAgainstOracle(/** @type {any[]} */ (all), pageFetch);
    expect(wrong).toEqual([]);
    expect(closed + shown).toBe(all.length * 10);
    expect(browse).toBe(all.length * 2);
  }, 600_000);

  it('variants: no group shows a closed member', async () => {
    const { members } = groups();
    const ngGroups = [...members.values()].filter((ms) => ms.some((m) => moduleOf.get(m)?.ng));
    expect(ngGroups.length).toBeGreaterThan(0);
    for (const ms of ngGroups) {
      for (const k of COMBOS) {
        const { body } = await callJson(`/search?q=${encodeURIComponent(ms.join(' '))}&${k.qs}&topK=20`, { fakes });
        for (const code of shown(body)) expect(shownByOracle(code, k), `${ms.join(',')} ${k.qs} ${code}`).toBe(true);
      }
    }
  }, 300_000);

  it('related: a not-offered code\'s neighbours are never closed, on the bundle and the standby', async () => {
    const codes = /** @type {[string, string, string | null][]} */ (catalogueFile.rows).slice(0, 10).map(([code]) => code);
    let seen = 0;
    for (const code of codes) {
      for (const k of COMBOS) {
        for (const envOver of [{}, { DENSE_BACKEND: 'vectorize' }]) {
          const { body } = await callJson(`/search?q=${code}&${k.qs}`, { fakes, env: envOver });
          expect(body.noMatch?.reason, code).toBe('not-offered');
          for (const r of body.noMatch.related) expect(shownByOracle(r, k), `${code} ${k.qs} ${r}`).toBe(true);
          seen += body.noMatch.related.length;
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
  }, 300_000);
});
