// @ts-check
// The two baseline pins (ADR 0003): the test-set baseline is eval-v0 =
// 5c5cce4 and never moves; the shipped-ranker pin, which per-change holdout
// looks compare against, moves only in the PR that ships a change, with a
// line in ADR 0003's "Shipped-ranker pin" section. The CLI's use of each is
// tested end to end in gate-custody.node.test.js.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { baselinePinFor, PINNED_BASELINE, pinLabel, SHIPPED_BASELINE } from '../../eval/lib/baseline.mjs';
import { REPO } from '../../eval/lib/sets.mjs';

describe('baseline pins', () => {
  it('the test-set baseline is eval-v0 = 5c5cce4', () => {
    expect(PINNED_BASELINE).toEqual({ ref: 'eval-v0', sha: '5c5cce441bd33c8f66bb2857e4d7f5584cbc20ed' });
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

  it('the test set uses eval-v0; per-change holdout looks use the shipped pin', () => {
    expect(baselinePinFor('test')).toBe(PINNED_BASELINE);
    expect(baselinePinFor('holdout')).toBe(SHIPPED_BASELINE);
  });

  it('labels a tag pin with its name and a plain-sha pin with its short sha', () => {
    expect(pinLabel(PINNED_BASELINE)).toBe('eval-v0 5c5cce4');
    expect(pinLabel({ ref: 'a'.repeat(40), sha: 'a'.repeat(40) })).toBe('aaaaaaa');
  });
});
