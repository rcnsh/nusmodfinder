// @ts-check
// The bundled corpus vectors (Phase 3, 3-0). `vectors-bundle` is a wrangler
// `alias` (wrangler.jsonc; resolve.alias in the Vitest configs) to a small
// module that re-exports a `.bin` Data module: by default the committed
// fixture (test/fixtures/vectors.js), and for a deploy the production bundle
// (scripts/deploy.mjs passes --alias). Parsed once per isolate, on the first
// dense search, so isolate startup never pays for it.
import bundleBytes from 'vectors-bundle';
import { exactSearch, parseBundle } from './vector-bundle.js';

/** @type {{ ok: true, value: import('./vector-bundle.js').Bundle } | { ok: false, error: Error } | null} */
let loaded = null;

/**
 * The parsed bundle. A bundle that does not parse throws, every time, with
 * the same error: /search then answers keyword-only (B6), `degraded.source`
 * "dense-index".
 */
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
 * The top `depth` corpus codes by exact cosine with `query`, after the filter
 * mask, with their scores.
 * @param {ArrayLike<number>} query
 * @param {import('./vector-bundle.js').FilterEcho} echo
 * @param {number} depth
 */
export const bundleSearch = (query, echo, depth) => exactSearch(denseBundle(), query, echo, depth);
