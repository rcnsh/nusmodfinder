// @ts-check
// scripts/check-findings.mjs: a malformed FINDINGS.md must fail, and the
// committed one must pass.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { startRun } from '../scripts/run-record.mjs';
import { checkFindings, checkRepo, evidenceRefs, parseIds, testTitles } from '../scripts/check-findings.mjs';

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

  it('reads exact test titles from the AST, not from comments or strings', () => {
    const titles = testTitles([
      "// it('[C] line comment')",
      "/* test('[C] block comment') */",
      "const s = \"it('[C] in string')\";",
      "/^a/.test('[C] regex test');",
      "it('[T] plain', () => {});",
      "it.fails('[T] fails', () => {});",
      "it.each([1])('[T] each %s', () => {});",
      "it.skipIf(true)('[T] skipIf', () => {});",
      "test.concurrent(`[T] template`, () => {});",
      "it.skipIf('[C] cond')('[T] after cond', () => {});",
      "it.each('[C] table')('[T] after table', () => {});",
      "it.each`a\n${1}`('[T] tagged %s', () => {});",
    ].join('\n'));
    expect([...titles].sort()).toEqual(['[T] after cond', '[T] after table', '[T] each %s', '[T] fails', '[T] plain', '[T] skipIf', '[T] tagged %s', '[T] template']);
  });

  it('checks paths with ./ prefixes, :line suffixes and any extension under a directory', () => {
    const { paths } = evidenceRefs('`./docs/x.gz` `docs/x.gz:12` `scripts/missing.py:3-9` `docs/x.7z` `evidence.har` `res.json()` `text/plain` `m.title` `a/b.py:3:5` `a/c.py:3,5` `a/d.py#L3` `a/e.py:L3` `a/f.js:`');
    expect(paths).toEqual(['./docs/x.gz', 'docs/x.gz', 'scripts/missing.py', 'docs/x.7z', 'evidence.har', 'a/b.py', 'a/c.py', 'a/d.py', 'a/e.py', 'a/f.js']);
  });

  it('passes on the committed docs/FINDINGS.md', () => {
    const { errors, counts } = checkRepo(fileURLToPath(new URL('..', import.meta.url)));
    expect(errors).toEqual([]);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(35);
  });

  it('Phase 7 7C: validates the run records in docs/evidence/ops/runs/ (schema, a past ISO time, an outcome), and keeps its errors for the 35 IDs as they were', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const runsDir = mkdtempSync(join(tmpdir(), 'vnm-findings-runs-'));
    try {
      const run = startRun('verify', { dir: runsDir, now: () => new Date('2026-11-12T10:15:30Z'), random: () => 'abcd' });
      run.finish('ok', { exitCode: 0 });
      expect(checkRepo(root, { runsDir, now: new Date('2026-11-12T11:00:00Z') }).errors).toEqual([]);
      writeFileSync(join(runsDir, '20261112T101531Z-verify-0001.json'), JSON.stringify({ schema: 'vnm-run/1', time: '2026-11-12T10:15:31Z', script: 'verify' }));
      writeFileSync(join(runsDir, '20271112T101531Z-verify-0002.json'), JSON.stringify({ ...JSON.parse(JSON.stringify({ schema: 'vnm-run/1' })), time: '2027-11-12T10:15:31Z', script: 'verify' }));
      const { errors } = checkRepo(root, { runsDir, now: new Date('2026-11-12T11:00:00Z') });
      expect(errors).toEqual(expect.arrayContaining([
        expect.stringMatching(/20261112T101531Z-verify-0001\.json: .*outcome/),
        expect.stringMatching(/20271112T101531Z-verify-0002\.json: .*in the future/),
      ]));
      expect(errors.every((e) => e.startsWith('docs/evidence/ops/runs/'))).toBe(true);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});
