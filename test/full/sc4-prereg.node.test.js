// @ts-check
// P-6 corpus checks for the SC4 suite (docs/plans/phase3.md §4), against the
// pinned corpus and groups-v1. Skipped when .data/ has no corpus; with
// FULL_CORPUS=1 (the full-corpus CI job) a missing corpus fails instead.
// - G ≤ 50 for every partial-code and pillar item (A3-3, C3-3), G being the
//   distinct groups-v1 groups among the members (a singleton is its own group);
// - the codes each rule names are offered, catalogue-only or absent as the
//   rule needs;
// - gibberish texts carry no corpus signal a 3G trigger reads, and typo texts
//   correct to their clean forms under the P-6 thresholds;
// - the collision list and pillar prefixes are corpus prefixes;
// - the cohort-only rule's count on the pinned corpus.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { REPO } from '../../eval/lib/sets.mjs';
import { isCohortOnly } from '../../eval/prereg/cohort-only.mjs';
import { loadPinnedCorpus, MODULE_INFO_PATH } from '../../scripts/pinned-corpus.mjs';
import { queryTokens } from '../../src/fts-query.js';

const available = process.env.FULL_CORPUS === '1' || existsSync(MODULE_INFO_PATH);
/** @param {string} p */
const readJson = (p) => JSON.parse(readFileSync(join(REPO, p), 'utf8'));

/** @type {any[]} */
const items = readJson('test/sc4/queries.json').items;
const gibberish = readJson('eval/dev/gibberish.json').strings;
const collision = readJson('eval/prereg/collision-list.json');
const pillars = readJson('eval/prereg/ge-pillars.json').prefixes;
const groups = readJson('eval/groups.json').groups;

/** Members of a partial code: the PK range [P(+'0' if letters only), P + ':'). @param {string[]} codes @param {string} p */
const membersOf = (codes, p) => {
  const lo = /\d$/.test(p) ? p : `${p}0`;
  const hi = `${p}:`;
  return codes.filter((c) => c >= lo && c < hi);
};

/** Optimal string alignment distance. @param {string} a @param {string} b */
function osa(a, b) {
  /** @type {number[][]} */
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

describe.skipIf(!available)('SC4 suite against the pinned corpus (P-6)', () => {
  /** @type {Awaited<ReturnType<typeof loadPinnedCorpus>>} */
  let corpus;
  /** @type {Map<string, any>} */
  let offered;
  /** @type {Map<string, any>} */
  let catalogue;
  /** @type {string[]} */
  let codes;
  /** @type {Set<string>} */
  let prefixes;
  /** @type {Map<string, number>} */
  let df;
  /** @type {Map<string, number>} */
  const groupOf = new Map();
  groups.forEach((/** @type {string[]} */ g, /** @type {number} */ i) => g.forEach((m) => groupOf.set(m, i)));
  /** @param {string[]} members */
  const groupCount = (members) => new Set(members.map((m) => (groupOf.has(m) ? `g${groupOf.get(m)}` : m))).size;

  beforeAll(async () => {
    corpus = await loadPinnedCorpus();
    offered = new Map(corpus.modules.map((m) => [m.code, m]));
    catalogue = new Map(corpus.records.map((r) => [String(r.moduleCode), r]));
    codes = [...offered.keys()].sort();
    prefixes = new Set(codes.map((c) => /** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(c))[0]));
    df = new Map();
    for (const m of corpus.modules) for (const t of new Set(queryTokens(`${m.title} ${m.description}`))) df.set(t, (df.get(t) ?? 0) + 1);
  }, 120_000);

  it('G ≤ 50 for every partial-code and pillar item, and each item records its G', () => {
    const partial = items.filter((it) => it.row === 'partial-code');
    expect(partial).toHaveLength(6);
    /** @type {Record<string, number>} */
    const got = {};
    for (const it of partial) {
      const members = membersOf(codes, it.params.prefix);
      expect(members.length, it.id).toBeGreaterThan(0);
      const G = groupCount(members);
      got[it.text] = G;
      expect(G, it.id).toBe(it.params.G);
      expect(G, it.id).toBeLessThanOrEqual(50);
      expect(it.topK, it.id).toBe(50);
    }
    expect(got).toEqual({ CS32: 27, cs101: 1, 'cs 32': 27, GEA: 1, gess: 27, GEX: 14 });
  });

  it('a bare prefix range takes in no longer prefix (cs: no CSA; ges: no GESS)', () => {
    expect(membersOf(codes, 'CS').some((c) => c.startsWith('CSA'))).toBe(false);
    expect(membersOf(codes, 'GES').some((c) => c.startsWith('GESS'))).toBe(false);
    expect(membersOf(codes, 'GESS').length).toBeGreaterThan(0);
  });

  it('the GE-inside-a-longer-query items count groups among all pillar members', () => {
    const members = codes.filter((c) => pillars.includes(/** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(c))[0]));
    for (const it of items.filter((x) => x.row === 'ge-in-longer')) {
      expect(it.params.pillarGroups, it.id).toBe(groupCount(members));
      expect(it.params.minCount, it.id).toBe(Math.min(10, groupCount(members)));
    }
  });

  it('names offered codes where a rule pins or requires them, and catalogue-only or absent codes where it must not', () => {
    for (const it of items) {
      const p = it.params;
      for (const c of [...(it.interpreted.pin ?? []), ...(p.code && it.rule === 'code-at-rank-1' ? [p.code] : []), ...(p.codes ?? []), ...(p.answers ?? []), ...(p.mustInclude ?? [])]) {
        expect(offered.has(c), `${it.id} ${c} offered`).toBe(true);
      }
      if (p.reason === 'not-offered') {
        expect(offered.has(p.code), it.id).toBe(false);
        expect(catalogue.get(p.code)?.title, it.id).toBe(p.title);
        expect(prefixes.has(/** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(p.code))[0]), it.id).toBe(true);
      }
      if (p.reason === 'unknown-code') {
        expect(catalogue.has(p.code), it.id).toBe(false);
        expect(prefixes.has(/** @type {RegExpExecArray} */ (/^[A-Z]+/.exec(p.code))[0]), it.id).toBe(true);
        expect(p.code, it.id).not.toMatch(/^[A-Z]+\d000$/);
      }
      if (it.rule === 'routes-nothing') expect(offered.has(p.code), it.id).toBe(false);
    }
  });

  it('the beginner items name level-1/2 answers; the mixed items have at least M prefix members; cs 3000 has level-3 CS members', () => {
    for (const it of items.filter((x) => x.rule === 'beginner')) {
      for (const c of it.params.answers) expect(offered.get(c).level, `${it.id} ${c}`).toBeLessThanOrEqual(2);
    }
    for (const it of items.filter((x) => x.rule === 'mixed-prefix')) {
      expect(membersOf(codes, it.params.prefix).length, it.id).toBeGreaterThanOrEqual(it.params.M);
    }
    const cs3 = codes.filter((c) => c.startsWith('CS') && /^CS\d/.test(c) && offered.get(c).level === 3);
    expect(cs3.length).toBeGreaterThan(0);
    expect(offered.has('CS3000')).toBe(false);
  });

  it('the no-background beginner answers have no prerequisite, so they hold under either prereq semantics', () => {
    const it = items.find((x) => x.text === 'economics with no background');
    for (const c of it.params.answers) expect(offered.get(c).prerequisite, c).toBeNull();
  });

  it('gibberish texts (the set and the suite\'s) give no 3G-readable signal: every token df 0, no ≥ 4-letter prefix match, no prefix or code shape', () => {
    const texts = [...gibberish.map((/** @type {any} */ g) => g.text), ...items.filter((x) => x.row === 'gibberish').map((x) => x.text)];
    const vocab = [...df.keys()];
    /** @type {string[]} */
    const problems = [];
    for (const t of texts) {
      for (const tok of queryTokens(t)) {
        if ((df.get(tok) ?? 0) > 0) problems.push(`${t}: ${tok} has df > 0`);
        if (/^[a-z]{4,}$/.test(tok) && vocab.some((v) => v.startsWith(tok))) problems.push(`${t}: ${tok} is a prefix of a corpus token`);
        if (prefixes.has(tok.toUpperCase())) problems.push(`${t}: ${tok} is a module prefix`);
        const letters = /^([a-z]+)\d/.exec(tok)?.[1];
        if (letters && prefixes.has(letters.toUpperCase())) problems.push(`${t}: ${tok} is code-shaped`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('every typo item\'s misspelt tokens have df 0 and no prefix match, and correct to its clean form under the P-6 OSA thresholds', () => {
    const vocab = [...df.keys()];
    for (const it of items.filter((x) => x.row === 'typo')) {
      const typo = queryTokens(it.text);
      const clean = queryTokens(it.params.clean);
      expect(typo.length, it.id).toBe(clean.length);
      typo.forEach((tok, i) => {
        if (tok === clean[i]) return;
        expect(df.get(tok) ?? 0, `${it.id} ${tok}`).toBe(0);
        expect(tok.length, `${it.id} ${tok}`).toBeGreaterThanOrEqual(5);
        expect(vocab.some((v) => v.startsWith(tok)), `${it.id} ${tok} prefix`).toBe(false);
        const max = tok.length >= 8 ? 2 : 1;
        const best = vocab
          .map((v) => ({ v, d: osa(tok, v), df: /** @type {number} */ (df.get(v)) }))
          .filter((x) => x.d <= max)
          .sort((a, b) => a.d - b.d || b.df - a.df || (a.v < b.v ? -1 : 1))[0];
        expect(best?.v, `${it.id} ${tok}`).toBe(clean[i]);
      });
    }
  });

  it('the guard count rule binds: two guards carry an off-list prefix token with ≥ M members, a prefix the suite also joins or routes', () => {
    // A count-rule token that is not an offered prefix can never fail the rule.
    // These two can: a ranker that prefix-routed the letter-only token (as a
    // third list, like a code token) would put its members in the top 10.
    /** @type {Record<string, string[]>} */
    const binding = {};
    for (const it of items.filter((x) => x.rule === 'guard' && x.params.collisionTokens.length === 0)) {
      const toks = it.params.letterTokens.filter((/** @type {string} */ t) => prefixes.has(t.toUpperCase()));
      if (toks.length) binding[it.id] = toks;
    }
    expect(binding).toEqual({ 'sc4-085': ['cs'], 'sc4-087': ['lsm'] });
    const M = readJson('test/sc4/queries.json').thresholds.M;
    for (const t of Object.values(binding).flat()) {
      const P = t.toUpperCase();
      expect(collision.list, t).not.toContain(P);
      expect(membersOf(codes, P).length, t).toBeGreaterThanOrEqual(M);
      // Off the list by the suite's own items: the joins and routes on P need it there.
      expect(items.some((x) => (x.interpreted.pin ?? []).some((/** @type {string} */ c) => c.startsWith(P) && /^\d/.test(c.slice(P.length))) || x.interpreted.prefix === P), t).toBe(true);
    }
  });

  it('every collision-list entry and pillar prefix is an offered-module prefix; the plan\'s non-prefixes are not', () => {
    for (const p of [...collision.list, ...pillars]) expect(prefixes.has(p), p).toBe(true);
    for (const p of collision.notPrefixes) expect(prefixes.has(p), p).toBe(false);
  });

  it('the collision review covers every offered prefix that is on neither the list nor the pillar list, once (C13)', () => {
    const r = readJson('eval/prereg/collision-review.json');
    const reviewed = [...Object.keys(r.added), ...Object.keys(r.keptOff), ...Object.keys(r.dictionaryHitKeptOff)].sort();
    const before = collision.list.filter((/** @type {string} */ p) => !(p in r.added));
    expect(reviewed).toEqual([...prefixes].filter((p) => !before.includes(p) && !pillars.includes(p)).sort());
    expect(prefixes.size).toBe(304);
  });

  it('the cohort-only rule: d-011\'s modules as the plan reads them, and 65 offered modules in all', () => {
    for (const c of ['ACC1701XA', 'ACC1701XC']) expect(isCohortOnly(offered.get(c).prerequisite), c).toBe(true);
    for (const c of ['ACC2706', 'FIN2704X', 'QF1100']) expect(isCohortOnly(offered.get(c).prerequisite), c).toBe(false);
    expect(corpus.modules.filter((m) => isCohortOnly(m.prerequisite)).length).toBe(65);
  });
});
