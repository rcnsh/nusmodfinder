// @ts-check
// The eval embeds every form of a query text a ranker may send to Workers AI
// (eval/lib/embeddings.mjs queryTextForms). Runs in workerd, beside the
// Worker itself, so the forms are checked against the text /search actually
// sends to Workers AI (PR #6 review round 4: a missing canonical vector opened
// the dense breaker mid-run and hid the next misses).
import { beforeAll, describe, expect, it } from 'vitest';
import { queryTextForms } from '../../eval/lib/query-forms.mjs';
import { QUERY_INSTRUCTION } from '../../src/embedding.js';
import { parseSearch } from '../../src/search.js';
import { callJson, seed } from '../helpers.js';

/** @type {import('../fakes.js').Fakes} */
let fakes;
beforeAll(async () => {
  fakes = await seed();
});

describe('queryTextForms', () => {
  const texts = [
    'CS1010S', 'machine learning', '  Intro  to\tPython ', 'ÉLan Vital KELVIN', 'Korean langauge for beginners',
    'GEA', 'cs 1010s', 'Data   Science\nAND Ethics', 'xyz9999',
  ];

  it.each(texts)('without an instruction: the raw text and the canonical query (rankers before 3A-1): %j', (text) => {
    const forms = queryTextForms(text);
    const parsed = parseSearch(new URLSearchParams({ q: text }));
    expect(forms[0]).toBe(text);
    expect(forms).toContain(parsed.query?.q);
    expect(new Set(forms).size).toBe(forms.length);
  });

  it.each(texts)('with the ranker\'s instruction: also exactly the text /search sends to Workers AI: %j', async (text) => {
    const forms = queryTextForms(text, QUERY_INSTRUCTION);
    fakes.ai.calls.length = 0;
    const { status } = await callJson(`/search?q=${encodeURIComponent(text)}&mode=vector`, { fakes });
    expect(status).toBe(200);
    expect(fakes.ai.calls).toHaveLength(1);
    const sent = /** @type {{ text: string[] }} */ (fakes.ai.calls[0].args[1]).text;
    expect(sent).toHaveLength(1);
    expect(forms).toContain(sent[0]);
    // The earlier forms are kept, so baselines from before 3A-1 still run.
    expect(forms.slice(0, -1)).toEqual(queryTextForms(text));
    expect(forms.at(-1)).toBe(`${QUERY_INSTRUCTION}${parseSearch(new URLSearchParams({ q: text })).query?.q}`);
    expect(new Set(forms).size).toBe(forms.length);
  });
});
