// @ts-check
// The query suite through the real Worker, over the pinned vectors bundle and
// the pinned corpus loaded through /admin/ingest, with D1 catalogue_only loaded
// from `catalogue-only-data` (the pinned rows, built in memory) and the
// committed query embeddings (test/query-suite/embeddings.json, and
// eval/dev/embeddings.json for the four dev texts the suite allows) answering
// Workers AI. Typo-corrected forms come from
// test/fixtures/query-suite-corrected-embeddings.json
// (`npm run eval:embed -- --suite --corrected-from-ref <ref>`). Each item checks
// its exact `interpreted` and its rule.
//
// An item runs when every feature it needs is in force in this ranker
// (IN_FORCE). The row and the intents an item needs decide them: typo items
// need typo correction, gibberish items the no-signal check, a level phrase the
// level-phrase intent, an exam/S-U/workload/prerequisite phrase the constraint
// phrases; `count = G` with variants needs duplicate-group collapse. Everything
// else needs only code handling. Items not run are listed in one test, with the
// feature they wait for: the full-corpus CI job fails on any skipped test, so
// nothing here is it.skip. The typo, gibberish, non-existent-code and guard
// items are never skipped: without their feature they are listed as pending.
// When typo correction embeds its corrected text, an item whose corrected text
// has no committed embedding is listed as waiting on an embedding, with the
// command that makes it.
import { describe, expect, inject, it, beforeAll } from 'vitest';
import catalogueFile from 'catalogue-only-data';
import groupsFile from '../../eval/groups.json';
import gibberishFile from '../../eval/dev/gibberish.json';
import suiteFile from '../query-suite/queries.json';
import suiteEmbeddings from '../query-suite/embeddings.json';
import devEmbeddings from '../../eval/dev/embeddings.json';
import correctedEmbeddings from '../fixtures/query-suite-corrected-embeddings.json';
import { intentContext } from '../../src/intent-data.js';
import { INTENT, PARSE_PHRASES } from '../../src/intents.js';
import { canonicalQuery, parseQuery } from '../../src/query-intent.js';
import { denseTexts } from '../../src/search.js';
import { EMBED_CORRECTED } from '../../src/typo.js';
import { createFakes } from '../fakes.js';
import { adminCall, callJson, seed } from '../helpers.js';

const corpus = inject('corpus');
const bundleKind = inject('vectorsBundle');

/**
 * The features in force in this ranker. Level phrases are not among them (`level-phrases` items
 * are listed as skipped). Parsed constraint phrases run only while `PARSE_PHRASES` is on (off,
 * ADR 0006); with it off, the `[constraint params]` test checks the explicit params on the
 * full corpus.
 */
const IN_FORCE = new Set(['codes', 'typos', 'groups', 'no-signal', ...(PARSE_PHRASES ? ['constraint-phrases'] : [])]);
/** The prereq semantics substituted for `$selected`: the variant in force's (src/intents.js). */
const SELECTED_PREREQ = INTENT.prereq;
/** Rows whose items are never skipped: without their feature they are listed as pending. */
const NEVER_SKIPPED = new Set(['typo', 'gibberish', 'nonexistent-code', 'guard']);

/** @typedef {{ id: string, row: string, text: string, topK: number, rule: string, params: any, interpreted: any, origin: string }} Item */
const suite = /** @type {{ items: Item[], thresholds: { T: number, M: number } }} */ (/** @type {unknown} */ (suiteFile));

/**
 * The features an item needs. `partial` lists the clauses of a run item
 * that wait for a feature not in force (checked once it is).
 * @param {Item} item
 */
function ownership(item) {
  const i = item.interpreted;
  /** @type {Set<string>} */
  const needs = new Set(['codes']);
  if (item.row === 'typo') needs.add('typos');
  if (item.row === 'gibberish') needs.add('no-signal');
  // A level from a phrase needs level phrases; `XX N000` (the prefix-level rule) is code handling.
  if (i.level !== null && item.rule !== 'prefix-level-mask') needs.add('level-phrases');
  if (i.exam !== null || i.su !== null || i.hoursBelow !== null || i.prereq !== null) needs.add('constraint-phrases');
  /** @type {string[]} */
  const partial = item.rule === 'partial-mask' && !IN_FORCE.has('groups') ? ['count = G (group variants)'] : [];
  const waiting = [...needs].filter((w) => !IN_FORCE.has(w)).sort();
  return { needs: [...needs].sort(), waiting, partial };
}

/** The command that embeds the typo-corrected forms of the suite's texts. */
const EMBED_CORRECTED_COMMAND = 'npm run eval:embed -- --suite --corrected-from-ref typo-corrector';

const letters = (/** @type {string} */ c) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(c))[0];
/** @param {string} p @returns {[string, string]} */
const range = (p) => [/\d$/.test(p) ? p : `${p}0`, `${p}:`];
/** @param {string} code @param {string} p */
const inRange = (code, p) => { const [lo, hi] = range(p); return code >= lo && code < hi; };
/** @returns {string[]} */
const codesOf = (/** @type {any} */ body) => body.results.map((/** @type {{ code: string }} */ r) => r.code);

/** groups-v1, a singleton its own group. */
/** @type {Map<string, number>} */
const groupOf = new Map();
groupsFile.groups.forEach((g, i) => g.forEach((m) => groupOf.set(m, i)));
const gkey = (/** @type {string} */ c) => (groupOf.has(c) ? `g${groupOf.get(c)}` : c);
/** The group-first projection of a list. @param {string[]} list */
const projectGroups = (list) => { const seen = new Set(); return list.filter((c) => (seen.has(gkey(c)) ? false : (seen.add(gkey(c)), true))); };

/** @param {string} s */
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Every cache's entries: sha256(model + "\n" + text) → base64 float32. */
/** @type {Record<string, string>} */
const ENTRIES = { ...devEmbeddings.entries, ...suiteEmbeddings.entries, .../** @type {Record<string, string>} */ (correctedEmbeddings.entries) };
for (const cache of [suiteEmbeddings, devEmbeddings, correctedEmbeddings]) if (cache.model !== '@cf/baai/bge-small-en-v1.5' || cache.dims !== 384) throw new Error('unexpected embedding cache');

/**
 * The texts the dense half embeds for what an item sends (its text, a typo
 * item's clean form, a constraint reference) beyond the canonical query, as
 * the Worker's own parse gives them (denseTexts): the typo-corrected form and
 * the constraint-stripped form. Those with no committed embedding wait for one.
 * @param {Item} item
 */
async function missingCorrected(item) {
  const ctx = intentContext(() => false);
  /** @type {string[]} */
  const out = [];
  for (const text of [item.text, item.params.clean, item.params.reference].filter((t) => typeof t === 'string')) {
    const q = canonicalQuery(text.trim());
    for (const t of denseTexts(parseQuery(q, ctx))) {
      if (t !== q && !ENTRIES[await sha256Hex(`${suiteEmbeddings.model}\n${t}`)]) out.push(t);
    }
  }
  return out;
}

const READY = suite.items.filter((it) => ownership(it).waiting.length === 0);
/** Items whose features are in force but whose corrected forms have no committed embedding. @type {Item[]} */
const WAITING_EMBEDDING = [];
for (const item of READY) if ((await missingCorrected(item)).length) WAITING_EMBEDDING.push(item);
const RUN = READY.filter((it) => !WAITING_EMBEDDING.includes(it));
const NOT_RUN = suite.items.filter((it) => ownership(it).waiting.length > 0);

/** Workers AI answered from the committed caches; a text without a vector throws, never a made-up one. */
class SuiteAI {
  /** @type {{ method: string, args: unknown[] }[]} */
  calls = [];
  /** @type {string[]} */
  missing = [];
  /** @param {string} model @param {{ text: string | string[] }} input */
  async run(model, input) {
    this.calls.push({ method: 'run', args: [model, input] });
    const texts = Array.isArray(input.text) ? input.text : [input.text];
    /** @type {number[][]} */
    const data = [];
    for (const text of texts) {
      const b64 = ENTRIES[await sha256Hex(`${model}\n${text}`)];
      if (model !== suiteEmbeddings.model || !b64) { this.missing.push(text); throw new Error('no committed query-suite embedding for this text'); }
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      data.push(Array.from(new Float32Array(bytes.buffer)));
    }
    return { shape: [texts.length, suiteEmbeddings.dims], data, pooling: 'mean' };
  }
}

describe.skipIf(!corpus || bundleKind !== 'pinned')('the query suite over the pinned corpus and bundle', () => {
  const c = /** @type {FullCorpus} */ (corpus);
  const offered = c.modules.map((m) => m.code).sort();
  const moduleOf = new Map(c.modules.map((m) => [m.code, m]));
  /** @param {string} p */
  const members = (p) => offered.filter((code) => inRange(code, p));
  /** Results and their group variants. @param {any} body @returns {string[]} */
  const shownOf = (body) => body.results.flatMap((/** @type {any} */ r) => [r.code, ...(r.variants ?? []).map((/** @type {any} */ v) => v.code)]);
  /**
   * Whether a module meets a constraint param (the `constraint` rule), under the selected prereq semantics.
   * @param {string} code @param {Record<string, string>} param
   */
  const satisfies = (code, param) => {
    const m = /** @type {NormalisedModule} */ (moduleOf.get(code));
    return Object.entries(param).every(([k, v]) => {
      if (k === 'exam') return m.examSemesters.length === 0;
      if (k === 'su') return m.su || m.gradingBasis === 'Completed Satisfactory/Unsatisfactory';
      if (k === 'hoursBelow') return m.workloadHours !== null && m.workloadHours < Number(v);
      if (k === 'prereq') return m.prereqNone || (SELECTED_PREREQ === 'ii' && m.prereqCohortOnly);
      throw new Error(`unknown constraint param ${k}`);
    });
  };
  const fakes = createFakes();
  const ai = new SuiteAI();
  fakes.ai = /** @type {any} */ (ai);

  beforeAll(async () => {
    await seed({ modules: c.modules });
    const rows = /** @type {[string, string, string | null][]} */ (catalogueFile.rows);
    for (let i = 0; i < rows.length; i += 100) {
      const upsert = rows.slice(i, i + 100).map(([code, title, description]) => ({ code, title, description, acadYear: c.acadYear }));
      const res = await adminCall('/admin/catalogue', createFakes(), { upsert });
      if (res.status !== 200) throw new Error(`catalogue_only load: HTTP ${res.status} ${await res.text()}`);
    }
  }, 600_000);

  /** @param {string} text @param {number} topK @param {string} [extra] */
  const search = async (text, topK, extra = '') => {
    ai.missing.length = 0;
    const res = await callJson(`/search?q=${encodeURIComponent(text)}&topK=${topK}${extra}`, { fakes });
    expect(res.status, text).toBe(200);
    return { body: res.body, missing: [...ai.missing] };
  };

  for (const item of RUN) {
    const { partial } = ownership(item);
    it(`${item.id} [${item.row}] ${JSON.stringify(item.text)}${partial.length ? ` (pending: ${partial.join(', ')})` : ''}`, async () => {
      const { body, missing } = await search(item.text, item.topK);
      const p = item.params;
      const want = JSON.parse(JSON.stringify(item.interpreted).replace('"$selected"', JSON.stringify(SELECTED_PREREQ)));
      expect(body.interpreted, 'interpreted').toEqual(want);
      // The dense half ran on the committed embedding, except a not-offered
      // answer's `related`, whose catalogue text has none committed.
      if (!(item.rule === 'no-match' && p.reason === 'not-offered')) {
        expect(missing, 'texts with no committed embedding').toEqual([]);
        expect(body.degraded, 'degraded').toBeUndefined();
      }
      const got = codesOf(body);
      const top10 = got.slice(0, 10);
      switch (item.rule) {
        case 'code-at-rank-1':
          expect(got[0]).toBe(p.code);
          for (const code of p.allSatisfy ? shownOf(body) : []) expect(satisfies(code, p.allSatisfy), code).toBe(true);
          break;
        case 'constraint': {
          // Every returned result, its group variants included, satisfies the param;
          // the top 10 overlaps the reference searched with the explicit param.
          expect(body.count).toBeGreaterThan(0);
          for (const code of shownOf(body)) expect(satisfies(code, p.param), code).toBe(true);
          const qs = new URLSearchParams(p.param).toString();
          const ref = await search(p.reference, item.topK, `&${qs}`);
          expect(ref.missing, 'reference texts with no committed embedding').toEqual([]);
          const refTop = new Set(codesOf(ref.body).slice(0, 10));
          const overlap = top10.filter((code) => refTop.has(code)).length;
          console.info(`[query suite] ${item.id} constraint overlap@10 with ${JSON.stringify(p.reference)}&${qs}: ${overlap} (min ${p.minOverlap})`);
          expect(overlap).toBeGreaterThanOrEqual(p.minOverlap);
          break;
        }
        case 'codes-at-ranks':
          expect(got.slice(0, p.codes.length)).toEqual(p.codes);
          break;
        case 'prefix-level-mask':
          expect(body.count).toBeGreaterThan(0);
          for (const code of got) {
            expect(inRange(code, p.prefix), code).toBe(true);
            expect(moduleOf.get(code)?.level, code).toBe(p.level);
          }
          break;
        case 'partial-mask': {
          const m = members(p.prefix);
          for (const code of got) expect(inRange(code, p.prefix), code).toBe(true);
          const shown = new Set([...got, ...body.results.flatMap((/** @type {any} */ r) => (r.variants ?? []).map((/** @type {any} */ v) => v.code))]);
          for (const code of m) expect(shown.has(code), `member ${code}`).toBe(true);
          const G = new Set(m.map((code) => (groupOf.has(code) ? `g${groupOf.get(code)}` : code))).size;
          expect(G).toBe(p.G);
          // Without group collapse every member is its own result; with it, count = G.
          expect(body.count).toBe(IN_FORCE.has('groups') ? p.G : m.length);
          break;
        }
        case 'mixed-prefix':
          expect(top10.filter((code) => inRange(code, p.prefix)).length, top10.join(' ')).toBeGreaterThanOrEqual(p.M);
          break;
        case 'routes-nothing':
          expect(body.count).toBeGreaterThan(0);
          expect([body.interpreted.pin, body.interpreted.prefix]).toEqual([null, null]);
          expect(body.noMatch).toBeUndefined();
          expect(got).not.toContain(p.code);
          break;
        case 'ge-mask':
          expect(body.count).toBeGreaterThanOrEqual(p.minCount);
          for (const code of got) expect(p.prefixes, code).toContain(letters(code));
          break;
        case 'no-match':
          expect(body.count).toBe(0);
          expect(body.results).toEqual([]);
          expect(body.noMatch?.reason).toBe(p.reason);
          if (p.code) expect(body.noMatch.code).toBe(p.code);
          if (p.reason === 'not-offered') {
            expect(body.noMatch.title).toBe(p.title);
            expect(Array.isArray(body.noMatch.related)).toBe(true);
          }
          break;
        case 'guard': {
          expect(body.count).toBeGreaterThan(0);
          expect(body.interpreted.prefix).toBeNull();
          if (p.collisionTokens.length === 0) {
            const toks = new Set(p.letterTokens.map((/** @type {string} */ t) => t.toUpperCase()));
            expect(top10.filter((code) => toks.has(letters(code))).length, top10.join(' ')).toBeLessThanOrEqual(2);
          }
          for (const code of p.mustInclude ?? []) expect(top10, code).toContain(code);
          break;
        }
        case 'top10-level-window':
          for (const code of top10) {
            const level = /** @type {number} */ (moduleOf.get(code)?.level);
            expect(level >= p.min && (p.max === null || level <= p.max), code).toBe(true);
          }
          break;
        case 'beginner':
          for (const code of top10) expect(/** @type {number} */ (moduleOf.get(code)?.level), code).toBeLessThan(5);
          expect(got.slice(0, p.topN).some((code) => p.answers.includes(code)), got.slice(0, p.topN).join(' ')).toBe(true);
          break;
        case 'typo-overlap': {
          const clean = await search(p.clean, item.topK);
          const cleanTop = new Set(codesOf(clean.body).slice(0, 10));
          const overlap = top10.filter((code) => cleanTop.has(code)).length;
          console.info(`[query suite] ${item.id} typo overlap@10 with its clean form: ${overlap} (T = ${p.T})`);
          expect(overlap).toBeGreaterThanOrEqual(p.T);
          break;
        }
        default:
          throw new Error(`rule ${item.rule} needs a feature that is not in force`);
      }
    });
  }

  it('[codes] a bare prefix never takes in a longer one: cs returns no CSA code, ges no GESS code (hybrid and lexical)', async () => {
    expect(offered.some((code) => code.startsWith('CSA'))).toBe(true);
    expect(offered.some((code) => code.startsWith('GESS'))).toBe(true);
    for (const mode of ['hybrid', 'lexical']) {
      const cs = await search('cs', 50, `&mode=${mode}`);
      expect(cs.body.count, mode).toBe(50);
      expect(codesOf(cs.body).some((code) => code.startsWith('CSA')), mode).toBe(false);
      expect(codesOf(cs.body).every((code) => /^CS\d/.test(code)), mode).toBe(true);
      const ges = await search('ges', 50, `&mode=${mode}`);
      expect(codesOf(ges.body).some((code) => code.startsWith('GESS')), mode).toBe(false);
      // One result per duplicate group (a GES code can be cross-listed as a GESS variant).
      expect(new Set(codesOf(ges.body).map(gkey)), mode).toEqual(new Set(members('GES').map(gkey)));
    }
    // In mode=lexical the members are in code order, one per duplicate group.
    expect(codesOf((await search('cs', 50, '&mode=lexical')).body)).toEqual(projectGroups(members('CS')).slice(0, 50));
  });

  // The explicit constraint params (ADR 0006): each constraint item's reference, searched with its
  // param, returns only modules that satisfy it, its group variants included.
  it('[constraint params] each constraint item\'s reference with its explicit param: every shown module satisfies it', async () => {
    const items = suite.items.filter((item) => item.rule === 'constraint');
    expect(items.length).toBe(12);
    for (const item of items) {
      const qs = new URLSearchParams(item.params.param).toString();
      const { body, missing } = await search(item.params.reference, item.topK, `&${qs}`);
      expect(missing, item.id).toEqual([]);
      expect(body.count, item.id).toBeGreaterThan(0);
      expect(body.filters, item.id).toEqual(Object.fromEntries(Object.entries(item.params.param).map(([k, v]) => [k, k === 'prereq' ? v : Number(v)])));
      for (const code of shownOf(body)) expect(satisfies(code, item.params.param), `${item.id} ${code}`).toBe(true);
    }
  });

  // The no-signal check: ≥ 90% of the gibberish set's gate half answers count 0, under the τ in force.
  it.skipIf(!IN_FORCE.has('no-signal'))('[no-signal] the gibberish gate half: at least 90% answer count 0 with noMatch no-signal', async () => {
    const strings = new Map(gibberishFile.strings.map((g) => [g.id, g.text]));
    /** @param {string[]} ids */
    const outcome = async (ids) => {
      const out = [];
      for (const id of ids) {
        const { body, missing } = await search(/** @type {string} */ (strings.get(id)), 20);
        expect(missing, id).toEqual([]);
        expect(body.degraded, id).toBeUndefined();
        if (body.count === 0) expect(body.noMatch, id).toEqual({ reason: 'no-signal' });
        out.push({ id, count: body.count });
      }
      return out;
    };
    // The derivation half is measured offline (scripts/no-signal-cosines.mjs): some of its typo-
    // corrected forms (g-23 `gatt`) have no committed embedding.
    const gate = await outcome(gibberishFile.split.gate);
    const empty = (/** @type {{ count: number }[]} */ xs) => xs.filter((x) => x.count === 0).length;
    console.log(`[no-signal] gate half ${empty(gate)}/${gate.length} count 0 (not: ${gate.filter((x) => x.count).map((x) => x.id).join(' ')})`);
    expect(empty(gate) / gate.length).toBeGreaterThanOrEqual(0.9);
  });

  it('lists the items it does not run yet, each with the feature it waits for', () => {
    const lines = NOT_RUN.map((item) => {
      const { waiting } = ownership(item);
      const kind = NEVER_SKIPPED.has(item.row) ? 'pending' : 'skipped';
      return `${kind} ${item.id} [${item.row}] ${JSON.stringify(item.text)}: waits for ${waiting.join(', ')}`;
    });
    const partial = RUN.filter((it) => ownership(it).partial.length)
      .map((it) => `partial ${it.id} [${it.row}] ${JSON.stringify(it.text)}: ${ownership(it).partial.join(', ')}`);
    const embedding = WAITING_EMBEDDING.map((it) => `waiting on an embedding ${it.id} [${it.row}] ${JSON.stringify(it.text)}: ${EMBED_CORRECTED_COMMAND}`);
    console.log(`[query suite] ${RUN.length} run (${partial.length} with a clause pending), ${NOT_RUN.length} not run, `
      + `${WAITING_EMBEDDING.length} waiting on an embedding\n${[...lines, ...embedding, ...partial].join('\n')}`);
    expect(RUN.length + NOT_RUN.length + WAITING_EMBEDDING.length).toBe(90);
    // Only typo correction that embeds its corrected text can wait on an embedding.
    if (!EMBED_CORRECTED) expect(WAITING_EMBEDDING).toEqual([]);
    // No item that needs only code handling is left out, and a never-skipped item is only pending while its feature is off.
    for (const item of NOT_RUN) expect(ownership(item).waiting.length, item.id).toBeGreaterThan(0);
    for (const item of suite.items.filter((x) => x.row === 'nonexistent-code' || x.row === 'not-offered-code')) expect(RUN, item.id).toContain(item);
  });
});
