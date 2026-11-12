// @ts-check
// public/state.js and public/nav.js: the
// page's state lives in the URL, parsed and written by one pure module, and
// every history transition is decided by one pure function. The browser half
// (pushState, popstate) is test/ui/history.spec.js.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IGNORABLE_INTENTS } from '../../src/query-intent.js';
import { emptyList, parseList } from '../../public/list.js';
import { searchAgain, searchKey, transition } from '../../public/nav.js';
import {
  CREDITS, IGNORABLE, LEVELS, MAX_QUERY_CHARS, SEMESTERS, STUDIES, emptyState, parseState, searchParams, shortlistUrl, stateToParams, urlFor,
} from '../../public/state.js';

const parse = (/** @type {string} */ qs) => parseState(new URLSearchParams(qs));
const round = (/** @type {string} */ qs) => stateToParams(parse(qs)).toString();

describe('URL state (F3, C-7)', () => {
  it('parses every field and writes them back in one canonical order', () => {
    const s = parse('alt=x&open=cs3244&study=ug2&ng=1&faculty=Computing&credits=4&level=3&sem=2&q=machine+learning');
    expect(s).toEqual({
      q: 'machine learning', sem: '2', level: '3', credits: '4', faculty: 'Computing', ng: true, study: 'ug2',
      ignore: [], open: 'CS3244', from: '', view: '',
    });
    // The list is not part of the state: stateToParams alone writes no pick or alt.
    expect(stateToParams(s).toString())
      .toBe('q=machine+learning&sem=2&level=3&credits=4&faculty=Computing&ng=1&study=ug2&open=CS3244');
  });

  it('from= is a course code kept only beside open= (and never open= itself)', () => {
    expect(round('q=ACC1701XB&open=acc1701xb&from=acc1701xa')).toBe('q=ACC1701XB&open=ACC1701XB&from=ACC1701XA');
    expect(round('q=ACC1701XB&from=ACC1701XA')).toBe('q=ACC1701XB');
    expect(round('q=ACC1701XB&open=ACC1701XB&from=ACC1701XB')).toBe('q=ACC1701XB&open=ACC1701XB');
    expect(round('q=ACC1701XB&open=ACC1701XB&from=%3Cb%3E')).toBe('q=ACC1701XB&open=ACC1701XB');
  });

  it('faculty= is a name, not a sentence: over 60 characters, or with hidden characters, it is dropped', () => {
    expect(round('q=x&faculty=College%20of%20Design%20and%20Engineering')).toBe('q=x&faculty=College+of+Design+and+Engineering');
    expect(round(`q=x&faculty=${encodeURIComponent('Verified by the NUS Registrar: all courses on this site are open to exchange students.')}`)).toBe('q=x');
    expect(round('q=x&faculty=Comp%E2%80%AEuting')).toBe('q=x');
    expect(round('q=x&faculty=Comp%00uting')).toBe('q=x');
  });

  it('an empty state is an empty query string, so the bare page URL', () => {
    expect(stateToParams(emptyState()).toString()).toBe('');
    expect(urlFor(emptyState(), emptyList(), '/')).toBe('/');
    expect(urlFor(parse('q=x'), emptyList(), '/')).toBe('/?q=x');
  });

  it('drops values /search would reject instead of failing the page', () => {
    expect(parse('sem=9&level=0&credits=-1&study=phd&open=<b>')).toMatchObject({ sem: '', level: '', credits: '', study: '', open: '' });
    expect(parse('sem=3&level=8&credits=12&study=grad&open=GEC1015A')).toMatchObject({ sem: '3', level: '8', credits: '12', study: '', open: 'GEC1015A' });
    // Every code shape /module/:code accepts (src/modules.js MODULE_CODE_RE), digits in the suffix included.
    for (const code of ['LC6009GRSII', 'DMA1401L01', 'DMR1201GEQA']) expect(parse(`open=${code.toLowerCase()}`).open, code).toBe(code);
    expect(parse('open=ABCDE1234').open).toBe('');
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

  it('the list is written after the search state, in rank order (test/web/list.node.test.js has the rest)', () => {
    const params = new URLSearchParams('q=x&pick=CS3244&pick=CS2040&alt=MA1521');
    expect(urlFor(parseState(params), parseList(params).list, '/')).toBe('/?q=x&pick=CS3244&pick=CS2040&alt=MA1521');
  });

  it('Copy link\'s URL: the list, ay once known, inv, ng, sem, study and view=shortlist; no q, filters or detail', () => {
    const params = new URLSearchParams('q=networks&sem=1&level=2&ng=1&study=ug2&open=CS2105&pick=CS2105.1&alt=GE2101.1&inv=biz');
    const { list } = parseList(params);
    expect(shortlistUrl(parseState(params), list, '/')).toBe('/?sem=1&ng=1&study=ug2&pick=CS2105.1&alt=GE2101.1&inv=biz&view=shortlist');
    expect(shortlistUrl(parseState(params), { ...list, ay: '2026-2027' }, '/'))
      .toBe('/?sem=1&ng=1&study=ug2&pick=CS2105.1&alt=GE2101.1&ay=2026-2027&inv=biz&view=shortlist');
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

  it('searchParams is the /search query: no open, pick, alt or view; null with no query or exchange mode without a study level', () => {
    expect(searchParams(parse('q=x&sem=1&ng=1&study=ug2&open=CS1010&pick=A&alt=B&ignore=exam&view=shortlist'))?.toString())
      .toBe('q=x&sem=1&ng=1&study=ug2&ignore=exam');
    expect(searchParams(parse('sem=1'))).toBeNull();
    expect(searchParams(parse('q=%20%20'))).toBeNull();
    expect(searchParams(parse('q=x&ng=1'))).toBeNull();
  });

  it('the semester, level, credits and study-level options are static: no filter waits on /facets', () => {
    expect(SEMESTERS.map((o) => o.value)).toEqual(['1', '2', '3', '4']);
    expect(LEVELS.map((o) => o.value)).toEqual(['1', '2', '3', '4', '5', '6', '8']);
    expect(CREDITS).toEqual(['2', '4', '5', '6', '8', '12']);
    expect(STUDIES.map((o) => o.value)).toEqual(['ug1', 'ug2', 'ug3', 'ug4', 'grad']);
  });
});

describe('history transitions', () => {
  const list = parse('q=networks&sem=1');
  const open = parse('q=networks&sem=1&open=CS2105');

  it('submit a query: push, and Back restores the previous query (its URL is the entry left behind)', () => {
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

  it('change a filter, exchange setting or remove a chip: replace, and drop open=', () => {
    for (const form of [parse('q=networks&sem=2'), parse('q=networks&sem=1&ng=1&study=ug2'), parse('q=networks&sem=1&ignore=exam')]) {
      const t = transition(open, { type: 'settings', form }, { detailPushed: true });
      expect(t.op).toBe('replace');
      expect(t.state.open).toBe('');
      expect(t.state.q).toBe('networks');
    }
  });

  it('a settings change while a different query is typed submits that query (push), so the results match the box', () => {
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

  it('clear the query: push the URL without q (filters and the exchange set-up stay)', () => {
    const t = transition(parse('q=networks&ng=1&study=ug2&open=CS2105'), { type: 'submit', form: parse('ng=1&study=ug2') }, { detailPushed: false });
    expect(t.op).toBe('push');
    expect(stateToParams(t.state).toString()).toBe('ng=1&study=ug2');
    expect(transition(list, { type: 'submit', form: parse('q=%20') }, { detailPushed: false })).toMatchObject({ op: 'push', state: { q: '' } });
  });

  it('an "Also as" link: push that code\'s search with its detail open and from=, keeping the settings', () => {
    const s = parse('q=introductory+accounting&sem=1&ng=1&study=ug2&ignore=exam&open=ACC1701XA');
    const t = transition(s, { type: 'variant', code: 'acc1701xb', from: 'ACC1701XA' }, { detailPushed: true });
    expect(t.op).toBe('push');
    expect(stateToParams(t.state).toString()).toBe('q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    // Already there: nothing to do.
    expect(transition(t.state, { type: 'variant', code: 'ACC1701XB', from: 'ACC1701XA' }, { detailPushed: false }).op).toBe('none');
  });

  it('from= belongs to the detail it opened: every other action that changes open= drops it', () => {
    const v = parse('q=ACC1701XB&sem=1&ng=1&study=ug2&open=ACC1701XB&from=ACC1701XA');
    expect(v.from).toBe('ACC1701XA');
    for (const action of /** @type {const} */ ([
      { type: 'submit', form: parse('q=ACC1701XB&sem=1&ng=1&study=ug2') }, { type: 'settings', form: parse('q=ACC1701XB&sem=2&ng=1&study=ug2') },
      { type: 'open', code: 'PLS8002A' }, { type: 'close' },
    ])) {
      expect(transition(v, action, { detailPushed: false }).state.from).toBe('');
    }
  });

  it('the list is not in a transition: it is page-wide, so every action keeps it by not touching it', () => {
    const s = parse('q=x&pick=CS1010');
    expect(Object.keys(s)).not.toContain('pick');
    for (const action of /** @type {const} */ ([{ type: 'submit', form: parse('q=y') }, { type: 'settings', form: parse('q=x&sem=1') }, { type: 'open', code: 'CS1010' }])) {
      expect(Object.keys(transition(s, action, { detailPushed: false }).state)).not.toContain('pick');
    }
  });

  it('settings while the view is shown keep the view and the submitted q (never the box\'s text); a submit closes it', () => {
    const view = parse('q=networks&sem=1&view=shortlist');
    const t = transition(view, { type: 'settings', form: { ...parse('q=networks&sem=2'), view: 'shortlist' } }, { detailPushed: false });
    expect(t).toMatchObject({ op: 'replace', state: { q: 'networks', sem: '2', view: 'shortlist' } });
    // The box holds unsubmitted text: still a settings change while the view is shown.
    const typed = transition(view, { type: 'settings', form: { ...parse('q=databases&sem=2'), view: 'shortlist' } }, { detailPushed: false });
    expect(typed).toMatchObject({ op: 'replace', state: { q: 'networks', sem: '2', view: 'shortlist' } });
    expect(transition(view, { type: 'submit', form: { ...parse('q=databases&sem=1'), view: 'shortlist' } }, { detailPushed: false }))
      .toMatchObject({ op: 'push', state: { q: 'databases', view: '' } });
    expect(transition(view, { type: 'variant', code: 'CS2030', from: '' }, { detailPushed: false }).state.view).toBe('');
  });
});

describe('the view\'s history', () => {
  const list = parse('q=networks&sem=1');
  it('open the view: push; from a detail this page pushed, replace that entry; from a detail by link, replace without it, then push', () => {
    expect(transition(list, { type: 'openView' }, { detailPushed: false })).toMatchObject({ op: 'push', state: { view: 'shortlist', open: '' } });
    expect(transition(parse('q=networks&open=CS2105'), { type: 'openView' }, { detailPushed: true })).toMatchObject({ op: 'replace', state: { view: 'shortlist', open: '' } });
    expect(transition(parse('q=networks&open=CS2105'), { type: 'openView' }, { detailPushed: false })).toMatchObject({ op: 'replace-push', state: { open: '' } });
    // The shortlist button with the view shown: no history write.
    expect(transition(parse('q=networks&view=shortlist'), { type: 'openView' }, { detailPushed: false }).op).toBe('none');
  });
  it('close the view: back() if this page pushed it and q and filters are as it opened, else replace without view', () => {
    const view = parse('q=networks&sem=1&view=shortlist');
    const atOpen = searchKey(list);
    expect(atOpen).toBe('q=networks&sem=1');
    expect(transition(view, { type: 'closeView', viewPushed: true, atOpen }, { detailPushed: false })).toMatchObject({ op: 'back', state: { view: '' } });
    expect(transition(view, { type: 'closeView', viewPushed: false, atOpen }, { detailPushed: false }).op).toBe('replace');
    expect(transition(parse('q=networks&sem=2&view=shortlist'), { type: 'closeView', viewPushed: true, atOpen }, { detailPushed: false }))
      .toMatchObject({ op: 'replace', state: { sem: '2', view: '' } });
  });
});

describe('popstate: search again only when the search changed, or after a network or server error (never after a 429)', () => {
  const a = parse('q=networks&sem=1');
  const b = parse('q=databases&sem=1');
  it('a changed search runs', () => {
    expect(searchAgain(a, b, null)).toBe(true);
    expect(searchAgain(a, b, 'rate')).toBe(true);
  });
  it('the same search runs again only after a network or server error', () => {
    expect(searchAgain(a, parse('q=networks&sem=1&open=CS2105'), null)).toBe(false);
    expect(searchAgain(a, parse('q=networks&sem=1&view=shortlist'), 'retry')).toBe(true);
    expect(searchAgain(a, parse('q=networks&sem=1&view=shortlist'), 'rate')).toBe(false);
    expect(searchAgain(a, a, 'other')).toBe(false);
  });
});
