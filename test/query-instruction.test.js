// @ts-check
// Phase 3 3A-1: bge-small-en-v1.5's retrieval instruction goes in front of the
// query text, and only the query text. The corpus side (ingest), the lexical
// half, the pin, the response's `query` and the cache key keep the canonical
// query exactly as before.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, QUERY_INSTRUCTION } from '../src/embedding.js';
import { searchCacheKey } from '../src/search.js';
import { createFakes } from './fakes.js';
import { BASE, adminCall, callJson, fixture, seed } from './helpers.js';

const INSTRUCTION = 'Represent this sentence for searching relevant passages: ';

describe('3A-1 query instruction prefix', () => {
  it('is bge\'s retrieval instruction, exactly', () => {
    expect(QUERY_INSTRUCTION).toBe(INSTRUCTION);
  });

  it.each([
    ['vector', {}],
    ['hybrid', {}],
    ['vector', { DENSE_BACKEND: 'vectorize' }],
    ['hybrid', { DENSE_BACKEND: 'vectorize' }],
  ])('sends Workers AI the instruction + the canonical query, once (mode %s, env %j)', async (mode, extra) => {
    const fakes = await seed();
    const raw = '  Machine \t LEARNING  for   CS1010S ';
    const { status, body } = await callJson(`/search?q=${encodeURIComponent(raw)}&mode=${mode}`, { fakes, env: extra });
    expect(status).toBe(200);
    expect(fakes.ai.calls).toEqual([{
      method: 'run',
      args: [DEFAULT_MODEL, { text: ['Represent this sentence for searching relevant passages: machine learning for cs1010s'] }],
    }]);
    // The response echoes the canonical query, without the instruction.
    expect(body.query).toBe('machine learning for cs1010s');
  });

  it('a lexical-mode search calls no model', async () => {
    const fakes = await seed();
    const { status } = await callJson('/search?q=machine%20learning&mode=lexical', { fakes });
    expect(status).toBe(200);
    expect(fakes.ai.calls).toEqual([]);
  });

  it('the pin and the cache key read the canonical query, not the instruction', async () => {
    const fakes = await seed();
    const { body } = await callJson('/search?q=CS1010S', { fakes });
    expect(body.results[0].code).toBe('CS1010S');
    expect(fakes.ai.calls[0].args[1]).toEqual({ text: [`${INSTRUCTION}cs1010s`] });
    const key = /** @type {Request} */ (searchCacheKey(`${BASE}/search?q=CS1010S`));
    expect(new URL(key.url).searchParams.get('q')).toBe('cs1010s');
  });

  it('ingest embeds each module\'s text with no instruction (corpus vectors are unchanged)', async () => {
    const fakes = createFakes();
    await seed({ fakes, modules: [] });
    const modules = fixture.modules.slice(0, 5);
    const res = await adminCall('/admin/ingest', fakes, { modules });
    expect(res.status).toBe(200);
    const texts = fakes.ai.calls.flatMap((c) => /** @type {{ text: string[] }} */ (c.args[1]).text);
    expect(texts).toEqual(modules.map((m) => m.text));
  });
});
