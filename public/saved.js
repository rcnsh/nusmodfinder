// @ts-check
// The shortlist on this device (Phase 6 6B, G3: Jacob, 2026-11-11). The last
// list this student edited is kept in localStorage, as the URL would write it;
// the page offers it ("Restore your last shortlist") when a link has no list,
// and "Forget this list on this device" clears it. The page saves only on its
// own edits, so opening someone else's link never overwrites it. Storage may
// be missing or throw (private mode, blocked): then there is no copy, never an
// error. No DOM: test/web/saved.node.test.js passes a stand-in.
import { entryCount, listPairs, parseList } from './list.js';

export const SAVED_KEY = 'vnm.shortlist';

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} StorageLike */
/** @typedef {import('./list.js').List} List */

/**
 * Keeps `list` as the device's copy; an empty list clears it.
 * @param {StorageLike | null | undefined} storage
 * @param {List} list
 */
export function saveList(storage, list) {
  try {
    if (!entryCount(list)) storage?.removeItem(SAVED_KEY);
    else storage?.setItem(SAVED_KEY, new URLSearchParams(listPairs(list)).toString());
  } catch { /* no storage: no copy */ }
}

/**
 * The device's copy, read by the same parser as a link, or null.
 * @param {StorageLike | null | undefined} storage
 * @returns {List | null}
 */
export function loadList(storage) {
  try {
    const raw = storage?.getItem(SAVED_KEY);
    if (!raw) return null;
    const { list } = parseList(new URLSearchParams(raw));
    return entryCount(list) ? list : null;
  } catch {
    return null;
  }
}

/**
 * The copy to offer: only when the link's list has no entries.
 * @param {List} linkList
 * @param {StorageLike | null | undefined} storage
 */
export function restoreOffer(linkList, storage) {
  return entryCount(linkList) ? null : loadList(storage);
}

/** "Forget this list on this device": the copy only, never the URL's list. @param {StorageLike | null | undefined} storage */
export function forgetList(storage) {
  try { storage?.removeItem(SAVED_KEY); } catch { /* no storage */ }
}
