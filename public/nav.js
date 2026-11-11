// @ts-check
// History transitions (Phase 5 5B, F3, A2-4, A3-3): what each user action does
// to the state and to the history stack, as one pure function. app.js applies
// the op (pushState, replaceState or history.back()); popstate then restores
// whatever state the entry's URL holds.
//
// | action                                      | history                                   |
// |---------------------------------------------|-------------------------------------------|
// | submit a query                              | push (replace if the URL would not change) |
// | change a filter, exchange setting, or chip  | replace; drops open=                      |
// |   ... with a different query typed          | as submit: push                           |
// | open a detail with none open                | push                                      |
// | open another detail while one is open       | replace                                   |
// | follow an "Also as" link (5G)               | push: that code's search, its detail open, from= |
// | close a detail                              | back() if this page pushed its entry, else replace |
// | clear the query (submit with none)          | push, the URL without q                   |
//
// `from` belongs to the detail an "Also as" link opened: every other action
// that changes `open` drops it.
//
// Phase 6 (6B): the shortlist is not part of the state, so no transition
// touches it; app.js writes the page's list into every URL. `view=shortlist`:
//
// | action                                      | history                                   |
// |---------------------------------------------|-------------------------------------------|
// | open the view                               | replace a detail entry this page pushed (closing goes back()); else replace without open, then push; else push |
// | the shortlist button with the view shown    | none                                      |
// | settings while the view is shown            | replace; view and the submitted q kept (never the box's text) |
// | submit or a code link from the view         | push; the view closed                     |
// | close the view                              | back() if this page pushed it and q and filters are as it opened; else replace without view |
import { searchParams, stateToParams } from './state.js';

/** @typedef {import('./state.js').State} State */
/**
 * `form` is the state the controls show.
 * @typedef {{ type: 'submit', form: State } | { type: 'settings', form: State }
 *   | { type: 'open', code: string } | { type: 'close' }
 *   | { type: 'variant', code: string, from: string }
 *   | { type: 'openView' } | { type: 'closeView', viewPushed: boolean, atOpen: string }} Action
 *   `variant`: an "Also as" link, from the entry `from`, to its other code `code`.
 *   `closeView`: whether this page pushed the view's entry, and searchKey() of the state it opened from.
 */
/**
 * `replace-push`: replace the current entry with the state less its detail, then push the state.
 * @typedef {'push' | 'replace' | 'back' | 'none' | 'replace-push'} Op
 */

/** @param {State} a @param {State} b */
const sameUrl = (a, b) => stateToParams(a).toString() === stateToParams(b).toString();

/**
 * The search a state shows, q and filters, without its detail or view: what
 * the view's entry records as `atOpen`.
 * @param {State} s
 */
export const searchKey = (s) => stateToParams({ ...s, open: '', from: '', view: '' }).toString();

/**
 * Whether Back or Forward must search (6B): when the search differs from the
 * one before the event; when it is the same, only if the last answer was a
 * network or server error, never after a 429.
 * @param {State} before the state before the event
 * @param {State} arrived the entry's state
 * @param {'retry' | 'rate' | 'other' | null} lastError the last search's error kind (null when it answered)
 */
export function searchAgain(before, arrived, lastError) {
  const key = (/** @type {State} */ s) => searchParams(s)?.toString() ?? '';
  if (key(before) !== key(arrived)) return true;
  return lastError === 'retry';
}

/**
 * @param {State} current the state of the current history entry
 * @param {Action} action
 * @param {{ detailPushed: boolean }} entry whether this page pushed the current entry to open its detail
 * @returns {{ state: State, op: Op }}
 */
export function transition(current, action, { detailPushed }) {
  switch (action.type) {
    case 'submit': {
      const q = action.form.q.trim() ? action.form.q : '';
      // ignore= undoes phrases parsed from one query; a new query starts without it.
      const ignore = q.trim() === current.q.trim() ? action.form.ignore : [];
      // A submit from the view closes it (6B).
      const state = { ...action.form, q, ignore, open: '', from: '', view: /** @type {''} */ ('') };
      return { state, op: sameUrl(state, current) ? 'replace' : 'push' };
    }
    case 'settings': {
      // A filter change with a different query typed searches that query, as
      // the Phase 4 page did, so the results match the box: that is a submit.
      // Not while the view is shown (6B): the search keeps the submitted q.
      if (!current.view && action.form.q.trim() !== current.q.trim()) return transition(current, { type: 'submit', form: action.form }, { detailPushed });
      const state = { ...action.form, q: current.q, open: '', from: '', view: current.view };
      return { state, op: 'replace' };
    }
    case 'open': {
      const code = action.code.trim().toUpperCase();
      if (code === current.open) return { state: current, op: 'none' };
      return { state: { ...current, open: code, from: '', view: '' }, op: current.open ? 'replace' : 'push' };
    }
    case 'openView': {
      if (current.view) return { state: current, op: 'none' };
      const state = { ...current, open: '', from: '', view: /** @type {'shortlist'} */ ('shortlist') };
      return { state, op: detailPushed ? 'replace' : current.open ? 'replace-push' : 'push' };
    }
    case 'closeView': {
      if (!current.view) return { state: current, op: 'none' };
      const state = { ...current, view: /** @type {''} */ ('') };
      return { state, op: action.viewPushed && searchKey(current) === action.atOpen ? 'back' : 'replace' };
    }
    case 'close': {
      if (!current.open) return { state: current, op: 'none' };
      return { state: { ...current, open: '', from: '' }, op: detailPushed ? 'back' : 'replace' };
    }
    case 'variant': {
      // A search for the other code, with its detail open, said to come from the entry:
      // the settings stay, phrases undone for the old query don't.
      const code = action.code.trim().toUpperCase();
      const from = action.from.trim().toUpperCase();
      const state = { ...current, q: code, ignore: [], open: code, from: from !== code ? from : '', view: /** @type {''} */ ('') };
      return { state, op: sameUrl(state, current) ? 'none' : 'push' };
    }
  }
}
