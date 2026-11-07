// @ts-check
// src/query-intent.js, the 3B half of the parse (docs/plans/phase3-prereg.md
// §3, steps 1 and 5–7): canonical q, code joins, code resolution, partial codes,
// letter-only tokens, the collision list and the GE intent. Pure, so it runs in
// Node over the 3B-0 data files and a hand-written offered set.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../eval/lib/sets.mjs';
import { STOPWORDS_CURRENT } from '../src/fts-query.js';
import {
  INTERPRETED_KEYS, IGNORABLE_INTENTS, buildIntentContext, canonicalQuery, codeRange, parseIgnore, parseQuery,
} from '../src/query-intent.js';
import { deriveIntents } from './sc4/intents.node.mjs';

/** @param {string} rel */
const readJson = (rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const suite = readJson('test/sc4/queries.json');

/** Offered codes the cases and the suite name (the pinned corpus has them all), plus the fixture's. */
const OFFERED = new Set([
  'CS1010', 'CS1010S', 'CS1231', 'CS1231S', 'CS2030', 'CS2040', 'CS3244', 'MA1521', 'EE2211', 'LSM1301',
  'GEA1000', 'GEA1000N', 'ES1000', 'ME3000', 'IS6000', 'IS4246', 'GE2101',
  ...readJson('test/fixtures/corpus.json').modules.map((/** @type {{ code: string }} */ m) => m.code),
]);

const ctx = buildIntentContext({
  prefixes: Object.keys(readJson('data/prefixes.json').prefixes),
  catalogueCodes: readJson('data/catalogue-codes.json').codes,
  collision: readJson('data/collision-list.json').list,
  ge: readJson('data/ge-pillars.json'),
  stopwords: STOPWORDS_CURRENT,
  isOffered: (code) => OFFERED.has(code),
});
const ALL_PILLARS = ['GEA', 'GEC', 'GEH', 'GEI', 'GEN', 'GEQ', 'GES', 'GESS', 'GET', 'GEX'];
/** @param {string} q @param {string[]} [ignore] */
const parse = (q, ignore = []) => parseQuery(canonicalQuery(q.trim()), ctx, ignore);

describe('the interpreted object', () => {
  it('always has the eight keys, in order, null when unset', () => {
    const p = parse('machine learning');
    expect(Object.keys(p.interpreted)).toEqual([...INTERPRETED_KEYS]);
    expect(INTERPRETED_KEYS).toEqual(suite.interpretedKeys);
    expect(Object.values(p.interpreted).every((v) => v === null)).toBe(true);
    expect(p.kind).toBe('search');
  });
});

describe('canonical q (step 1)', () => {
  it('trims, collapses whitespace and lower-cases ASCII letters only', () => {
    expect(canonicalQuery('CS  1010S\tIntro')).toBe('cs 1010s intro');
    expect(canonicalQuery('Kelvin')).toBe('Kelvin');
  });
});

describe('code joins (step 5)', () => {
  it('joins a known prefix with 4 digits, with or without a suffix, and with 1–3 digits', () => {
    expect(parse('cs 1010s').interpreted.pin).toEqual(['CS1010S']);
    expect(parse('cs 32').interpreted.prefix).toBe('CS32');
    expect(parse('cs 101').interpreted.prefix).toBe('CS101');
    expect(parse('cs 32 machine learning').interpreted.prefix).toBe('CS32');
  });

  it('joins collision or stopword letters only as the whole query and only into a real code', () => {
    expect(parse('ee 2211').interpreted.pin).toEqual(['EE2211']);
    expect(parse('ma 1521').interpreted.pin).toEqual(['MA1521']);
    expect(parse('is 4246').interpreted.pin).toEqual(['IS4246']);
    expect(parse('me 3000').interpreted.pin).toEqual(['ME3000']);
    // Inside a longer query, never: no pin, no level route.
    for (const q of ['ee 2211 workload', 'is 4246 workload', 'give me 3000 level electives', 'show me 4000 level courses',
      'what is 2000 level', 'is it 3000 level', 'give me 2 easy electives', 'how many units is 3 US credits']) {
      const p = parse(q);
      expect(p.interpreted.pin, q).toBeNull();
      expect(p.interpreted.prefix, q).toBeNull();
      expect(p.interpreted.level, q).toBeNull();
      expect(p.kind, q).toBe('search');
    }
    // A collision join that names no code is no join: `st 2000` stays topical.
    expect(parse('st 2000').kind).toBe('search');
    expect(parse('st 2000').interpreted.prefix).toBeNull();
  });

  it('joins a suffix only into a real code, and never across / or -', () => {
    expect(parse('cs1010 s').interpreted.pin).toEqual(['CS1010S']);
    expect(parse('cs2040 or cs2030').interpreted.pin).toEqual(['CS2040', 'CS2030']);
    expect(parse('cs1231 s/u').interpreted.pin).toEqual(['CS1231']);
    expect(parse('cs1231 s-u').interpreted.pin).toEqual(['CS1231']);
  });

  it('only a known prefix makes a token code-shaped', () => {
    for (const q of ['comp 1010', 'math 1001', 'econ 1101', 'lvl 3000 urban planning']) {
      const p = parse(q);
      expect([p.kind, p.interpreted.pin, p.interpreted.prefix], q).toEqual(['search', null, null]);
    }
  });

  it('leaves the lexical text as typed: joins and unrouted codes keep their original tokens', () => {
    expect(parse('CS 4400 Operating Systems').lexical).toBe('cs 4400 operating systems');
    expect(parse('cs 1010s').lexical).toBe('cs 1010s');
  });
});

describe('code resolution (step 6)', () => {
  it('1. an offered code pins, in query order, at most 3, de-duplicated', () => {
    expect(parse('GEA1000').interpreted).toMatchObject({ pin: ['GEA1000'], level: null, prefix: null });
    expect(parse('ES1000').interpreted).toMatchObject({ pin: ['ES1000'], level: null });
    expect(parse('cs2040 cs1010s cs2030 cs1231 cs2040').interpreted.pin).toEqual(['CS2040', 'CS1010S', 'CS2030']);
    expect(parse('cs2040 workload').interpreted.pin).toEqual(['CS2040']);
  });

  it('2. a catalogue-only code as the whole query is noMatch not-offered; inside a longer query it routes nothing', () => {
    expect(parse('GEQ1000')).toMatchObject({ kind: 'no-match', noMatch: { reason: 'not-offered', code: 'GEQ1000' } });
    const longer = parse('something like ACC1701X for engineers');
    expect([longer.kind, longer.noMatch, longer.interpreted.pin, longer.interpreted.prefix]).toEqual(['search', null, null, null]);
  });

  it('3. XX N000 (XX a known prefix off the lists) sets level N and the XX route', () => {
    const whole = parse('cs 3000');
    expect(whole.kind).toBe('mask');
    expect(whole.interpreted).toMatchObject({ prefix: 'CS', level: { min: 3, max: 3, source: ['level'] } });
    expect(whole.ranges).toEqual([['CS0', 'CS:']]);
    expect(whole.level).toEqual({ min: 3, max: 3 });
    const longer = parse('cs3000 machine learning');
    expect(longer.kind).toBe('search');
    expect(longer.codeList).toEqual([['CS0', 'CS:']]);
    expect(longer.level).toEqual({ min: 3, max: 3 });
    // Collision letters never reach step 3.
    expect(parse('st2000').kind).toBe('no-match');
    expect(parse('st2000').interpreted.level).toBeNull();
  });

  it('4. otherwise, as the whole query, noMatch unknown-code; inside a longer query nothing', () => {
    expect(parse('CS9999')).toMatchObject({ kind: 'no-match', noMatch: { reason: 'unknown-code', code: 'CS9999' } });
    expect(parse('lsm 9876')).toMatchObject({ kind: 'no-match', noMatch: { reason: 'unknown-code', code: 'LSM9876' } });
    const d016 = parse('CS 4400 Operating Systems');
    expect([d016.kind, d016.noMatch, d016.interpreted.pin, d016.interpreted.prefix, d016.codeList]).toEqual(['search', null, null, null, null]);
  });
});

describe('partial codes and letter-only tokens', () => {
  it('a whole-query partial code is a hard mask over [P(+0), P:)', () => {
    expect(parse('CS32')).toMatchObject({ kind: 'mask', ranges: [['CS32', 'CS32:']], interpreted: { prefix: 'CS32' } });
    expect(parse('cs101').ranges).toEqual([['CS101', 'CS101:']]);
    expect(parse('GEA')).toMatchObject({ kind: 'mask', ranges: [['GEA0', 'GEA:']], interpreted: { prefix: 'GEA', ge: null } });
    expect(parse('gess').interpreted.prefix).toBe('GESS');
    expect(parse('ges').ranges).toEqual([['GES0', 'GES:']]);
  });

  it('the range rule: a bare prefix never takes in a longer one', () => {
    expect(codeRange('CS')).toEqual(['CS0', 'CS:']);
    expect(codeRange('CS32')).toEqual(['CS32', 'CS32:']);
    const [lo, hi] = codeRange('CS');
    expect('CSA6101' >= lo && 'CSA6101' < hi).toBe(false);
    expect('CS9999Z' >= lo && 'CS9999Z' < hi).toBe(true);
    const [glo, ghi] = codeRange('GES');
    expect('GESS1000' >= glo && 'GESS1000' < ghi).toBe(false);
    expect('GES1009' >= glo && 'GES1009' < ghi).toBe(true);
  });

  it('a code token inside a longer query is the third list', () => {
    expect(parse('cs32 machine learning')).toMatchObject({ kind: 'search', codeList: [['CS32', 'CS32:']], interpreted: { prefix: 'CS32' } });
    expect(parse('pl32 psychology lab').interpreted.prefix).toBe('PL32');
  });

  it('a letter-only token routes only as the whole query, and never when it is on the collision list', () => {
    for (const q of ['AI', 'ai ethics', 'js', 'pr', 'dsa', 'it', 'it security', 'se asia history', 'psychology electives for cs majors',
      'philosophy for lsm students']) {
      const p = parse(q);
      expect([p.kind, p.interpreted.prefix, p.codeList], q).toEqual(['search', null, null]);
    }
    expect(parse('cs').interpreted.prefix).toBe('CS');
  });
});

describe('the GE intent (step 7)', () => {
  it('a generic phrase maps to every pillar prefix, never GE\\d; a whole query is the pillar mask', () => {
    for (const q of ['ge', 'gen ed', 'general education', 'GE']) {
      const p = parse(q);
      expect(p.kind, q).toBe('mask');
      expect(p.interpreted.ge, q).toEqual(ALL_PILLARS);
      expect(p.interpreted.prefix, q).toBeNull();
      expect(p.ranges, q).toEqual(ALL_PILLARS.map(codeRange));
    }
  });

  it('a pillar name maps to its own prefixes; several take the union', () => {
    expect(parse('singapore studies').interpreted.ge).toEqual(['GES', 'GESS']);
    expect(parse('data literacy and critique and expression modules').interpreted.ge).toEqual(['GEA', 'GEX']);
  });

  it('inside a longer query it is a pre-retrieval mask, stripped from the lexical text only', () => {
    const p = parse('GE module about technology and society');
    expect(p.kind).toBe('search');
    expect(p.interpreted.ge).toEqual(ALL_PILLARS);
    expect(p.ranges).toEqual(ALL_PILLARS.map(codeRange));
    expect(p.lexical).toBe('module about technology and society');
    expect(p.dense).toBe('ge module about technology and society');
  });

  it('ignore=ge undoes it: no mask, nothing stripped, interpreted.ge null', () => {
    const p = parse('GE module about technology and society', ['ge']);
    expect([p.interpreted.ge, p.ranges, p.lexical]).toEqual([null, null, 'ge module about technology and society']);
    expect(parse('ge', ['ge']).kind).toBe('search');
  });

  it('a GE join is a code, not the intent: ge 2101 pins Geography', () => {
    expect(parse('ge 2101').interpreted).toMatchObject({ pin: ['GE2101'], ge: null });
  });

  it('ignore=level drops the XX N000 level but keeps its route', () => {
    const p = parse('cs 3000', ['level']);
    expect([p.kind, p.interpreted.prefix, p.interpreted.level, p.level]).toEqual(['mask', 'CS', null, null]);
  });
});

describe('ignore', () => {
  it('parses to a sorted, de-duplicated list of intent names', () => {
    expect(parseIgnore('su,level')).toEqual({ ignore: ['level', 'su'] });
    expect(parseIgnore('level, su ,level')).toEqual({ ignore: ['level', 'su'] });
    expect(parseIgnore('')).toEqual({ ignore: [] });
    expect(parseIgnore(null)).toEqual({ ignore: [] });
    expect(parseIgnore('ge,banana').error).toMatch(/banana/);
    expect(IGNORABLE_INTENTS).toEqual(['ge', 'level', 'exam', 'su', 'hoursBelow', 'prereq']);
  });
});

describe('the SC4 suite, the keys 3B sets', () => {
  // pin, prefix and ge are 3B's; level only through XX N000. The other keys
  // wait for 3D and 3H (test/full/sc4.test.js runs each item's full rule).
  const B3 = /** @type {const} */ (['pin', 'prefix', 'ge']);
  for (const item of suite.items) {
    it(`${item.id} ${JSON.stringify(item.text)}`, () => {
      const p = parse(item.text);
      for (const k of B3) expect(p.interpreted[k], k).toEqual(item.interpreted[k]);
      const phraseLevel = deriveIntents(item.params?.clean ?? item.text).level;
      if (!phraseLevel) expect(p.interpreted.level).toEqual(item.interpreted.level);
      for (const k of ['exam', 'su', 'hoursBelow', 'prereq']) expect(p.interpreted[/** @type {'exam'} */ (k)], k).toBeNull();
      if (item.rule === 'no-match' && item.params.reason !== 'no-signal') {
        expect(p.noMatch).toEqual({ reason: item.params.reason, code: item.params.code });
      } else {
        expect(p.noMatch).toBeNull();
      }
    });
  }
});

describe('review fixes (PR #44)', () => {
  it('a punctuation-only word does not count toward the whole query or the collision guard', () => {
    expect(parse('GEQ1000 ?')).toMatchObject({ kind: 'no-match', noMatch: { reason: 'not-offered', code: 'GEQ1000' } });
    expect(parse('cs9999 ?')).toMatchObject({ kind: 'no-match', noMatch: { reason: 'unknown-code', code: 'CS9999' } });
    expect(parse('gex ?')).toMatchObject({ kind: 'mask', ranges: [['GEX0', 'GEX:']], interpreted: { prefix: 'GEX' } });
    expect(parse('cs 3000 ?')).toMatchObject({ kind: 'mask', ranges: [['CS0', 'CS:']], level: { min: 3, max: 3 } });
    expect(parse('is 4246 ?').interpreted.pin).toEqual(['IS4246']);
    expect(parse('? ee 2211 !').interpreted.pin).toEqual(['EE2211']);
  });

  it('the suffix join takes trailing punctuation; only / or - after the letters blocks it', () => {
    expect(parse('cs1010 s?').interpreted.pin).toEqual(['CS1010S']);
    expect(parse('cs 1010 s.').interpreted.pin).toEqual(['CS1010S']);
    expect(parse('cs1010 s, please').interpreted.pin).toEqual(['CS1010S']);
    expect(parse('cs1231 s/u').interpreted.pin).toEqual(['CS1231']);
    expect(parse('cs1231 s-u').interpreted.pin).toEqual(['CS1231']);
  });

  it('lead decision: `ge` directly followed by a token starting with a digit is plain text, not the GE intent', () => {
    for (const q of ['ge 2101 workload', 'geography ge 2101 syllabus', 'ge 2 easy modules']) {
      const p = parse(q);
      expect([p.kind, p.interpreted.ge, p.interpreted.pin, p.ranges], q).toEqual(['search', null, null, null]);
      expect(p.lexical, q).toBe(q);
    }
    expect(parse('ge').interpreted.ge).toEqual(ALL_PILLARS);
    expect(parse('ge modules about technology')).toMatchObject({ kind: 'search', interpreted: { ge: ALL_PILLARS }, lexical: 'modules about technology' });
    expect(parse('ge 2101').interpreted).toMatchObject({ pin: ['GE2101'], ge: null });
  });
});
