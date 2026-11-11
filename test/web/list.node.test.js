// @ts-check
// public/list.js (Phase 6 6B): the shortlist's half of the URL. `pick` and
// `alt` repeated in rank order, each `CODE.S` or an untagged `CODE`, then `ay`,
// `inv` and `view`; the caps (20 a tagged semester, 40 in all); and every edit
// the view makes, as pure functions of the list.
import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES, MAX_PER_SEM, add, emptyList, entryValue, hasEntry, makeOther, move, parseList, remove, restore, setInvite, setSem, tagFor, withYear,
} from '../../public/list.js';
import { parseState, urlFor } from '../../public/state.js';

const parse = (/** @type {string} */ qs) => parseList(new URLSearchParams(qs));
/** The URL a link settles to: its state and its list, as the page writes them. @param {string} qs */
const round = (qs) => {
  const params = new URLSearchParams(qs);
  return urlFor(parseState(params), parseList(params).list, '/').replace(/^\/\??/, '');
};
/** @param {import('../../public/list.js').List} list */
const values = (list) => ({ pick: list.pick.map(entryValue), alt: list.alt.map(entryValue) });
/** @param {import('../../public/list.js').Edit} e */
const ok = (e) => {
  if (!e.ok) throw new Error(`refused: ${e.why}`);
  return e.list;
};

describe('the list in the URL (6B)', () => {
  it('reads pick and alt in rank order, CODE.S or untagged CODE, and writes them back after the search state', () => {
    const { list, dropped } = parse('pick=CS2030.1&pick=CS2113.2&alt=GE2101&pick=CS5562');
    expect(values(list)).toEqual({ pick: ['CS2030.1', 'CS2113.2', 'CS5562'], alt: ['GE2101'] });
    expect(dropped).toBe(0);
    expect(round('alt=GE2101&pick=CS2030.1&q=x&pick=CS2113.2&sem=1')).toBe('q=x&sem=1&pick=CS2030.1&pick=CS2113.2&alt=GE2101');
  });

  it('upper-cases and trims; drops malformed values and other tags', () => {
    const { list, dropped } = parse('pick=%20cs2030.1%20&pick=CS2113.3&pick=<b>&pick=CS3244.&pick=ABCDE1234&pick=CS3244.12&alt=ma1521.2&pick=');
    expect(values(list)).toEqual({ pick: ['CS2030.1'], alt: ['MA1521.2'] });
    expect(dropped).toBe(6);
  });

  it('tags 1 and 2 are kept, 3 is dropped, no tag stays untagged', () => {
    expect(values(parse('pick=A1001.1&pick=A1002.2&pick=A1003.3&pick=A1004').list).pick).toEqual(['A1001.1', 'A1002.2', 'A1004']);
  });

  it('keeps the first of duplicates; a code in both lists stays a pick', () => {
    const { list, dropped } = parse('pick=CS2030.1&pick=cs2030.2&alt=CS2030&alt=GE2101.1&alt=GE2101.2');
    expect(values(list)).toEqual({ pick: ['CS2030.1'], alt: ['GE2101.1'] });
    expect(dropped).toBe(3);
    // A pick later in the URL than its backup still wins: picks are read first.
    expect(values(parse('alt=CS2030.1&pick=CS2030.2').list)).toEqual({ pick: ['CS2030.2'], alt: [] });
  });

  it('keeps at most 20 entries in each tagged semester and 40 in all, and counts what it dropped', () => {
    const codes = (/** @type {number} */ n, /** @type {string} */ tag) => Array.from({ length: n }, (_, i) => `pick=AB${String(1000 + i)}${tag}`);
    const one = parse(codes(21, '.1').join('&'));
    expect(one.list.pick).toHaveLength(MAX_PER_SEM);
    expect(one.dropped).toBe(1);
    expect(one.list.pick.at(-1)?.code).toBe('AB1019');
    // 20 in Sem 1, 20 in Sem 2, then one untagged: the 41st is over 40.
    const all = parse([...codes(20, '.1'), ...Array.from({ length: 20 }, (_, i) => `alt=CD${2000 + i}.2`), 'alt=EF3000'].join('&'));
    expect(all.list.pick.length + all.list.alt.length).toBe(MAX_ENTRIES);
    expect(all.dropped).toBe(1);
    // Untagged entries count only towards 40.
    expect(parse(Array.from({ length: 41 }, (_, i) => `pick=AB${1000 + i}`).join('&')).list.pick).toHaveLength(40);
  });

  it('ay is the acad year as acad_year writes it, kept as parsed; anything else is dropped', () => {
    expect(parse('ay=2026-2027').list.ay).toBe('2026-2027');
    expect(parse('ay=2026-2028').list.ay).toBe('');
    expect(parse('ay=26-27').list.ay).toBe('');
    expect(parse('').list.ay).toBe('');
    expect(round('pick=CS2030.1&ay=2027-2028')).toBe('pick=CS2030.1&ay=2027-2028');
  });

  it('inv is biz or law, repeated; written only when ticked', () => {
    expect(parse('inv=law&inv=biz&inv=law&inv=x').list.inv).toEqual(['biz', 'law']);
    expect(round('inv=law&pick=ACC1701XA.1')).toBe('pick=ACC1701XA.1&inv=law');
    expect(round('pick=ACC1701XA.1')).toBe('pick=ACC1701XA.1');
  });

  it('view=shortlist opens the view, last in the URL; parseState drops open= when view is set', () => {
    expect(parseState(new URLSearchParams('view=shortlist&open=CS2030&q=x')).open).toBe('');
    expect(parseState(new URLSearchParams('view=other')).view).toBe('');
    expect(round('view=shortlist&open=CS2030&q=x&ay=2026-2027&pick=CS2030.1&inv=biz')).toBe('q=x&pick=CS2030.1&ay=2026-2027&inv=biz&view=shortlist');
  });

  it('pick=CS5562 stays as written (the page never tags an entry on its own after load)', () => {
    expect(round('q=networks&open=CS5562&pick=CS5562')).toBe('q=networks&open=CS5562&pick=CS5562');
  });

  it('the semester filter changing from both to 1 and back keeps every tag as written', () => {
    const list = parse('pick=CS2030.2&pick=CS2113&alt=GE2101.1').list;
    for (const sem of ['', '1', '']) {
      const params = new URLSearchParams(`q=x${sem ? `&sem=${sem}` : ''}`);
      expect(urlFor(parseState(params), list, '/')).toBe(`/?q=x${sem ? `&sem=${sem}` : ''}&pick=CS2030.2&pick=CS2113&alt=GE2101.1`);
    }
  });
});

describe('edits (6B; the view in 6C calls them)', () => {
  const start = () => parse('pick=A1001.1&pick=B1002.2&alt=C1003.1').list;

  it('add puts the course last among the picks; adding one already there changes nothing', () => {
    expect(values(ok(add(start(), 'D1004', '2'))).pick).toEqual(['A1001.1', 'B1002.2', 'D1004.2']);
    expect(values(ok(add(start(), 'c1003', '')))).toEqual(values(start()));
    expect(hasEntry(start(), 'C1003')).toBe('alt');
    expect(hasEntry(start(), 'Z9999')).toBe('');
  });

  it('add and a semester move refuse past a cap, and say why', () => {
    let list = emptyList();
    for (let i = 0; i < 20; i += 1) list = ok(add(list, `AB${1000 + i}`, '1'));
    const refused = add(list, 'CD2000', '1');
    expect(refused).toEqual({ ok: false, why: 'Sem 1 already has 20 courses on your shortlist, the most it keeps for one semester.' });
    list = ok(add(list, 'CD2000', '2'));
    expect(setSem(list, 'CD2000', '1')).toMatchObject({ ok: false });
    for (let i = 1; i < 20; i += 1) list = ok(add(list, `CD${2000 + i}`, '2'));
    expect(add(list, 'EF3000', '')).toEqual({ ok: false, why: 'Your shortlist already has 40 courses, the most it keeps.' });
  });

  it('Move up and Move down swap with the neighbour in the same list, whatever its semester', () => {
    const list = parse('pick=A1001.1&pick=B1002.2').list;
    expect(values(ok(move(list, 'B1002', -1))).pick).toEqual(['B1002.2', 'A1001.1']);
    expect(move(list, 'A1001', -1)).toEqual({ ok: false, why: 'A1001 is already first' });
    expect(move(list, 'B1002', 1)).toEqual({ ok: false, why: 'B1002 is already last' });
    // The first backup is first in its own list, whatever the picks above it.
    expect(move(start(), 'C1003', -1)).toEqual({ ok: false, why: 'C1003 is already first' });
  });

  it('Make backup and Make primary move the entry to the end of the other list, keeping its semester', () => {
    expect(values(ok(makeOther(start(), 'A1001')))).toEqual({ pick: ['B1002.2'], alt: ['C1003.1', 'A1001.1'] });
    expect(values(ok(makeOther(start(), 'C1003')))).toEqual({ pick: ['A1001.1', 'B1002.2', 'C1003.1'], alt: [] });
  });

  it('remove then restore (Undo) puts the entry back in its list, rank and semester', () => {
    const r = remove(start(), 'B1002');
    if (!r.ok) throw new Error('refused');
    expect(values(r.list).pick).toEqual(['A1001.1']);
    expect(r.removed).toEqual({ which: 'pick', index: 1, entry: { code: 'B1002', sem: '2' } });
    expect(values(ok(restore(r.list, r.removed)))).toEqual(values(start()));
  });

  it('setSem tags or re-tags one entry; setInvite ticks and unticks', () => {
    expect(values(ok(setSem(start(), 'A1001', '2'))).pick).toEqual(['A1001.2', 'B1002.2']);
    expect(ok(setInvite(start(), 'law', true)).inv).toEqual(['law']);
    expect(ok(setInvite(ok(setInvite(start(), 'law', true)), 'biz', true)).inv).toEqual(['biz', 'law']);
    expect(ok(setInvite(ok(setInvite(start(), 'law', true)), 'law', false)).inv).toEqual([]);
  });

  it('withYear sets ay once, from the first loaded row; a parsed ay is never rewritten', () => {
    expect(withYear(start(), '2026-2027').ay).toBe('2026-2027');
    expect(withYear(parse('ay=2025-2026').list, '2026-2027').ay).toBe('2025-2026');
    expect(withYear(start(), '').ay).toBe('');
  });

  it('a new entry takes the state\'s semester if 1 or 2, else the one semester it is open in (or taught in), else none', () => {
    expect(tagFor('2', [1])).toBe('2');
    expect(tagFor('', [2])).toBe('2');
    expect(tagFor('', [1, 2])).toBe('');
    expect(tagFor('3', [1])).toBe('1');
    expect(tagFor('', [])).toBe('');
  });
});
