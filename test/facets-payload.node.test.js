// @ts-check
// scripts/lib.mjs facetsPayload: an ingest without the NG list must overwrite
// meta.ng_list, so /facets never shows an old list date next to a zero count.
import { describe, expect, it } from 'vitest';
import { facetsPayload } from '../scripts/lib.mjs';

describe('facetsPayload', () => {
  it('sends the NG list provenance when the list is present', () => {
    expect(facetsPayload({ available: true, updatedAsAt: '01 Sep 2026', source: 'NUS Registrar', total: 1207 }))
      .toEqual({ ngList: { updatedAsAt: '01 Sep 2026', source: 'NUS Registrar', count: 1207 } });
  });

  it('sends an explicit empty list when the NG file is absent', () => {
    expect(facetsPayload({ available: false, total: 0 }))
      .toEqual({ ngList: { updatedAsAt: null, source: null, count: 0 } });
  });
});
