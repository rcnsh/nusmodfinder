// @ts-check
// The gibberish set: ≥ 40 strings that should match nothing, and its seeded
// split into a derivation half (which tunes the no-signal threshold) and a gate
// half (which checks it) of ≥ 20 each. The split must reproduce from the
// recorded seed (eval/gibberish-split.mjs).
import { describe, expect, it } from 'vitest';
import { splitGibberish, splitOf } from '../../eval/gibberish-split.mjs';
import { GIBBERISH_PATH, SUITE_PATH, devQueries, nearDuplicate, normalise, readJson, suiteTexts } from './suite-files.node.mjs';

const file = readJson(GIBBERISH_PATH);
/** @type {{ id: string, text: string, kind: string }[]} */
const strings = file.strings;

describe('gibberish set (eval/dev/gibberish.json)', () => {
  it('holds ≥ 40 distinct strings with opaque ids and a category each', () => {
    expect(strings.length).toBeGreaterThanOrEqual(40);
    expect(new Set(strings.map((s) => s.id)).size).toBe(strings.length);
    expect(new Set(strings.map((s) => normalise(s.text))).size).toBe(strings.length);
    for (const s of strings) {
      expect(s.id).toMatch(/^g-\d{2}$/);
      expect(['keyboard-mash', 'filler', 'slang', 'mixed']).toContain(s.kind);
    }
  });

  it('splits into a derivation half and a gate half of ≥ 20 each, disjoint and covering the set', () => {
    const { derivation, gate } = file.split;
    expect(derivation.length).toBeGreaterThanOrEqual(20);
    expect(gate.length).toBeGreaterThanOrEqual(20);
    expect([...derivation, ...gate].sort()).toEqual(strings.map((s) => s.id).sort());
    expect(derivation.filter((/** @type {string} */ id) => gate.includes(id))).toEqual([]);
  });

  it('reproduces its split from the recorded seed', () => {
    expect(Number.isInteger(file.split.seed)).toBe(true);
    const again = splitOf(file);
    expect(file.split.derivation).toEqual(again.derivation);
    expect(file.split.gate).toEqual(again.gate);
  });

  it('gets a different split from a different seed (the seed decides it)', () => {
    const ids = strings.map((s) => s.id);
    expect(splitGibberish(ids, file.split.seed + 1).derivation).not.toEqual(file.split.derivation);
  });

  it('is disjoint from the query suite and from every dev query', () => {
    const suite = suiteTexts(readJson(SUITE_PATH).items);
    const dev = devQueries();
    /** @type {string[]} */
    const hits = [];
    for (const s of strings) {
      for (const t of suite) if (nearDuplicate(s.text, t.text)) hits.push(`${s.id} ~ ${t.id} ${t.field}`);
      for (const d of dev) if (nearDuplicate(s.text, d.text)) hits.push(`${s.id} ~ ${d.id}`);
    }
    expect(hits).toEqual([]);
  });
});
