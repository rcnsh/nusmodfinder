// @ts-check
import { entryCount, listPairs, parseList } from './list.js';

export const SAVED_KEY = 'vnm.shortlist';

/** @typedef {Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>} StorageLike */
/** @typedef {import('./list.js').List} List */

/**
 * @param {StorageLike | null | undefined} storage
 * @param {List} list
 */
export function saveList(storage, list) {
  try {
    if (!entryCount(list)) storage?.removeItem(SAVED_KEY);
    else storage?.setItem(SAVED_KEY, new URLSearchParams(listPairs(list)).toString());
  } catch {}
}

/**
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
 * @param {List} linkList
 * @param {StorageLike | null | undefined} storage
 */
export function restoreOffer(linkList, storage) {
  return entryCount(linkList) ? null : loadList(storage);
}

/** @param {StorageLike | null | undefined} storage */
export function forgetList(storage) {
  try { storage?.removeItem(SAVED_KEY); } catch {}
}
