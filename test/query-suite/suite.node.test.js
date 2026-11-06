// @ts-check
// P-6: the SC4 acceptance suite (docs/plans/phase3.md §4) is fixed in one
// commit. These tests pin its shape: §4's per-row counts, the `interpreted`
// schema, the topK rule, the thresholds, no dev text beyond the four §4 names,
// and the sha256 recorded in docs/plans/phase3-prereg.md, so the file cannot
// change without the doc (implementers may not edit the suite).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from '../../eval/lib/sets.mjs';
import { ALLOWED_DEV, DOC_PATH, INTERPRETED_KEYS, ROW_COUNTS, SUITE_PATH, devQueries, nearDuplicate, normalise, suiteTexts } from './sc4.node.mjs';

const raw = readFileSync(SUITE_PATH);
/** @type {any} */
const suite = JSON.parse(raw.toString('utf8'));
/** @type {any[]} */
const items = suite.items;
const dev = devQueries();

describe('SC4 suite (test/sc4/queries.json)', () => {
  it('has exactly 90 items with §4\'s per-row counts', () => {
    expect(items).toHaveLength(90);
    /** @type {Record<string, number>} */
    const counts = {};
    for (const it of items) counts[it.row] = (counts[it.row] ?? 0) + 1;
    expect(counts).toEqual(ROW_COUNTS);
    expect(Object.values(ROW_COUNTS).reduce((a, b) => a + b, 0)).toBe(90);
  });

  it('gives every item a unique id, a text, a rule with parameters, a topK and an interpreted object', () => {
    expect(new Set(items.map((it) => it.id)).size).toBe(90);
    items.forEach((it, i) => {
      expect(it.id).toBe(`sc4-${String(i + 1).padStart(3, '0')}`);
      expect(typeof it.text).toBe('string');
      expect(it.text.trim()).toBe(it.text);
      expect(it.text.length).toBeGreaterThan(0);
      expect(it.text.length).toBeLessThanOrEqual(200);
      expect(typeof it.rule).toBe('string');
      expect(typeof it.params).toBe('object');
      expect(Number.isInteger(it.topK)).toBe(true);
      expect(typeof it.interpreted).toBe('object');
    });
    expect(new Set(items.map((it) => normalise(it.text))).size).toBe(90);
  });

  it('gives every interpreted object exactly the schema keys, null for each intent it must not set', () => {
    expect(suite.interpretedKeys).toEqual(INTERPRETED_KEYS);
    for (const it of items) {
      expect(Object.keys(it.interpreted), it.id).toEqual(INTERPRETED_KEYS);
      const { pin, prefix, ge, level, exam, su, hoursBelow, prereq } = it.interpreted;
      if (pin !== null) expect(pin.every((/** @type {string} */ c) => /^[A-Z]+\d{4}[A-Z]*$/.test(c)), it.id).toBe(true);
      if (prefix !== null) expect(prefix, it.id).toMatch(/^[A-Z]{2,4}\d{0,3}$/);
      if (ge !== null) expect([...ge].sort(), it.id).toEqual(ge);
      if (level !== null) {
        expect(Object.keys(level), it.id).toEqual(['min', 'max', 'source']);
        expect(level.source.every((/** @type {string} */ s) => ['beginner', 'graduate', 'level', 'year'].includes(s)), it.id).toBe(true);
      }
      if (exam !== null) expect(exam, it.id).toBe(0);
      if (su !== null) expect(su, it.id).toEqual({ value: 1, basis: ['CS/CU', 'su'] });
      if (hoursBelow !== null) expect(Number.isInteger(hoursBelow), it.id).toBe(true);
      if (prereq !== null) expect(prereq, it.id).toEqual({ value: 'none', semantics: '$selected' });
    }
  });

  it('runs the partial-code and pillar items at topK 50 and every other item at 20', () => {
    for (const it of items) expect(it.topK, it.id).toBe(it.row === 'partial-code' ? 50 : 20);
  });

  it('carries the thresholds fixed at P-6: T from eval/prereg/typo-threshold.json, M = 3', () => {
    const t = JSON.parse(readFileSync(join(REPO, 'eval/prereg/typo-threshold.json'), 'utf8'));
    expect(suite.thresholds).toEqual({ T: t.T, M: 3 });
    for (const it of items.filter((x) => x.row === 'typo')) expect(it.params.T, it.id).toBe(t.T);
    for (const it of items.filter((x) => x.row === 'code-in-longer')) expect(it.params.M, it.id).toBe(3);
  });

  it('gives each typo item the interpreted of its clean form, and each constraint item a reference', () => {
    for (const it of items.filter((x) => x.row === 'typo')) {
      expect(typeof it.params.clean).toBe('string');
      expect(normalise(it.params.clean)).not.toBe(normalise(it.text));
    }
    for (const it of items.filter((x) => ['no-exam', 'su', 'workload', 'no-prereq'].includes(x.row))) {
      expect(it.rule).toBe('constraint');
      expect(it.params.minOverlap).toBe(7);
      expect(Object.keys(it.params.param)).toHaveLength(1);
      expect(typeof it.params.reference).toBe('string');
    }
  });

  it('holds no dev text, or near-duplicate of one, beyond the four §4 names (d-024, d-079, d-022, d-016)', () => {
    // Only the four named items may carry dev text, each verbatim and in its row.
    const named = items.filter((x) => String(x.origin).startsWith('dev:'));
    expect(named.map((x) => x.origin).sort()).toEqual(Object.keys(ALLOWED_DEV).map((id) => `dev:${id}`).sort());
    for (const it of named) {
      const id = it.origin.slice(4);
      expect(it.row, id).toBe(/** @type {Record<string, string>} */ (ALLOWED_DEV)[id]);
      expect(it.text, id).toBe(dev.find((x) => x.id === id)?.text);
    }
    /** @type {string[]} */
    const hits = [];
    for (const s of suiteTexts(items)) {
      const item = items.find((x) => x.id === s.id);
      // A named item's text is that dev text, so it may resemble other dev texts;
      // its reference is derived from it, so it may resemble its own source only.
      const source = String(item.origin).startsWith('dev:') ? item.origin.slice(4) : null;
      if (source && s.field === 'text') continue;
      for (const d of dev) if (d.id !== source && nearDuplicate(s.text, d.text)) hits.push(`${s.id} ${s.field} ~ ${d.id}`);
    }
    expect(hits).toEqual([]);
    // Each allowed dev text appears once, verbatim.
    for (const id of Object.keys(ALLOWED_DEV)) {
      const d = dev.find((x) => x.id === id);
      expect(items.filter((x) => x.text === d?.text), id).toHaveLength(1);
    }
  });

  it('is pinned by the sha256 docs/plans/phase3-prereg.md records', () => {
    const doc = readFileSync(DOC_PATH, 'utf8');
    const m = doc.match(/SC4 suite sha256 `([0-9a-f]{64})`/);
    expect(m, 'the prereg doc records the suite sha256').not.toBeNull();
    expect(createHash('sha256').update(raw).digest('hex')).toBe(/** @type {RegExpMatchArray} */ (m)[1]);
  });
});
