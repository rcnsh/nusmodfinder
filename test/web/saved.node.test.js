// @ts-check
// public/saved.js (Phase 6 6B, G3): the last list this student edited, kept
// on this device. "Restore your last shortlist" offers it when a link has no
// list; "Forget this list on this device" clears it; opening someone else's
// link never overwrites it (the page saves only on its own edits).
import { describe, expect, it } from 'vitest';
import { entryValue, parseList } from '../../public/list.js';
import { SAVED_KEY, forgetList, loadList, restoreOffer, saveList } from '../../public/saved.js';

/** A Storage stand-in; `broken` throws as Safari's private mode and blocked storage do. */
function memory(broken = false) {
  /** @type {Map<string, string>} */
  const m = new Map();
  const guard = () => { if (broken) throw new Error('SecurityError'); };
  return {
    getItem: (/** @type {string} */ k) => { guard(); return m.get(k) ?? null; },
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { guard(); m.set(k, v); },
    removeItem: (/** @type {string} */ k) => { guard(); m.delete(k); },
    m,
  };
}
const list = (/** @type {string} */ qs) => parseList(new URLSearchParams(qs)).list;
const values = (/** @type {import('../../public/list.js').List | null} */ l) => (l ? [...l.pick, ...l.alt].map(entryValue) : null);

describe('the list on this device (G3)', () => {
  it('saves the list and loads it back: lists, ranks, semesters, ay and inv', () => {
    const s = memory();
    saveList(s, list('pick=CS2030.1&pick=CS2113&alt=GE2101.2&ay=2026-2027&inv=biz'));
    expect(s.m.get(SAVED_KEY)).toBe('pick=CS2030.1&pick=CS2113&alt=GE2101.2&ay=2026-2027&inv=biz');
    expect(loadList(s)).toEqual(list('pick=CS2030.1&pick=CS2113&alt=GE2101.2&ay=2026-2027&inv=biz'));
  });

  it('an emptied list is no list to restore: saving it clears the copy', () => {
    const s = memory();
    saveList(s, list('pick=CS2030.1'));
    saveList(s, list(''));
    expect(s.m.has(SAVED_KEY)).toBe(false);
    expect(loadList(s)).toBeNull();
  });

  it('a mangled copy loads only what a link would (the same parser), and nothing when empty', () => {
    const s = memory();
    s.m.set(SAVED_KEY, 'pick=<b>&pick=cs2030.1&alt=x');
    expect(values(loadList(s))).toEqual(['CS2030.1']);
    s.m.set(SAVED_KEY, 'garbage');
    expect(loadList(s)).toBeNull();
  });

  it('offers the copy only when the link has no list', () => {
    const s = memory();
    saveList(s, list('pick=CS2030.1'));
    expect(values(restoreOffer(list(''), s))).toEqual(['CS2030.1']);
    expect(restoreOffer(list('pick=GE2101.1'), s)).toBeNull();
    // ay or inv alone are not a list.
    expect(values(restoreOffer(list('ay=2026-2027'), s))).toEqual(['CS2030.1']);
  });

  it('Forget clears the copy only', () => {
    const s = memory();
    saveList(s, list('pick=CS2030.1'));
    forgetList(s);
    expect(loadList(s)).toBeNull();
  });

  it('storage that throws (private mode, blocked) or is missing is no copy, never an error', () => {
    const s = memory(true);
    expect(() => saveList(s, list('pick=CS2030.1'))).not.toThrow();
    expect(loadList(s)).toBeNull();
    expect(() => forgetList(s)).not.toThrow();
    expect(loadList(null)).toBeNull();
  });
});
