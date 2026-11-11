// @ts-check
// The page's source as a whole (Phase 5 5B): static assets in public/ that
// never shadow an API path, DOM-only rendering enforced by lint (F8), and
// Enter that waits for IME composition (F9).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { isCloseEscape, isSubmitEnter } from '../../public/keys.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = join(ROOT, 'public');
/** @param {string} dir @returns {string[]} */
const walk = (dir) => readdirSync(dir, { withFileTypes: true })
  .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
const files = walk(PUBLIC).map((f) => `/${relative(PUBLIC, f).split('\\').join('/')}`).sort();
const read = (/** @type {string} */ rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('static assets', () => {
  it('public/ holds the page, its stylesheet, its ES modules and its self-hosted fonts, with no build output', () => {
    expect(files).toEqual(expect.arrayContaining(['/index.html', '/styles.css', '/app.js', '/state.js', '/nav.js', '/api.js', '/messages.js', '/format.js', '/keys.js', '/dom.js', '/render.js', '/explain.js', '/detail.js', '/icons.js', '/fonts/OFL.txt']));
    for (const f of files) expect(f, f).toMatch(/^\/fonts\/[\w-]+\.(woff2|txt)$|^\/[\w-]+\.(html|css|js|svg|ico|png|txt)$|^\/_headers$/);
  });

  it('no file in public/ matches an API path, so every API request still reaches the Worker', () => {
    const api = [/^\/search\b/, /^\/facets\b/, /^\/module(\/|$)/, /^\/health\b/, /^\/admin(\/|$)/];
    for (const f of files) for (const route of api) expect(f, `${f} would shadow ${route}`).not.toMatch(route);
  });

  it('wrangler.jsonc serves public/ as static assets with no binding, so Env gains nothing', () => {
    const config = read('wrangler.jsonc');
    expect(config).toContain('"assets": { "directory": "./public" }');
    expect(config).not.toMatch(/"assets":\s*\{[^}]*"binding"/);
  });

  it('src/ no longer serves a page: the Worker answers / with its JSON 404 (assets answer it in front)', () => {
    expect(walk(join(ROOT, 'src')).filter((f) => f.endsWith('.html'))).toEqual([]);
    expect(read('src/index.js')).not.toMatch(/page\.html|text\/html/);
  });

  it('every module is a native ES module with // @ts-check, loaded from index.html with no build step', () => {
    const html = read('public/index.html');
    expect(html).toContain('<script type="module" src="/app.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    for (const f of files.filter((x) => x.endsWith('.js'))) expect(read(`public${f}`).startsWith('// @ts-check\n'), f).toBe(true);
    expect(JSON.parse(read('package.json')).scripts.typecheck).toContain('tsc -p tsconfig.web.json');
  });
});

describe('rendering builds DOM nodes (F8)', () => {
  it('[F8 fixed] lint bans innerHTML, outerHTML and insertAdjacentHTML in public/', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    const sinks = [
      'document.body.innerHTML = location.hash;',
      'document.body.outerHTML = location.hash;',
      "document.body.insertAdjacentHTML('beforeend', location.hash);",
      "const k = 'innerHTML'; document.body[k] = location.hash;",
      'Object.assign(document.body, { innerHTML: location.hash });',
    ];
    for (const code of sinks) {
      const [result] = await eslint.lintText(`// @ts-check\n${code}\n`, { filePath: join(PUBLIC, 'probe.js') });
      expect(result.messages.map((m) => m.ruleId), code).toEqual(expect.arrayContaining([expect.stringMatching(/^no-restricted-(properties|syntax)$/)]));
    }
    const [ok] = await eslint.lintText("// @ts-check\ndocument.body.textContent = location.hash;\n", { filePath: join(PUBLIC, 'probe.js') });
    expect(ok.messages).toEqual([]);
  });

  it('no file in public/ names an HTML sink at all', () => {
    for (const f of files) expect(read(`public${f}`), f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});

describe('provenance (P3)', () => {
  it('[P3 fixed] the title and the visible header say unofficial, and the footer links the sources', () => {
    const html = read('public/index.html');
    expect(html).toContain('<title>NUS Mod Finder (unofficial)</title>');
    // The h1's text; the brackets are visually hidden (the badge's outline stands in for them) but read aloud.
    const h1 = /** @type {string} */ (html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]);
    expect(h1.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '')).toBe('NUS Mod Finder (unofficial)');
    expect(h1).toContain('<span class="unofficial">');
    expect(html).not.toMatch(/NUSMods semantic search/);
    const footer = /** @type {string} */ (html.match(/<footer[\s\S]*?<\/footer>/)?.[0]);
    expect(footer).toContain('An unofficial site, not run by NUS or NUSMods.');
    for (const href of ['https://nusmods.com/', 'https://www.nus.edu.sg/registrar/prospective-students/non-graduating', 'https://nus.edu.sg/coursereg/resources.html']) {
      expect(footer).toContain(`href="${href}"`);
    }
    expect(footer).toContain("The Registrar's course vacancy report");
  });

  it("the page's NG-list and restrictions links are the sources the Worker cites (data/ng-reasons.json)", () => {
    const html = read('public/index.html');
    for (const s of JSON.parse(read('data/ng-reasons.json')).sources) expect(html, s.name).toContain(`href="${s.url}"`);
  });
});

describe('IME (F9)', () => {
  it('[F9 fixed] Enter submits only when !e.isComposing && e.keyCode !== 229', () => {
    expect(isSubmitEnter({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true);
    expect(isSubmitEnter({ key: 'Enter', isComposing: true, keyCode: 13 })).toBe(false);
    expect(isSubmitEnter({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false);
    expect(isSubmitEnter({ key: 'Process', isComposing: false, keyCode: 229 })).toBe(false);
    expect(isSubmitEnter({ key: 'a', isComposing: false, keyCode: 65 })).toBe(false);
  });

  it('Escape closes the open detail only outside IME composition (it cancels a candidate otherwise)', () => {
    expect(isCloseEscape({ key: 'Escape', isComposing: false, keyCode: 27 })).toBe(true);
    expect(isCloseEscape({ key: 'Escape', isComposing: true, keyCode: 27 })).toBe(false);
    expect(isCloseEscape({ key: 'Escape', isComposing: false, keyCode: 229 })).toBe(false);
    expect(isCloseEscape({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe('accessibility in the source (5E, F5)', () => {
  const page = read('public/index.html');
  const body = /** @type {string} */ (page.match(/<body>([\s\S]*)<\/body>/)?.[1]);
  const scripts = files.filter((f) => f.endsWith('.js')).map((f) => read(`public${f}`)).join('\n');

  it('[F5 fixed] one <h1>, a skip link before everything else, <main> and role="search", one polite live region, aria-busy on the list, and no script disables a control', () => {
    expect(page.match(/<h1\b/g)).toHaveLength(1);
    // The skip link is the first focusable element in the body.
    expect(body.match(/<(a|button|input|select|textarea)\b[^>]*>/)?.[0]).toBe('<a class="skip" id="skip" href="#setup">');
    expect(page).toMatch(/<main class="main" id="main"[^>]*tabindex="-1"/);
    expect(page).toMatch(/<main class="setup" id="setup"[^>]*tabindex="-1"/);
    expect(page).toMatch(/<form id="f" class="search" role="search"/);
    // One live region, polite, and no script makes another.
    expect(page.match(/aria-live=|role="(status|alert|log)"/g)).toEqual(['role="status"', 'aria-live=']);
    expect(page).toContain('<p class="vh" id="live" role="status" aria-live="polite" aria-atomic="true"></p>');
    expect(scripts).not.toMatch(/aria-live|'role',\s*'(status|alert)'|role: '(status|alert)'/);
    expect(page).toContain('<ol id="results" class="entries" aria-label="Results" aria-busy="false"></ol>');
    expect(read('public/render.js')).toContain("t.results.setAttribute('aria-busy', String(busy))");
    // Disabling the focused Search button dropped focus to the page (F5); nothing is disabled now.
    expect(scripts).not.toMatch(/\.disabled\s*=\s*true|setAttribute\('disabled'|toggleAttribute\('disabled'/);
  });
});

describe('[5G S3] public/_headers: the page can\'t be framed, and runs only its own code', () => {
  /** The rules as Workers Static Assets reads them: a path line, then indented "Name: value" lines. */
  const rules = (() => {
    /** @type {Record<string, Record<string, string>>} */
    const out = {};
    let path = '';
    for (const line of read('public/_headers').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) { path = line.trim(); out[path] = {}; continue; }
      const at = line.indexOf(':');
      out[path][line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    return out;
  })();
  const all = rules['/*'] ?? {};
  /** @type {Record<string, string[]>} */
  const csp = Object.fromEntries((all['content-security-policy'] ?? '').split(';').map((d) => d.trim()).filter(Boolean)
    .map((d) => { const [name, ...values] = d.split(/\s+/); return [name, values]; }));

  it('every path forbids framing, both ways, and sniffing', () => {
    expect(Object.keys(rules)).toEqual(['/*']);
    expect(all['x-frame-options']).toBe('DENY');
    expect(csp['frame-ancestors']).toEqual(["'none'"]);
    expect(all['x-content-type-options']).toBe('nosniff');
  });

  it('the CSP allows only the page\'s own files, and nothing inline but the one hashed script', () => {
    expect(csp['default-src']).toEqual(["'none'"]);
    for (const d of ['style-src', 'font-src', 'connect-src', 'img-src', 'manifest-src']) expect(csp[d], d).toEqual(["'self'"]);
    expect(csp['base-uri']).toEqual(["'none'"]);
    expect(csp['form-action']).toEqual(["'self'"]);
    expect(Object.values(csp).flat()).not.toContain("'unsafe-inline'");
    expect(Object.values(csp).flat()).not.toContain("'unsafe-eval'");
    // script-src: 'self' and a hash for each inline <script> in index.html, so changing one fails here.
    const html = read('public/index.html');
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    expect(inline).toHaveLength(1);
    expect(csp['script-src']).toEqual(["'self'", ...inline]);
  });

  it('nothing in the page writes a style attribute or loads from another origin (the CSP would block it)', () => {
    for (const f of files.filter((x) => /\.(js|html|css)$/.test(x))) {
      const text = read(`public${f}`);
      expect(text, f).not.toMatch(/setAttribute\(\s*['"]style|\sstyle="|<style[\s>]/);
      expect(text, f).not.toMatch(/(?:src|href)="https?:\/\/(?!nusmods\.com|www\.nus\.edu\.sg|nus\.edu\.sg|nusmodfinder\.rcn\.sh\/)/);
      expect(text, f).not.toMatch(/url\(\s*["']?(?:https?:|data:)/);
    }
  });
});
