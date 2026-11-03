// @ts-check
// scripts/check-findings.mjs: a malformed FINDINGS.md must fail, and the
// committed one must pass.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkFindings, checkRepo, parseIds } from '../scripts/check-findings.mjs';

const IDS = Array.from({ length: 35 }, (_, i) => `X${i + 1}`);
const criteria = (/** @type {string[]} */ ids = IDS) => `# C\n\n<!-- ids:start -->\n${ids.join(' ')}\n<!-- ids:end -->\n`;
const section = (/** @type {string} */ id, /** @type {string} */ status, evidence = '- test `[X known-bug] works`') =>
  `### ${id} · claim\n\n**Status:** ${status}\n\n**Evidence:**\n${evidence}\n\n**Notes:** n\n`;
const good = () => IDS.map((id) => section(id, 'reproduced')).join('\n');

/** @param {Partial<Parameters<typeof checkFindings>[0]>} over */
const run = (over = {}) => checkFindings({
  criteria: criteria(),
  findings: good(),
  fileExists: (p) => p === 'docs/evidence/real.body',
  testSource: "it('[X known-bug] works', () => {})",
  ...over,
});

describe('check-findings', () => {
  it('passes a well-formed FINDINGS.md', () => {
    expect(run()).toEqual([]);
  });

  it('requires exactly 35 unique IDs in the CRITERIA block', () => {
    expect(parseIds(criteria(IDS.slice(1))).errors).toEqual(['CRITERIA.md: expected 35 IDs, found 34']);
    expect(parseIds(criteria([...IDS.slice(1), 'X2'])).errors).toEqual(['CRITERIA.md: duplicate IDs X2']);
    expect(parseIds('no block').errors).toHaveLength(1);
    expect(run({ criteria: criteria([]) })).toContain('CRITERIA.md: expected 35 IDs, found 0');
  });

  it('fails a missing section, an unknown status, a missing status and a duplicate', () => {
    const findings = [
      ...IDS.slice(4).map((id) => section(id, 'reproduced')),
      section('X2', 'confirmed'),
      section('X3', 'reproduced'),
      section('X3', 'rejected'),
      '### X4 · no status\n\ntext\n',
      '### X99 · not in criteria\n\n**Status:** rejected\n',
    ].join('\n');
    expect(run({ findings })).toEqual([
      expect.stringMatching(/X2: status "confirmed" is not one of reproduced \| partially-reproduced \| rejected \| fixed$/),
      expect.stringMatching(/X3: duplicate section/),
      expect.stringMatching(/X4: no \*\*Status:\*\* line/),
      expect.stringMatching(/X99: not an ID in CRITERIA\.md/),
      expect.stringMatching(/X99: status "rejected" needs at least one existing evidence/),
      'FINDINGS.md: no section for X1',
    ]);
  });

  it('fails a reproduced finding with no evidence, or evidence that does not exist', () => {
    const findings = good()
      .replace(section('X1', 'reproduced'), section('X1', 'reproduced', '- seen it, trust me'))
      .replace(section('X2', 'reproduced'), section('X2', 'partially-reproduced', '- `docs/evidence/missing.body`'))
      .replace(section('X3', 'reproduced'), section('X3', 'fixed', '- test `[X3 fixed] nowhere`'))
      .replace(section('X4', 'reproduced'), section('X4', 'rejected', '- none needed'))
      .replace(section('X6', 'reproduced'), section('X6', 'reproduced', '- `scripts/missing.py` `docs/x/y.gz` test `[X6 known-bug]` test `[`'))
      .replace(section('X5', 'reproduced'), section('X5', 'reproduced', '- `docs/evidence/real.body`'));
    const errors = run({ findings });
    expect(errors).toEqual([
      expect.stringMatching(/X1: status "reproduced" needs at least one existing evidence/),
      expect.stringMatching(/X2: evidence file docs\/evidence\/missing\.body does not exist/),
      expect.stringMatching(/X2: status "partially-reproduced" needs at least one/),
      expect.stringMatching(/X3: test \[X3 fixed\] nowhere not found under test\//),
      expect.stringMatching(/X3: status "fixed" needs at least one/),
      expect.stringMatching(/X4: status "rejected" needs at least one/),
      expect.stringMatching(/X6: evidence file scripts\/missing\.py does not exist/),
      expect.stringMatching(/X6: evidence file docs\/x\/y\.gz does not exist/),
      expect.stringMatching(/X6: test \[X6 known-bug\] not found/),
      expect.stringMatching(/X6: test \[ not found/),
      expect.stringMatching(/X6: status "reproduced" needs at least one/),
    ]);
  });

  it('fails when the summary table disagrees with a section', () => {
    const findings = `| ID | Status |\n|---|---|\n| X1 | rejected |\n\n## Findings\n\n${good()}`;
    expect(run({ findings })).toEqual([expect.stringMatching(/summary table says X1 is "rejected", its section says "reproduced"/)]);
  });

  it('passes on the committed docs/FINDINGS.md', () => {
    const { errors, counts } = checkRepo(fileURLToPath(new URL('..', import.meta.url)));
    expect(errors).toEqual([]);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(35);
  });
});
