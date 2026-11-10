// @ts-check
// Phase 4 gate 2, per-list identity on dev (docs/plans/phase4.md §4): no
// holdout look gates Phase 4's correctness changes, so each of the 98 dev
// queries (with `study` from eval/study-map.json, as the eval runner sends it)
// is run three ways on the pinned corpus and bundle:
// - the page (the shipped pipeline);
// - SC1_TRACE=1: the same request, returning its internal lists (pins, the
//   dense, lexical and code lists, the mask route's list) and their depths;
// - SC1_TRACE=ignore: the lists with the yearly ng flag and no allow-mask bit,
//   at full depth.
// Each ignore-mode list, kept to the modules the independent oracle shows for
// the query's (sem, study) and cut at the depth the pipeline used, must equal
// the filtered list exactly; and the page must equal the first topK of
// collapse(pins ++ fuse(filtered lists) − pins), recomputed here. So the bit
// removes exactly the closed modules and changes nothing else. 3G: a dev query
// outside the no-answer tag that the bit pushes into no-signal fails the gate
// until Jacob rules on it. The trace is test-only (src/search.js sc1TraceMode).
import { beforeAll, describe, expect, inject, it, vi } from 'vitest';
import catalogueFile from '../../data/catalogue-only.json';
import devEmbeddings from '../../eval/dev/embeddings.json';
import devQueries from '../../eval/dev/queries.json';
import studyMap from '../../eval/study-map.json';
import correctedEmbeddings from '../fixtures/sc4-corrected-embeddings.json';
import sc4Embeddings from '../sc4/embeddings.json';
import { groups } from '../../src/group-data.js';
import { groupKeyOf } from '../../src/groups.js';
import { sha256Hex } from '../../src/rowhash.js';
import { fuse } from '../../src/search.js';
import { createFakes } from '../fakes.js';
import { adminCall, callJson, seed } from '../helpers.js';
import { oracle } from './oracle.node.mjs';

/** The page size the dev queries get: src/search.js DEFAULT_TOPK (they send no topK). */
const PAGE_SIZE = 20;
const corpus = inject('corpus');
const bundleKind = inject('vectorsBundle');

/** @type {Record<string, string>} */
const ENTRIES = { ...devEmbeddings.entries, ...sc4Embeddings.entries, .../** @type {Record<string, string>} */ (correctedEmbeddings.entries) };

/** Workers AI answered from the committed caches; a text without one throws (the dense half degrades, the same in all three calls). */
class CacheAI {
  /** @param {string} model @param {{ text: string | string[] }} input */
  async run(model, input) {
    const texts = Array.isArray(input.text) ? input.text : [input.text];
    /** @type {number[][]} */
    const data = [];
    for (const text of texts) {
      const b64 = ENTRIES[await sha256Hex(`${model}\n${text}`)];
      if (!b64) throw new Error('no committed embedding for this text');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      data.push(Array.from(new Float32Array(bytes.buffer)));
    }
    return { shape: [texts.length, 384], data, pooling: 'mean' };
  }
}

describe.skipIf(!corpus || bundleKind !== 'pinned')('gate 2: per-list identity on dev', () => {
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
    let compared = 0, ignoreShowedClosed = 0, degraded = 0, refused = 0;
    for (const q of /** @type {any[]} */ (devQueries.queries)) {
      const f = q.filters ?? {};
      if (!f.ng) continue;
      const study = /** @type {Record<string, string>} */ (studyMap.personas)[q.persona] ?? studyMap.noPersona;
      const sem = f.sem === 1 || f.sem === 2 ? f.sem : 'any';
      const params = new URLSearchParams({ q: q.text, ng: '1', study });
      for (const k of ['sem', 'level', 'credits', 'faculty']) if (f[k] !== undefined) params.set(k, String(f[k]));
      const path = `/search?${params}`;
      /** @param {string} code */
      const shows = (code) => oracle(/** @type {NormalisedModule} */ (moduleOf.get(code)), { sem, study: /** @type {any} */ (study) }) !== 'closed';

      const page = await callJson(path, { fakes });
      const traced = await callJson(path, { fakes, env: { SC1_TRACE: '1' } });
      const ignored = await callJson(path, { fakes, env: { SC1_TRACE: 'ignore' } });
      // A request /search refuses (an over-long query) is refused the same way in all three.
      expect([traced.status, ignored.status], path).toEqual([page.status, page.status]);
      if (page.status !== 200) { refused++; continue; }
      expect(traced.headers.get('cache-control'), path).toBe('no-store');
      const t = traced.body.sc1, u = ignored.body.sc1;
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
        }).slice(0, PAGE_SIZE);
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
      // Built to the page size from the lists alone, so a page cut short fails.
      for (const { code } of fuse(lists)) {
        if (want.length >= PAGE_SIZE) break;
        if (t.pins.includes(code)) continue;
        const k = groupKeyOf(groupOf, code);
        if (seen.has(k)) continue;
        seen.add(k);
        want.push(code);
      }
      if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${q.id} page: ${JSON.stringify(got.slice(0, 6))}… vs fused ${JSON.stringify(want.slice(0, 6))}…`);
      compared++;
    }
    console.info(`gate 2: ${compared} dev queries compared, ${refused} refused (400) all three ways, ${degraded} on the keyword-only path (no committed embedding), `
      + `${ignoreShowedClosed} ignore-mode lists held a closed module in their top depth; no-signal: ${noSignal.join('; ') || 'none'}`);
    expect(problems).toEqual([]);
    expect(compared).toBeGreaterThan(80);
    // The ignore mode really ignores the bit: some unfiltered top lists hold closed modules.
    expect(ignoreShowedClosed).toBeGreaterThan(0);
    // 3G (plan §4 gate 2): a query outside the no-answer tag pushed into no-signal needs Jacob's ruling.
    expect(noSignal.filter((s) => !s.includes('noanswer'))).toEqual([]);
  }, 900_000);
});
