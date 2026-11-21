// @ts-check
import { searchParams, stateToParams } from './state.js';

/** @typedef {import('./state.js').State} State */
/**
 * @typedef {{ type: 'submit', form: State } | { type: 'settings', form: State }
 *   | { type: 'open', code: string } | { type: 'close' }
 *   | { type: 'variant', code: string, from: string }
 *   | { type: 'openView' } | { type: 'closeView', viewPushed: boolean, atOpen: string }} Action
 */
/** @typedef {'push' | 'replace' | 'back' | 'none' | 'replace-push'} Op */

/** @param {State} a @param {State} b */
const sameUrl = (a, b) => stateToParams(a).toString() === stateToParams(b).toString();

/** @param {State} s */
export const searchKey = (s) => stateToParams({ ...s, open: '', from: '', view: '' }).toString();

/**
 * @param {State} before
 * @param {State} arrived
 * @param {'retry' | 'rate' | 'other' | null} lastError
 */
export function searchAgain(before, arrived, lastError) {
  const key = (/** @type {State} */ s) => searchParams(s)?.toString() ?? '';
  if (key(before) !== key(arrived)) return true;
  return lastError === 'retry';
}

/**
 * @param {State} current
 * @param {Action} action
 * @param {{ detailPushed: boolean }} entry
 * @returns {{ state: State, op: Op }}
 */
export function transition(current, action, { detailPushed }) {
  switch (action.type) {
    case 'submit': {
      const q = action.form.q.trim() ? action.form.q : '';
      const ignore = q.trim() === current.q.trim() ? action.form.ignore : [];
      const state = { ...action.form, q, ignore, open: '', from: '', view: /** @type {''} */ ('') };
      return { state, op: sameUrl(state, current) ? 'replace' : 'push' };
    }
    case 'settings': {
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
      const code = action.code.trim().toUpperCase();
      const from = action.from.trim().toUpperCase();
      const state = { ...current, q: code, ignore: [], open: code, from: from !== code ? from : '', view: /** @type {''} */ ('') };
      return { state, op: sameUrl(state, current) ? 'none' : 'push' };
    }
  }
}
