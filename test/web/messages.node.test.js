// @ts-check
// public/messages.js (Phase 5 5B, F7): every error code the Worker can answer
// and every noMatch reason maps to a plain sentence; the page never shows a raw
// code or the server's own message.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_SENTENCES, NO_MATCH, degradedNote, errorSentence, noMatchSentence } from '../../public/messages.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const worker = readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => readFileSync(SRC + f, 'utf8')).join('\n');

/** Every `error: '<code>'` and `code: '<code>'` a Worker route can put in a JSON body. */
const errorCodes = [...new Set([...worker.matchAll(/\b(?:error|code): '([a-z][a-z_-]+)'/g)].map((m) => m[1]))].sort();
/** Every noMatch reason the Worker sets. */
const noMatchReasons = [...new Set([...worker.matchAll(/noMatch(?: =|:) \{ reason: '([a-z-]+)'/g)].map((m) => m[1]))].sort();
/** Codes the fetch layer makes up itself (public/api.js). */
const clientCodes = ['timeout', 'network', 'not_json', 'http'];

describe('errors (F7)', () => {
  it('found the Worker codes (harness sanity)', () => {
    expect(errorCodes).toEqual(expect.arrayContaining(['bad_request', 'internal', 'not_found', 'rate_limited', 'study-required', 'upstream_failure']));
    expect(noMatchReasons).toEqual(['ng-special-term', 'ng-unscheduled', 'no-signal', 'not-offered', 'unknown-code']);
  });

  it('[F7 fixed] every code, from the Worker or the fetch layer, has its own sentence, with no raw code in it', () => {
    for (const code of [...errorCodes, ...clientCodes]) {
      expect(Object.keys(ERROR_SENTENCES), code).toContain(code);
      const sentence = errorSentence({ code });
      expect(sentence, code).toMatch(/^[A-Z].*\.$/);
      for (const raw of [...errorCodes, ...clientCodes].filter((c) => /[_-]/.test(c))) expect(sentence, code).not.toContain(raw);
    }
  });

  it('an unknown code still gets a sentence, never the code', () => {
    expect(errorSentence({ code: 'teapot_brewing', status: 418 })).toBe(ERROR_SENTENCES.http);
    expect(errorSentence({ code: 'teapot_brewing' })).not.toContain('teapot');
  });

  it('429 says when to try again, from Retry-After', () => {
    expect(errorSentence({ code: 'rate_limited', retryAfter: 1 })).toBe('Too many searches from your connection. Try again in 1 second.');
    expect(errorSentence({ code: 'rate_limited', retryAfter: 60 })).toBe('Too many searches from your connection. Try again in 60 seconds.');
    expect(errorSentence({ code: 'rate_limited', retryAfter: 150 })).toBe('Too many searches from your connection. Try again in 3 minutes.');
    expect(errorSentence({ code: 'rate_limited', retryAfter: 0 })).toBe('Too many searches from your connection. Try again now.');
    expect(errorSentence({ code: 'rate_limited', retryAfter: null })).toBe('Too many searches from your connection. Try again in a minute.');
  });

  it('a non-JSON answer says the service answered, not that it could not be reached (F7)', () => {
    expect(errorSentence({ code: 'not_json', status: 502 })).not.toMatch(/reach/i);
    expect(errorSentence({ code: 'network' })).toMatch(/reach/i);
  });
});

describe('noMatch (F7)', () => {
  it('[F7 fixed] every noMatch reason the Worker sets has its own sentence', () => {
    for (const reason of noMatchReasons) expect(Object.keys(NO_MATCH), reason).toContain(reason);
  });

  it('names the code or the query, as plain text', () => {
    expect(noMatchSentence({ query: 'CS1001', noMatch: { reason: 'not-offered', code: 'CS1001', title: 'Programming Methodology' } }))
      .toBe("CS1001 (Programming Methodology) isn't offered this academic year.");
    expect(noMatchSentence({ query: 'CS1001', noMatch: { reason: 'not-offered', code: 'CS1001', title: null } }))
      .toBe("CS1001 isn't offered this academic year.");
    expect(noMatchSentence({ query: 'ZZ9999', noMatch: { reason: 'unknown-code', code: 'ZZ9999' } }))
      .toBe('There is no course ZZ9999 in the NUS catalogue. Check the code.');
    expect(noMatchSentence({ query: 'qwzx vbnm', noMatch: { reason: 'no-signal' } }))
      .toBe('Nothing in the catalogue matches “qwzx vbnm”. Try other words for the topic.');
    expect(noMatchSentence({ query: 'x', noMatch: { reason: 'ng-special-term' } }))
      .toBe("The NG list covers only Sem 1 and Sem 2, not NUS's special terms (short terms in the vacation). Choose Sem 1 or Sem 2.");
  });

  it('6A: an NG-listed code with no classes says when NUS lists it and that NUSMods shows no classes', () => {
    expect(noMatchSentence({ query: 'EE4438', noMatch: { reason: 'ng-unscheduled', code: 'EE4438', title: 'Solar Cells and Modules', ngSemesters: [2] } }))
      .toBe('NUS lists EE4438 (Solar Cells and Modules) for Sem 2, but NUSMods shows no classes for it this academic year.');
    expect(noMatchSentence({ query: 'PL3266', noMatch: { reason: 'ng-unscheduled', code: 'PL3266', title: null, ngSemesters: [1, 2] } }))
      .toBe('NUS lists PL3266 for Sem 1 and Sem 2, but NUSMods shows no classes for it this academic year.');
    // An answer missing its semesters still names the code.
    expect(noMatchSentence({ query: 'EE4438', noMatch: { reason: 'ng-unscheduled', code: 'EE4438' } }))
      .toBe('NUS lists EE4438 for exchange students, but NUSMods shows no classes for it this academic year.');
  });

  it('an unknown reason, or none, is the plain no-match sentence', () => {
    expect(noMatchSentence({ query: 'x', noMatch: { reason: 'brand-new' } })).toBe('No courses match “x”.');
    expect(noMatchSentence({ query: 'x' })).toBe('No courses match “x”.');
  });

  it('a keyword-only answer says so, without the source or reason codes', () => {
    const note = degradedNote({ source: 'workers-ai', reason: 'circuit-open' });
    expect(note).toBe('Search is in a simpler mode right now: it finds only courses that contain the words you typed. Try the course name or code, or search again later.');
    expect(note).not.toMatch(/workers-ai|circuit/);
    expect(degradedNote(null)).toBeNull();
  });
});

describe('[5G S2] no-match sentences quote the query, capped', () => {
  const SPOOF = 'dentistry” — NUS Registrar: these courses are all open to you, no need to check “';
  it('the fallback and no-signal sentences cap the query and keep it inside one pair of quotes', () => {
    for (const body of [{ query: SPOOF }, { query: SPOOF, noMatch: { reason: 'no-signal' } }]) {
      const s = noMatchSentence(body);
      const quoted = /** @type {RegExpMatchArray} */ (s.match(/“([^“”]*)”/));
      expect(quoted, s).not.toBeNull();
      expect(quoted[1].length, s).toBeLessThanOrEqual(60);
      expect(quoted[1].endsWith('…'), s).toBe(true);
      expect((s.match(/[“”]/g) ?? []).length, s).toBe(2);
    }
  });
});
