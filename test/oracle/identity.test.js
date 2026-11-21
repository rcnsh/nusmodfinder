// @ts-check
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

const PAGE_SIZE = 20;
const corpus = inject('corpus');
const { oracle } = corpus ? await live.oracleFor(corpus.acadYear) : live;

describe.skipIf(!corpus)('per-list identity on dev', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  const fakes = createFakes();
  fakes.ai = /** @type {any} */ (new CacheAI());

  beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
       * @param {string[]} ranked
       * @param {string[]} pins
       */
      const representative = (ranked, pins) => (/** @type {string} */ code) => {
        if (sem === 'any' || pins.includes(code) || offered(code)) return code;
        const k = groupKeyOf(groupOf, code);
        return ranked.find((x) => groupKeyOf(groupOf, x) === k && offered(x)) ?? code;
      };

      const page = await callJson(path, { fakes });
      const traced = await callJson(path, { fakes, env: { ORACLE_TRACE: '1' } });
      const ignored = await callJson(path, { fakes, env: { ORACLE_TRACE: 'ignore' } });
      expect([traced.status, ignored.status], path).toEqual([page.status, page.status]);
      if (page.status !== 200) { refused++; continue; }
      expect(traced.headers.get('cache-control'), path).toBe('no-store');
      const t = traced.body.oracle, u = ignored.body.oracle;
      if (page.body.noMatch?.reason === 'no-signal') noSignal.push(`${q.id} [${q.shapes.join(',')}] topCosine ${t.topCosine}`);
      if (page.body.noMatch) continue;
      if (t.degraded) degraded++;
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
      const lists = t.degraded ? [t.lexical] : [t.dense, t.lexical];
      if (t.code) lists.push(t.code);
      const want = [...t.pins];
      const seen = new Set(want.map((/** @type {string} */ x) => groupKeyOf(groupOf, x)));
      const fused = fuse(lists).map((f) => f.code);
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
    expect(ignoreShowedClosed).toBeGreaterThan(0);
  }, 900_000);
});
