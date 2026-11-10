// @ts-check
// public/state.js and public/nav.js (Phase 5 5B, F3, F4, C-7, A2-4, A3-3): the
// page's state lives in the URL, parsed and written by one pure module, and
// every history transition is decided by one pure function. The browser half
// (pushState, popstate) is test/ui/history.spec.js.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IGNORABLE_INTENTS } from '../../src/query-intent.js';
import { transition } from '../../public/nav.js';
import {
  CREDITS, IGNORABLE, LEVELS, MAX_QUERY_CHARS, SEMESTERS, STUDIES, emptyState, parseState, searchParams, stateToParams, urlFor,
} from '../../public/state.js';

const parse = (/** @type {string} */ qs) => parseState(new URLSearchParams(qs));
const round = (/** @type {string} */ qs) => stateToParams(parse(qs)).toString();

describe('URL state (F3, C-7)', () => {
  it('parses every field and writes them back in one canonical order', () => {
    const s = parse('alt=x&open=cs3244&study=ug2&ng=1&faculty=Computing&credits=4&level=3&sem=2&q=machine+learning');
    expect(s).toEqual({
      q: 'machine learning', sem: '2', level: '3', credits: '4', faculty: 'Computing', ng: true, study: 'ug2',
      ignore: [], open: 'CS3244', pick: [], alt: ['x'],
    });
    expect(stateToParams(s).toString())
      .toBe('q=machine+learning&sem=2&level=3&credits=4&faculty=Computing&ng=1&study=ug2&open=CS3244&alt=x');
  });

  it('an empty state is an empty query string, so the bare page URL', () => {
    expect(stateToParams(emptyState()).toString()).toBe('');
    expect(urlFor(emptyState(), '/')).toBe('/');
    expect(urlFor(parse('q=x'), '/')).toBe('/?q=x');
  });

  it('drops values /search would reject instead of failing the page', () => {
    expect(parse('sem=9&level=0&credits=-1&study=phd&open=<b>')).toMatchObject({ sem: '', level: '', credits: '', study: '', open: '' });
    expect(parse('sem=3&level=8&credits=12&study=grad&open=GEC1015A')).toMatchObject({ sem: '3', level: '8', credits: '12', study: '', open: 'GEC1015A' });
  });

  it('in exchange mode ng=1 and study are always written; sem is absent for both semesters', () => {
    expect(round('ng=1&study=ug1&q=x')).toBe('q=x&ng=1&study=ug1');
    expect(round('ng=1&study=ug1&sem=1&q=x')).toBe('q=x&sem=1&ng=1&study=ug1');
    // ng=0 and ng=false do not narrow (as /search), so they are not exchange mode.
    expect(parse('ng=0&study=ug1').ng).toBe(false);
    expect(parse('ng=false').ng).toBe(false);
    // Outside exchange mode the study level is ignored (as /search), so it is not kept.
    expect(round('study=ug1&q=x')).toBe('q=x');
  });

  it('keeps Phase 6 names pick and alt (reserved) through a round trip, every value in order', () => {
    expect(round('q=x&pick=CS3244&pick=CS2040&alt=MA1521')).toBe('q=x&pick=CS3244&pick=CS2040&alt=MA1521');
  });

  it('ignore= keeps only the intents /search can undo, and q only the length it accepts, so a mangled link still searches', () => {
    expect(IGNORABLE).toEqual(IGNORABLE_INTENTS);
    const searchSrc = readFileSync(new URL('../../src/search.js', import.meta.url), 'utf8');
    expect(searchSrc).toContain(`const MAX_QUERY_CHARS = ${MAX_QUERY_CHARS};`);
    expect(parse('q=x&ignore=bogus,exam,ge').ignore).toEqual(['exam', 'ge']);
    expect(parse('q=x&ignore=bogus').ignore).toEqual([]);
    expect(parse(`q=${'a'.repeat(250)}`).q).toHaveLength(MAX_QUERY_CHARS);
    expect(parse(`q=${'%20'.repeat(5)}${'a'.repeat(200)}`).q).toBe('a'.repeat(200));
  });

  it('ignore= is a sorted, de-duplicated list, as /search parses it', () => {
    expect(parse('q=x&ignore=prereq,exam,exam').ignore).toEqual(['exam', 'prereq']);
    expect(round('q=x&ignore=prereq,exam')).toBe('q=x&ignore=exam%2Cprereq');
  });

  it('searchParams is the /search query: no open, pick or alt; null with no query or exchange mode without a study level', () => {
    expect(searchParams(parse('q=x&sem=1&ng=1&study=ug2&open=CS1010&pick=A&alt=B&ignore=exam'))?.toString())
      .toBe('q=x&sem=1&ng=1&study=ug2&ignore=exam');
    expect(searchParams(parse('sem=1'))).toBeNull();
    expect(searchParams(parse('q=%20%20'))).toBeNull();
    expect(searchParams(parse('q=x&ng=1'))).toBeNull();
  });

  it('[F4 fixed] the semester, level, credits and study-level options are static: no filter waits on /facets', () => {
    expect(SEMESTERS.map((o) => o.value)).toEqual(['1', '2', '3', '4']);
    expect(LEVELS.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '8']);
    expect(CREDITS).toEqual(['2', '4', '5', '6', '8', '12']);
    expect(STUDIES.map((o) => o.value)).toEqual(['ug1', 'ug2', 'ug3', 'ug4', 'grad']);
  });
});

describe('history transitions (F3, A2-4, A3-3; the table in docs/plans/phase5.md 5B)', () => {
  const list = parse('q=networks&sem=1');
  const open = parse('q=networks&sem=1&open=CS2105');

  it('[F3 fixed] submit a query: push, and Back restores the previous query (its URL is the entry left behind)', () => {
    const t = transition(list, { type: 'submit', form: parse('q=databases&sem=1') }, { detailPushed: false });
    expect(t.op).toBe('push');
    expect(stateToParams(t.state).toString()).toBe('q=databases&sem=1');
  });

  it('submitting the same search again replaces, so Back never lands on an identical page', () => {
    expect(transition(list, { type: 'submit', form: parse('q=networks&sem=1') }, { detailPushed: false }).op).toBe('replace');
  });

  it('submit drops an open detail', () => {
    const t = transition(open, { type: 'submit', form: parse('q=databases&sem=1') }, { detailPushed: true });
    expect(t).toMatchObject({ op: 'push', state: { open: '' } });
  });

  it('change a filter, exchange setting or remove a chip: replace, and drop open= (A3-3)', () => {
    for (const form of [parse('q=networks&sem=2'), parse('q=networks&sem=1&ng=1&study=ug2'), parse('q=networks&sem=1&ignore=exam')]) {
      const t = transition(open, { type: 'settings', form }, { detailPushed: true });
      expect(t.op).toBe('replace');
      expect(t.state.open).toBe('');
      expect(t.state.q).toBe('networks');
    }
  });

  it('a settings change while a different query is typed submits that query (push), as the Phase 4 page searched the typed text', () => {
    const t = transition(list, { type: 'settings', form: parse('q=databases&sem=2') }, { detailPushed: false });
    expect(t).toMatchObject({ op: 'push', state: { q: 'databases', sem: '2' } });
    expect(transition(list, { type: 'settings', form: parse('q=networks%20&sem=2') }, { detailPushed: false }).op).toBe('replace');
  });

  it('a new query drops ignore= (it undid the old query\'s phrases); the same query keeps it', () => {
    const withIgnore = parse('q=networks&ignore=exam');
    expect(transition(withIgnore, { type: 'submit', form: parse('q=databases&ignore=exam') }, { detailPushed: false }).state.ignore).toEqual([]);
    expect(transition(withIgnore, { type: 'settings', form: parse('q=networks&sem=1&ignore=exam') }, { detailPushed: false }).state.ignore).toEqual(['exam']);
  });

  it('open a detail with none open: push; opening another while one is open: replace (one open detail)', () => {
    expect(transition(list, { type: 'open', code: 'cs2105' }, { detailPushed: false })).toMatchObject({ op: 'push', state: { open: 'CS2105' } });
    expect(transition(open, { type: 'open', code: 'CS3103' }, { detailPushed: true })).toMatchObject({ op: 'replace', state: { open: 'CS3103' } });
    expect(transition(open, { type: 'open', code: 'CS2105' }, { detailPushed: true }).op).toBe('none');
  });

  it('close a detail: history.back() while on the entry this page pushed for it, else replace without open=', () => {
    expect(transition(open, { type: 'close' }, { detailPushed: true })).toMatchObject({ op: 'back', state: { open: '' } });
    // A shared link, a reload elsewhere, or a detail swapped in by replace after a filter change.
    expect(transition(open, { type: 'close' }, { detailPushed: false })).toMatchObject({ op: 'replace', state: { open: '' } });
    expect(transition(list, { type: 'close' }, { detailPushed: false }).op).toBe('none');
  });

  it('[F3 fixed] clear the query: push the URL without q (filters and the exchange set-up stay)', () => {
    const t = transition(parse('q=networks&ng=1&study=ug2&open=CS2105'), { type: 'submit', form: parse('ng=1&study=ug2') }, { detailPushed: false });
    expect(t.op).toBe('push');
    expect(stateToParams(t.state).toString()).toBe('ng=1&study=ug2');
    expect(transition(list, { type: 'submit', form: parse('q=%20') }, { detailPushed: false })).toMatchObject({ op: 'push', state: { q: '' } });
  });

  it('pick and alt (Phase 6) survive every transition', () => {
    const s = parse('q=x&pick=CS1010');
    for (const action of /** @type {const} */ ([{ type: 'submit', form: parse('q=y') }, { type: 'settings', form: parse('q=x&sem=1') }, { type: 'open', code: 'CS1010' }])) {
      expect(transition(s, action, { detailPushed: false }).state.pick).toEqual(['CS1010']);
    }
  });
});
