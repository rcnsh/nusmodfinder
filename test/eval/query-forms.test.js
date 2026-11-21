// @ts-check
import { describe, expect, it } from 'vitest';
import { queryTextForms } from '../../eval/lib/query-forms.mjs';
import { parseSearch } from '../../src/search.js';

describe('queryTextForms', () => {
  const texts = [
    'CS1010S', 'machine learning', '  Intro  to\tPython ', 'ÉLan Vital KELVIN', 'Korean langauge for beginners',
    'GEA', 'cs 1010s', 'Data   Science\nAND Ethics', 'xyz9999',
  ];

  it.each(texts)('covers the raw text and the text /search embeds: %j', (text) => {
    const forms = queryTextForms(text);
    const parsed = parseSearch(new URLSearchParams({ q: text }));
    expect(forms[0]).toBe(text);
    expect(forms).toContain(parsed.query?.q);
    expect(new Set(forms).size).toBe(forms.length);
  });
});
