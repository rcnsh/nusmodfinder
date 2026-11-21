// @ts-check
import bundleBytes from 'vectors-bundle';
import { exactSearch, parseBundle } from './vector-bundle.js';

/** @type {{ ok: true, value: import('./vector-bundle.js').Bundle } | { ok: false, error: Error } | null} */
let loaded = null;

export function denseBundle() {
  if (!loaded) {
    try {
      loaded = { ok: true, value: parseBundle(/** @type {ArrayBuffer} */ (bundleBytes)) };
    } catch (err) {
      loaded = { ok: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
  if (!loaded.ok) throw loaded.error;
  return loaded.value;
}

/**
 * @param {ArrayLike<number>} query
 * @param {import('./vector-bundle.js').FilterEcho} echo
 * @param {number} depth
 */
export const bundleSearch = (query, echo, depth) => exactSearch(denseBundle(), query, echo, depth);
