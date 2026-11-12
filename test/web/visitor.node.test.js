// @ts-check
// Phase 8 8B (docs/plans/phase8.md §2 "8B", as §5's answers adjust it): what a visitor sees, read
// from the files. /favicon.ico as a static file, the share preview's site name, the no-JavaScript
// sentence, the footer's restrictions and privacy links, no contact (G6 (d)), the privacy note
// (G3 (a)), the year line's wording, the 403's sentence, and the two rate limits (G5 (b)).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ERROR_SENTENCES, errorSentence } from '../../public/messages.js';
import { DEFAULT_ACAD_YEAR, yearLine } from '../../public/year.js';
import { parseJsonc } from '../../scripts/jsonc.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** A file's text, '' while it doesn't exist (so each test, not the file, fails first). @param {string} rel */
const read = (rel) => (existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), 'utf8') : '');
const page = read('public/index.html');

/** 'YYYY-YYYY' → 'YYYY/YY'. @param {string} ay */
const label = (ay) => `${ay.slice(0, 4)}/${ay.slice(7, 9)}`;
/** The acad year after `ay`. @param {string} ay */
const next = (ay) => `${Number(ay.slice(0, 4)) + 1}-${Number(ay.slice(5, 9)) + 1}`;

describe('/favicon.ico (8B)', () => {
  it('is a static file in public/, so a browser\'s request for it never runs the Worker', () => {
    expect(existsSync(join(ROOT, 'public/favicon.ico'))).toBe(true);
    const ico = readFileSync(join(ROOT, 'public/favicon.ico'));
    // ICONDIR: reserved 0, type 1 (icon), at least one image.
    expect([...ico.subarray(0, 4)]).toEqual([0, 0, 1, 0]);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    // The first image is a 32×32 PNG, the same picture as favicon-32.png.
    expect([ico[6], ico[7]]).toEqual([32, 32]);
    const offset = ico.readUInt32LE(18);
    const size = ico.readUInt32LE(14);
    expect(ico.subarray(offset, offset + size).equals(readFileSync(join(ROOT, 'public/favicon-32.png')))).toBe(true);
  });
});

describe('the page\'s head and footer (8B)', () => {
  it('names the site "NUS Mod Finder (unofficial)" in the share preview too', () => {
    expect(page).toContain('<meta property="og:site_name" content="NUS Mod Finder (unofficial)">');
  });

  it('says in one sentence, without JavaScript, that the site needs it', () => {
    const blocks = [...page.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map((m) => m[1]);
    expect(blocks).toHaveLength(1);
    const text = blocks[0].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    expect(text).toMatch(/JavaScript/);
    expect(text.split(/(?<=[.!?])\s+/)).toHaveLength(1);
  });

  it('links the restrictions document at its own address, from the year\'s source manifest', () => {
    const manifest = JSON.parse(read(`data/ng-sources-${DEFAULT_ACAD_YEAR}.json`));
    const docs = manifest.revisions.at(-1).documents;
    const restrictions = docs.find((/** @type {{ id: string }} */ d) => d.id === 'restrictions');
    expect(restrictions.url).toMatch(/\.pdf$/);
    const link = /<a href="([^"]+)"[^>]*>Course restrictions for exchange \(NG\) students<\/a>/.exec(page);
    expect(link?.[1]).toBe(restrictions.url);
  });

  it('links the privacy note from the footer', () => {
    const footer = /<footer[\s\S]*?<\/footer>/.exec(page)?.[0] ?? '';
    expect(footer).toMatch(/<a href="\/privacy">Privacy<\/a>/);
  });

  it('G6 (d): names no contact and offers no issue form', () => {
    for (const f of ['public/index.html', 'public/privacy.html', 'src/404.html']) {
      const text = read(f);
      expect(text, f).not.toBe('');
      expect(text, f).not.toMatch(/mailto:|issues\/new|github\.com/i);
    }
    expect(existsSync(join(ROOT, '.github/ISSUE_TEMPLATE'))).toBe(false);
  });
});

describe('the privacy note (8B, G3 (a))', () => {
  const html = read('public/privacy.html');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&rsquo;|&#39;/g, '\'').replace(/\s+/g, ' ');

  it('is a page of its own, named and marked unofficial, linking home', () => {
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('<title>Privacy · NUS Mod Finder (unofficial)</title>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toMatch(/<a [^>]*href="\/"/);
    // The page's CSP allows no inline script; the note needs none.
    expect(html).not.toMatch(/<script/);
  });

  it('says who runs the site, as the footer does, and names no contact', () => {
    expect(text).toContain('An unofficial site, not run by NUS or NUSMods.');
  });

  it('states what Workers Logs keep, and for how long on Workers Paid today', () => {
    expect(text).toMatch(/Workers Logs/);
    expect(text).toMatch(/7 days/);
    expect(text).toMatch(/address you requested, including what you searched for/);
    expect(text).toMatch(/headers/);
    expect(text).toMatch(/IP address/);
  });

  it('states the site\'s own search line: the text cut to 100 characters, with timings', () => {
    expect(text).toMatch(/first 100 characters/);
    expect(text).toMatch(/timings/);
  });

  it('states Cloudflare\'s sampled request records, which the site can\'t turn off', () => {
    expect(text).toMatch(/sample/);
    expect(text).toMatch(/can't turn (?:them|these) off/);
  });

  it('says what stays on the device and how to clear it, and what a copied link carries', () => {
    expect(text).toMatch(/year of study/);
    expect(text).toMatch(/Forget this list on this device/);
    expect(text).toMatch(/site data/);
    expect(text).toMatch(/Copy link/);
  });

  it('says the site sets no cookies and loads no trackers, though Cloudflare may set a security cookie', () => {
    expect(text).toMatch(/sets no cookies/);
    expect(text).toMatch(/security cookie/);
    expect(text).toMatch(/no trackers/);
  });

  it('promises nothing past today: no date, no year', () => {
    expect(text).not.toMatch(/\b20\d\d\b/);
  });
});

describe('the year line (8B)', () => {
  it('names the rows\' year, and tells applicants for the next one what to expect', () => {
    const y = '2030-2031';
    const line = yearLine(y);
    expect(line).toContain(`NUS's ${label(y)}`);
    expect(line).toContain(`Applying for ${label(next(y))}?`);
    expect(line).toContain('March or April');
    expect(line).toContain(`until July, this site shows ${label(y)}'s`);
  });

  it('follows DEFAULT_ACAD_YEAR', () => {
    expect(yearLine(DEFAULT_ACAD_YEAR)).toContain(`Applying for ${label(next(DEFAULT_ACAD_YEAR))}?`);
  });
});

describe('the 403\'s sentence (8B)', () => {
  it('says the search came from another site, and doesn\'t invite a retry', () => {
    expect(Object.keys(ERROR_SENTENCES)).toContain('cross_site');
    const s = errorSentence({ code: 'cross_site' });
    expect(s).toMatch(/another (?:web)?site/i);
    expect(s).not.toMatch(/try again/i);
  });
});

describe('the rate limits (8B, G5 (b))', () => {
  const config = parseJsonc(read('wrangler.jsonc'), 'wrangler.jsonc');

  it('SEARCH_LIMIT allows 40 per 10 s and SEARCH_LIMIT_MINUTE 200 per 60 s, in their own namespaces', () => {
    const limits = Object.fromEntries(config.ratelimits.map((/** @type {any} */ r) => [r.name, r]));
    expect(Object.keys(limits).sort()).toEqual(['SEARCH_LIMIT', 'SEARCH_LIMIT_MINUTE']);
    expect(limits.SEARCH_LIMIT.simple).toEqual({ limit: 40, period: 10 });
    expect(limits.SEARCH_LIMIT_MINUTE.simple).toEqual({ limit: 200, period: 60 });
    expect(limits.SEARCH_LIMIT.namespace_id).not.toBe(limits.SEARCH_LIMIT_MINUTE.namespace_id);
  });

  it('the generated Env declares both', () => {
    const types = read('worker-configuration.d.ts');
    expect(types).toMatch(/\bSEARCH_LIMIT: RateLimit;/);
    expect(types).toMatch(/\bSEARCH_LIMIT_MINUTE: RateLimit;/);
  });

  it('observability stays as it is (G3 (a))', () => {
    expect(config.observability).toEqual({ enabled: true });
  });
});
