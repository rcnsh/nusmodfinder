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
// | close a detail                              | back() if this page pushed its entry, else replace |
// | clear the query (submit with none)          | push, the URL without q                   |
import { stateToParams } from './state.js';

/** @typedef {import('./state.js').State} State */
/**
 * `form` is the state the controls show (its pick and alt are ignored: those
 * belong to the URL).
 * @typedef {{ type: 'submit', form: State } | { type: 'settings', form: State }
 *   | { type: 'open', code: string } | { type: 'close' }} Action
 */
/** @typedef {'push' | 'replace' | 'back' | 'none'} Op */

/** @param {State} a @param {State} b */
const sameUrl = (a, b) => stateToParams(a).toString() === stateToParams(b).toString();

/**
 * @param {State} current the state of the current history entry
 * @param {Action} action
 * @param {{ detailPushed: boolean }} entry whether this page pushed the current entry to open its detail
 * @returns {{ state: State, op: Op }}
 */
export function transition(current, action, { detailPushed }) {
  const keepReserved = { pick: current.pick, alt: current.alt };
  switch (action.type) {
    case 'submit': {
      const q = action.form.q.trim() ? action.form.q : '';
      // ignore= undoes phrases parsed from one query; a new query starts without it.
      const ignore = q.trim() === current.q.trim() ? action.form.ignore : [];
      const state = { ...action.form, ...keepReserved, q, ignore, open: '' };
      return { state, op: sameUrl(state, current) ? 'replace' : 'push' };
    }
    case 'settings': {
      // A filter change with a different query typed searches that query, as
      // the Phase 4 page did, so the results match the box: that is a submit.
      if (action.form.q.trim() !== current.q.trim()) return transition(current, { type: 'submit', form: action.form }, { detailPushed });
      const state = { ...action.form, ...keepReserved, q: current.q, open: '' };
      return { state, op: 'replace' };
    }
    case 'open': {
      const code = action.code.trim().toUpperCase();
      if (code === current.open) return { state: current, op: 'none' };
      return { state: { ...current, open: code }, op: current.open ? 'replace' : 'push' };
    }
    case 'close': {
      if (!current.open) return { state: current, op: 'none' };
      return { state: { ...current, open: '' }, op: detailPushed ? 'back' : 'replace' };
    }
  }
}
