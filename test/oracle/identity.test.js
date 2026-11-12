// @ts-check
// Per-list identity on dev: the allow-mask bit removes the closed modules and
// changes nothing else, checked without a holdout look. Each of the 98 dev
// queries (with `study` from eval/study-map.json, as the eval runner sends it)
// is run three ways on production's corpus (`current`) and bundle:
// - the page (the shipped pipeline);
// - ORACLE_TRACE=1: the same request, returning its internal lists (pins, the
//   dense, lexical and code lists, the mask route's list) and their depths;
// - ORACLE_TRACE=ignore: the lists with the yearly ng flag and no allow-mask bit,
//   at full depth.
// Each ignore-mode list, kept to the modules the independent oracle shows for
// the query's (sem, study) and cut at the depth the pipeline used, must equal
// the filtered list exactly; and the page must equal the first topK of
// collapse(pins ++ fuse(filtered lists) − pins), recomputed here, with each
// group shown by its semester representative (src/groups.js
// semesterRepresentative: with a semester, the group's highest-ranked member
// on that semester's timetable when its first is not). So the bit removes
// exactly the closed modules and changes nothing else. These are invariants,
// true of any corpus; the no-signal check's (no dev query outside the no-answer
// tag that the bit pushes into no-signal) is a fact of the pinned corpus and is
// asserted over it in test/full/oracle-pinned.test.js. The trace is test-only
// (src/search.js oracleTraceMode).
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import catalogueFile from 'catalogue-only-data';
import devQueries from '../../eval/dev/queries.json';
import studyMap from '../../eval/study-map.json';
import { groups } from '../../src/group-data.js';
import { groupKeyOf } from '../../src/groups.js';
import { fuse } from '../../src/search.js';
import { createFakes } from '../fakes.js';
import { adminCall, callJson, seed } from '../helpers.js';
import * as live from './oracle.mjs';
import { CacheAI, ngDevRequests } from './shared.js';

/** The page size the dev queries get: src/search.js DEFAULT_TOPK (they send no topK). */
const PAGE_SIZE = 20;
const corpus = inject('corpus');
// The oracle for the corpus's year (test/oracle/oracle.mjs picks it); the live year's without one.
const { oracle } = corpus ? await live.oracleFor(corpus.acadYear) : live;

describe.skipIf(!corpus)('per-list identity on dev', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  const fakes = createFakes();
  fakes.ai = /** @type {any} */ (new CacheAI());

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Ingest embeds with the default fake; searches embed from the committed caches.
    await seed({ modules: c.modules });
    const rows = /** @type {[string, string, string | null][]} */ (catalogueFile.rows);
    for (let i = 0; i < rows.length; i += 100) {
      const upsert = rows.slice(i, i + 100).map(([code, title, description]) => ({ code, title, description, acadYear: c.acadYear }));
      const res = await adminCall('/admin/catalogue', createFakes(), { upsert });
      if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status}`);
    }
  }, 600_000);

  it('each list is the ignore-mode list projected by the oracle and cut at its depth; the page is their fusion', async () => {
    const { groupOf } = groups();
    /** @type {string[]} */
    const problems = [];
    /** @type {string[]} */
    const noSignal = [];
    let compared = 0, ignoreShowedClosed = 0, degraded = 0, refused = 0, swapped = 0;
    for (const { q, study, sem, path } of ngDevRequests(devQueries.queries, studyMap)) {
      /** @param {string} code */
      const shows = (code) => oracle(/** @type {NormalisedModule} */ (moduleOf.get(code)), { sem, study: /** @type {any} */ (study) }) !== 'closed';
      /** @param {string} code */
      const offered = (code) => sem !== 'any' && (moduleOf.get(code)?.semesters ?? []).includes(sem);
      /**
       * The member shown for `code`'s group: `code`, unless a semester is named, `code` is
       * off its timetable and is not a pin; then its group's first member in `ranked` on it.
       * @param {string[]} ranked @param {string[]} pins
       */
      const representative = (ranked, pins) => (/** @type {string} */ code) => {
        if (sem === 'any' || pins.includes(code) || offered(code)) return code;
        const k = groupKeyOf(groupOf, code);
        return ranked.find((x) => groupKeyOf(groupOf, x) === k && offered(x)) ?? code;
      };

      const page = await callJson(path, { fakes });
      const traced = await callJson(path, { fakes, env: { ORACLE_TRACE: '1' } });
      const ignored = await callJson(path, { fakes, env: { ORACLE_TRACE: 'ignore' } });
      // A request /search refuses (an over-long query) is refused the same way in all three.
      expect([traced.status, ignored.status], path).toEqual([page.status, page.status]);
      if (page.status !== 200) { refused++; continue; }
      expect(traced.headers.get('cache-control'), path).toBe('no-store');
      const t = traced.body.oracle, u = ignored.body.oracle;
      if (page.body.noMatch?.reason === 'no-signal') noSignal.push(`${q.id} [${q.shapes.join(',')}] topCosine ${t.topCosine}`);
      if (page.body.noMatch) continue;
      if (t.degraded) degraded++;
      // Every module the page shows passes the bit.
      for (const code of page.body.results.map((/** @type {any} */ r) => r.code)) if (!shows(code)) problems.push(`${q.id}: page shows closed ${code}`);
      /** @param {string} name @param {string[] | null | undefined} filtered @param {string[] | null | undefined} full @param {number} [depth] */
      const same = (name, filtered, full, depth) => {
        if (filtered == null && full == null) return;
        const projected = (full ?? []).filter(shows).slice(0, depth ?? Infinity);
        if (JSON.stringify(projected) !== JSON.stringify(filtered ?? [])) {
          problems.push(`${q.id} ${name}: filtered ${JSON.stringify((filtered ?? []).slice(0, 8))}… vs projected ${JSON.stringify(projected.slice(0, 8))}…`);
        }
        if ((full ?? []).slice(0, depth ?? Infinity).some((x) => !shows(x))) ignoreShowedClosed++;
      };
      const got = page.body.results.map((/** @type {any} */ r) => r.code);
      if (t.mask !== undefined) {
        same('mask', t.mask, u.mask, t.maskDepth);
        // The mask page: its members in order, one per duplicate group, to the page size.
        const seenMask = new Set();
        const wantMask = t.mask.filter((/** @type {string} */ x) => {
          const k = groupKeyOf(groupOf, x);
          return seenMask.has(k) ? false : (seenMask.add(k), true);
        }).slice(0, PAGE_SIZE).map(representative(t.mask, []));
        if (JSON.stringify(got) !== JSON.stringify(wantMask)) problems.push(`${q.id} mask page: ${JSON.stringify(got.slice(0, 6))}… vs ${JSON.stringify(wantMask.slice(0, 6))}…`);
        compared++;
        continue;
      }
      same('pins', t.pins, u.pins);
      same('dense', t.dense, u.dense, t.depth);
      same('lexical', t.lexical, u.lexical, t.depth);
      same('code', t.code, u.code, t.depth);
      // The page from the filtered lists: pins, then the fusion without them, one per duplicate group.
      const lists = t.degraded ? [t.lexical] : [t.dense, t.lexical];
      if (t.code) lists.push(t.code);
      const want = [...t.pins];
      const seen = new Set(want.map((/** @type {string} */ x) => groupKeyOf(groupOf, x)));
      const fused = fuse(lists).map((f) => f.code);
      // Built to the page size from the lists alone, so a page cut short fails.
      for (const code of fused) {
        if (want.length >= PAGE_SIZE) break;
        if (t.pins.includes(code)) continue;
        const k = groupKeyOf(groupOf, code);
        if (seen.has(k)) continue;
        seen.add(k);
        want.push(code);
      }
      const shown = want.map(representative(fused, t.pins));
      if (JSON.stringify(got) !== JSON.stringify(shown)) problems.push(`${q.id} page: ${JSON.stringify(got.slice(0, 6))}… vs fused ${JSON.stringify(shown.slice(0, 6))}…`);
      if (shown.some((x, i) => x !== want[i])) swapped++;
      compared++;
    }
    console.info(`gate 2: ${compared} dev queries compared, ${refused} refused (400) all three ways, ${degraded} on the keyword-only path (no committed embedding), `
      + `${ignoreShowedClosed} ignore-mode lists held a closed module in their top depth, ${swapped} pages show a semester representative; `
      + `no-signal: ${noSignal.join('; ') || 'none'}`);
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThan(80);
    // The ignore mode really ignores the bit: some unfiltered top lists hold closed modules.
    expect(ignoreShowedClosed).toBeGreaterThan(0);
  }, 900_000);
});
