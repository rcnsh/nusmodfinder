// @ts-check
// Phase 3 3-0: a bundle that does not parse (missing, truncated, the wrong
// schema) never fails a search. Hybrid answers keyword-only, flagged
// degraded with source "dense-index" (B6); mode=vector is a 502 naming it.
import { describe, expect, it, vi } from 'vitest';
import * as dense from '../src/dense.js';
import { parseBundle } from '../src/vector-bundle.js';
import { callJson, seed } from './helpers.js';

// What src/dense.js throws for a bundle that does not parse (test/vector-bundle.node.test.js
// covers parseBundle on each kind of damage).
const corrupt = () => {
  parseBundle(/** @type {ArrayBuffer} */ (new TextEncoder().encode('VNMVEC01 but truncated').buffer));
  return [];
};

describe('3-0 with a corrupt bundle', () => {
  it('hybrid answers keyword-only with degraded.source dense-index; vector mode is a 502; Vectorize is never asked', async () => {
    const fakes = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const search = vi.spyOn(dense, 'bundleSearch').mockImplementation(() => corrupt());
    try {
      const hybrid = await callJson('/search?q=programming%20methodology', { fakes });
      expect(hybrid.status).toBe(200);
      expect(hybrid.body.degraded).toEqual({ source: 'dense-index', reason: 'error' });
      expect(hybrid.headers.get('server-timing')).toContain('degraded;desc=dense-index-error');
      const lexical = await callJson('/search?q=programming%20methodology&mode=lexical', { fakes });
      expect(hybrid.body.results.map((/** @type {any} */ r) => r.code)).toEqual(lexical.body.results.map((/** @type {any} */ r) => r.code));

      const vector = await callJson('/search?q=programming%20methodology&mode=vector', { fakes });
      expect(vector.status).toBe(502);
      expect(vector.body).toMatchObject({ error: 'upstream_failure', source: 'dense-index' });
      expect(vector.body.message).toMatch(/vectors bundle/);
      expect(fakes.vectorize.calls).toEqual([]);

      // The standby still answers under the flip.
      const flipped = await callJson('/search?q=programming%20methodology&mode=vector', { fakes, env: { DENSE_BACKEND: 'vectorize' } });
      expect(flipped.status).toBe(200);
      expect(flipped.body.retrieval.vector).toBeGreaterThan(0);
      expect(search).toHaveBeenCalled();
    } finally { warn.mockRestore(); search.mockRestore(); }
  });
});
