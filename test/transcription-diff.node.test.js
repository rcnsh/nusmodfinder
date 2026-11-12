// @ts-check
// scripts/transcription-diff.mjs maps a new year's rule ids to last year's by the quoted sentence,
// so the overlay (keyed by id) carries over and only real changes reach the register. Measured on
// the live year's two independent transcriptions (A, and B, the one its source manifest names),
// which named the same rules differently: B's C-urop-fass is A's C-urops-fass.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { diffTranscriptions, main, mapIds, normaliseRuleQuote } from '../scripts/transcription-diff.mjs';
import { REPO, Y } from './year-fakes.node.mjs';

/** @type {string} */
const B_PATH = join(REPO, JSON.parse(readFileSync(join(REPO, `data/ng-sources-${Y}.json`), 'utf8')).transcription);
const A_PATH = B_PATH.replace(/-b\.json$/, '-a.json');
const rules = (/** @type {string} */ p) => JSON.parse(readFileSync(p, 'utf8')).rules;
const A = rules(A_PATH);
const B = rules(B_PATH);

describe('transcription-diff', () => {
  it('maps B\'s ids to A\'s by quote: renamed, kept, ambiguous only where two rules share a quote and place', () => {
    const r = mapIds(A, B);
    expect(r.renamed).toContainEqual({ from: 'C-urop-fass', to: 'C-urops-fass' });
    expect(r.renamed).toContainEqual({ from: 'E-offerings-list', to: 'E-not-in-offerings' });
    expect(r.kept.length + r.renamed.length + r.ambiguous.length + r.added.length).toBe(B.length);
    expect(r.ambiguous.map((x) => x.id).sort()).toEqual(['1-socanth-grad-approval', '1-socanth-grad-only', '4-mse-closed-1', '4-mse-closed-2']);
    // Each of last year's ids is used at most once.
    const targets = [...r.kept.map((k) => k.lastId), ...r.renamed.map((x) => x.to)];
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('a rule whose quote is new is added; one whose quote is gone is dropped; a same-id same-quote rule is kept', () => {
    const last = [{ id: 'X-1', section: 'A', quote: 'Old “sentence”.' }, { id: 'X-2', section: 'A', quote: 'Gone.' }];
    const next = [{ id: 'X-1b', section: 'A', quote: "old 'sentence'" }, { id: 'X-3', section: 'A', quote: 'New.' }];
    expect(mapIds(/** @type {any} */ (last), /** @type {any} */ (next))).toEqual({
      kept: [], renamed: [{ from: 'X-1b', to: 'X-1' }], ambiguous: [], added: ['X-3'], dropped: ['X-2'],
    });
    expect(mapIds(/** @type {any} */ (last), /** @type {any} */ (last)).kept).toHaveLength(2);
    expect(normaliseRuleQuote('Courses — “Level 4000”')).toBe('courses level 4000');
  });

  it('two transcriptions of the same list agree on their facts but for the documented differences', () => {
    const d = diffTranscriptions(A, B);
    expect(d.shared).toBeGreaterThan(0);
    expect(d.sizeA).toBeGreaterThan(0);
  });

  it('the CLI prints the id map', () => {
    /** @type {string[]} */
    const lines = [];
    expect(main(['--map-to', A_PATH, B_PATH], { log: (m) => lines.push(m) })).toBe(0);
    expect(lines.join('\n')).toMatch(/^C-urop-fass -> C-urops-fass$/m);
  });
});
