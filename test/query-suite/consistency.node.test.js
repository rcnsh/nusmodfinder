// @ts-check
// The query suite's `interpreted` objects and rule params checked against
// what they mean, not only their shape. Every item's intents (ge, level, exam,
// su, hoursBelow, prereq) must be what the committed phrase rules
// (eval/query-rules/intent-phrases.json, ge-pillars.json) give for its text, or for
// its clean form when it is a typo item, in both directions: a phrase in the
// text sets its intent, and a set intent is backed by a phrase, an `XX N000`
// code token or the clean form. Each rule's params must agree with the same
// item's `interpreted`, and each guard's token lists with its text.
import { describe, expect, it } from 'vitest';
import { queryTokens } from '../../src/fts-query.js';
import { COLLISION, INTENT_KEYS, PHRASES, STOPWORDS, canonical, codeLevel, deriveIntents, phraseMatches, phraseRegex } from './intents.node.mjs';
import { SUITE_PATH, readJson } from './suite-files.node.mjs';

/** @type {any[]} */
const items = readJson(SUITE_PATH).items;
const CONSTRAINT_ROWS = ['no-exam', 'su', 'workload', 'no-prereq'];

/** The text an item's intents are read from: the clean form for a typo item (typo corrections are not echoed). @param {any} it */
const intentText = (it) => (it.row === 'typo' ? it.params.clean : it.text);

/** @param {any} it */
const derived = (it) => deriveIntents(intentText(it), it.interpreted.prefix);

/** @param {any} it @param {string} key */
const label = (it, key) => `${it.id} ${JSON.stringify(it.text)} ${key}`;

describe('the phrase matcher reads the rules as the doc states them', () => {
  it('anchors on token boundaries, lets a space match whitespace or "-", and reads N', () => {
    expect('3000-level'.match(phraseRegex('N000 level', 'level'))).toEqual(['3000-level']);
    expect('first-year chem'.match(phraseRegex('first year', null))).toEqual(['first-year']);
    expect('first   year'.match(phraseRegex('first year', null))).toEqual(['first   year']);
    expect('intros'.match(phraseRegex('intro', null))).toBeNull();
    expect('undergraduate'.match(phraseRegex('graduate', null))).toBeNull();
    expect('cs3000 level'.match(phraseRegex('N000 level', 'level'))).toBeNull();
    expect('under 100 hours'.match(phraseRegex('under N hours', 'hours'))).toBeNull();
    expect(deriveIntents('under 12 hours').hoursBelow).toBe(12);
  });

  it('takes the longest phrase at a position, and negates level phrases only', () => {
    expect(phraseMatches('no final exams').a.map((m) => m.phrase)).toEqual(['no final exams']);
    expect(phraseMatches('for beginners').b.map((m) => m.phrase)).toEqual(['for beginners']);
    expect(deriveIntents('not first year').level).toBeNull();
    expect(deriveIntents('except a graduate one').level).toBeNull();
    expect(deriveIntents('not no exam').exam).toBe(0);
    expect(deriveIntents('first year, not graduate').level).toEqual({ min: 1, max: 4, source: ['beginner'] });
  });
});

describe('the query suite: interpreted means what the text says', () => {
  it('sets every intent a non-negated phrase in the text (or the typo item\'s clean form) names, to that phrase\'s value', () => {
    for (const it of items) {
      const want = derived(it);
      for (const key of INTENT_KEYS) if (want[key] !== null) expect(it.interpreted[key], label(it, key)).toEqual(want[key]);
    }
  });

  it('leaves null every intent no phrase, code token or clean form backs', () => {
    for (const it of items) {
      const want = derived(it);
      for (const key of INTENT_KEYS) if (it.interpreted[key] !== null) expect(want[key], `${label(it, key)} is set with nothing in the text to back it`).toEqual(it.interpreted[key]);
    }
  });

  it('a negated level phrase leaves the level null (and the suite has such items)', () => {
    const negated = items.filter((it) => phraseMatches(intentText(it)).b.some((m) => m.negated));
    expect(negated.map((it) => it.text).sort()).toEqual(['beyond first year calculus', 'non graduate data science', 'not first year basics']);
    for (const it of negated) {
      const live = phraseMatches(intentText(it)).b.filter((m) => m.key === 'level' && !m.negated);
      if (live.length === 0 && !codeLevel(it.text, it.interpreted.prefix)) expect(it.interpreted.level, label(it, 'level')).toBeNull();
    }
  });

  it('a year phrase gives the window from its N to 4, never an exact level', () => {
    const year = items.filter((it) => phraseMatches(intentText(it)).b.some((m) => m.kind === 'year' && !m.negated));
    expect(year.length).toBeGreaterThanOrEqual(3);
    for (const it of year) {
      const m = /** @type {import('./intents.node.mjs').Match} */ (phraseMatches(intentText(it)).b.find((x) => x.kind === 'year'));
      expect(it.interpreted.level.source, label(it, 'level')).toContain('year');
      expect(it.interpreted.level.min, label(it, 'level')).toBeLessThanOrEqual(PHRASES.level.year.N[m.phrase]);
      expect(it.interpreted.level.max, label(it, 'level')).toBe(4);
    }
    for (const it of items.filter((x) => x.row === 'level-year')) {
      expect(it.interpreted.level.max, it.id).toBe(4);
      expect(it.interpreted.level.min, it.id).toBeLessThan(4);
    }
  });

  it('`no background` sets both the beginner and the no-prerequisite intents', () => {
    const shared = items.filter((it) => /(?<![a-z0-9])no[\s-]+background(?![a-z0-9])/.test(canonical(intentText(it))));
    expect(shared.length).toBeGreaterThan(0);
    for (const it of shared) {
      expect(it.interpreted.level?.source, label(it, 'level')).toContain('beginner');
      expect(it.interpreted.prereq, label(it, 'prereq')).toEqual(PHRASES.constraints.prereq.interpreted);
    }
  });

  it('each typo item records its clean form, and its interpreted is what the rules give for that clean form', () => {
    for (const it of items.filter((x) => x.row === 'typo')) {
      expect(typeof it.params.clean, it.id).toBe('string');
      expect(canonical(it.params.clean), it.id).not.toBe(canonical(it.text));
      expect(queryTokens(it.params.clean).length, it.id).toBe(queryTokens(it.text).length);
      const want = deriveIntents(it.params.clean, it.interpreted.prefix);
      for (const key of INTENT_KEYS) expect(it.interpreted[key], label(it, key)).toEqual(want[key]);
    }
    // The rule is live: at least one clean form carries an intent its typo text hides.
    expect(items.some((it) => it.row === 'typo' && deriveIntents(it.text).level === null && deriveIntents(it.params.clean).level !== null)).toBe(true);
  });
});

describe('the query suite: rule params agree with interpreted', () => {
  /** A constraint param (`{ exam: "0" }` …) as the interpreted value it implies. @param {string} key @param {string} value */
  const paramValue = (key, value) => {
    if (key === 'hoursBelow') return Number(value);
    const c = PHRASES.constraints[key];
    expect(c?.param, key).toBe(`${key}=${value}`);
    return c.interpreted;
  };

  it('every param a rule uses matches the item\'s interpreted: level, hoursBelow, exam, su, prereq, ge and prefix', () => {
    for (const it of items) {
      const p = it.params;
      const I = it.interpreted;
      switch (it.rule) {
        case 'code-at-rank-1':
          expect(I.pin?.[0], label(it, 'pin')).toBe(p.code);
          for (const [k, v] of Object.entries(p.allSatisfy ?? {})) expect(I[k], label(it, k)).toEqual(paramValue(k, /** @type {string} */ (v)));
          break;
        case 'codes-at-ranks':
          expect(I.pin, label(it, 'pin')).toEqual(p.codes);
          break;
        case 'prefix-level-mask':
          expect(I.prefix, label(it, 'prefix')).toBe(p.prefix);
          expect(I.level, label(it, 'level')).toEqual({ min: p.level, max: p.level, source: ['level'] });
          break;
        case 'partial-mask':
        case 'mixed-prefix':
          expect(I.prefix, label(it, 'prefix')).toBe(p.prefix);
          break;
        case 'routes-nothing':
          expect(I.pin, label(it, 'pin')).toBeNull();
          expect(I.prefix, label(it, 'prefix')).toBeNull();
          expect(canonical(it.text).replace(/ /g, ''), label(it, 'code')).toContain(p.code.toLowerCase());
          break;
        case 'ge-mask':
          expect(I.ge, label(it, 'ge')).toEqual(p.prefixes);
          break;
        case 'beginner':
          expect(I.level?.source, label(it, 'level')).toContain('beginner');
          expect(I.level?.max, label(it, 'level')).toBeLessThanOrEqual(4);
          break;
        case 'top10-level-window':
          expect(I.level && { min: I.level.min, max: I.level.max }, label(it, 'level')).toEqual({ min: p.min, max: p.max });
          break;
        case 'constraint': {
          const [[k, v]] = Object.entries(p.param);
          expect(I[k], label(it, k)).toEqual(paramValue(k, /** @type {string} */ (v)));
          for (const other of ['exam', 'su', 'hoursBelow', 'prereq']) if (other !== k) expect(I[other], label(it, other)).toBeNull();
          // The reference is the text with the matched phrase removed (C11): no constraint phrase left in it.
          expect(phraseMatches(p.reference).a, label(it, 'reference')).toEqual([]);
          expect(deriveIntents(p.reference)[k], label(it, 'reference')).toBeNull();
          break;
        }
        case 'no-match':
          for (const [k, v] of Object.entries(I)) expect(v, label(it, k)).toBeNull();
          if (p.code) expect(canonical(it.text).replace(/ /g, ''), label(it, 'code')).toBe(p.code.toLowerCase());
          break;
        case 'typo-overlap':
          break;
        case 'guard':
          expect(I.prefix, label(it, 'prefix')).toBeNull();
          expect(I.pin, label(it, 'pin')).toBeNull();
          break;
        default:
          throw new Error(`${it.id}: unknown rule ${it.rule}`);
      }
      if (it.row === 'level-beginner') expect(it.rule, it.id).toBe('beginner');
      if (CONSTRAINT_ROWS.includes(it.row)) expect(it.rule, it.id).toBe('constraint');
    }
  });

  it('every pinned code and prefix route is a code token in the text', () => {
    for (const it of items) {
      const flat = canonical(it.text).replace(/ /g, '');
      for (const c of it.interpreted.pin ?? []) expect(flat, label(it, 'pin')).toContain(c.toLowerCase());
      if (it.interpreted.prefix) expect(flat, label(it, 'prefix')).toContain(it.interpreted.prefix.toLowerCase());
    }
  });

  it('each guard\'s collisionTokens are its collision-list tokens, and its letterTokens its letter-only non-stopword tokens when it has none (C12)', () => {
    for (const it of items.filter((x) => x.rule === 'guard')) {
      const tokens = queryTokens(canonical(it.text));
      const collision = [...new Set(tokens.filter((t) => COLLISION.has(t)))];
      expect(it.params.collisionTokens, label(it, 'collisionTokens')).toEqual(collision);
      const letters = collision.length ? [] : [...new Set(tokens.filter((t) => /^[a-z]+$/.test(t) && !STOPWORDS.has(t)))];
      expect(it.params.letterTokens, label(it, 'letterTokens')).toEqual(letters);
    }
  });
});
