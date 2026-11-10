// @ts-check
// The parsed-phrase chips' words (public/intents.js, Phase 5 5F), in Node.
import { describe, expect, it } from 'vitest';
import { intentChips, PHRASE_INTENTS } from '../../public/intents.js';
import { IGNORABLE } from '../../public/state.js';
import { IGNORABLE_INTENTS, INTERPRETED_KEYS } from '../../src/query-intent.js';

describe('intentChips', () => {
  it('names each parsed 3H intent in the Worker\'s interpreted shape, in its order', () => {
    expect(intentChips({ pin: ['CS2105'], prefix: null, ge: ['GEA'], level: null, exam: 0, su: { value: 1, basis: ['CS/CU', 'su'] }, hoursBelow: 10, prereq: { value: 'none', semantics: 'ii' } }))
      .toEqual([
        { intent: 'exam', label: 'No final exam' },
        { intent: 'su', label: 'Can be taken S/U' },
        { intent: 'hoursBelow', label: 'Under 10 h a week' },
        { intent: 'prereq', label: 'No prerequisites' },
      ]);
  });

  it('shows nothing when nothing was parsed, for an undone intent, or for a value the Worker never sends', () => {
    expect(intentChips({ exam: null, su: null, hoursBelow: null, prereq: null })).toEqual([]);
    expect(intentChips(undefined)).toEqual([]);
    expect(intentChips('exam')).toEqual([]);
    expect(intentChips({ exam: 0, hoursBelow: 7 }, ['exam'])).toEqual([{ intent: 'hoursBelow', label: 'Under 7 h a week' }]);
    expect(intentChips({ exam: 1, hoursBelow: '<b>9</b>', prereq: { value: 'some' }, su: { value: 0 } })).toEqual([]);
  });

  it('every chip\'s intent is one /search can undo and the URL keeps', () => {
    for (const i of PHRASE_INTENTS) {
      expect(INTERPRETED_KEYS).toContain(i);
      expect(IGNORABLE_INTENTS).toContain(i);
      expect(IGNORABLE).toContain(i);
    }
  });
});
