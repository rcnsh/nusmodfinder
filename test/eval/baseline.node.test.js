// @ts-check
// The two baseline pins (ADR 0003): the SC5 / test-set baseline is eval-v0 =
// 7ac9841 and never moves; the shipped-ranker pin, which per-change holdout
// looks compare against, moves only in the PR that ships a change, with a
// line in ADR 0003's "Shipped-ranker pin" section. The CLI's use of each is
// tested end to end in gate-custody.node.test.js.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselinePinFor, PINNED_BASELINE, pinLabel, SHIPPED_BASELINE } from '../../eval/lib/baseline.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

describe('baseline pins', () => {
  it('the SC5 / test-set baseline is eval-v0 = 7ac9841', () => {
    expect(PINNED_BASELINE).toEqual({ ref: 'eval-v0', sha: '7ac984174ded88cb2b6497d9835b456981acdd99' });
    expect(Object.isFrozen(PINNED_BASELINE)).toBe(true);
  });

  it('the shipped-ranker pin is the last line of ADR 0003\'s "Shipped-ranker pin" section', async () => {
    const adr = await readFile(join(REPO, 'docs', 'decisions', '0003-eval-holdout-and-gate.md'), 'utf8');
    const section = adr.split(/^## /m).find((s) => s.startsWith('Shipped-ranker pin'));
    expect(section, 'ADR 0003 has a "Shipped-ranker pin" section').toBeDefined();
    const lines = [.../** @type {string} */ (section).matchAll(/^- shipped pin: `([^`]+)` ([0-9a-f]{40})\b/gm)];
    expect(lines.length, 'the section lists at least one shipped pin').toBeGreaterThan(0);
    const [, ref, sha] = /** @type {RegExpMatchArray} */ (lines.at(-1));
    expect({ ref, sha }).toEqual({ ...SHIPPED_BASELINE });
    expect(Object.isFrozen(SHIPPED_BASELINE)).toBe(true);
  });

  it('SC5 verdicts (the test set, or --gate sc5) use the SC5 pin; per-change holdout looks the shipped pin', () => {
    expect(baselinePinFor('test', {})).toBe(PINNED_BASELINE);
    expect(baselinePinFor('holdout', { gate: 'sc5' })).toBe(PINNED_BASELINE);
    for (const change of [{}, { kind: /** @type {const} */ ('cutoff') }, { targetShapes: ['topical'] }]) {
      expect(baselinePinFor('holdout', change)).toBe(SHIPPED_BASELINE);
    }
  });

  it('labels a tag pin with its name and a plain-sha pin with its short sha', () => {
    expect(pinLabel(PINNED_BASELINE)).toBe('eval-v0 7ac9841');
    expect(pinLabel({ ref: 'a'.repeat(40), sha: 'a'.repeat(40) })).toBe('aaaaaaa');
  });
});
