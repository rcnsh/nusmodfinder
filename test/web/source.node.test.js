// @ts-check
// The page's source as a whole (Phase 5 5B): static assets in public/ that
// never shadow an API path, DOM-only rendering enforced by lint (F8), and
// Enter that waits for IME composition (F9).
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
  it('public/ holds the page, its stylesheet and its ES modules, with no build output', () => {
    expect(files).toEqual(expect.arrayContaining(['/index.html', '/styles.css', '/app.js', '/state.js', '/nav.js', '/api.js', '/messages.js', '/format.js', '/keys.js', '/dom.js', '/render.js', '/explain.js', '/detail.js', '/cohort-only.js']));
    for (const f of files) expect(f, f).toMatch(/\.(html|css|js|svg|ico|png|txt)$/);
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
  it('[P3 fixed] the title and the visible header say unofficial, NUS is not the brand, and the footer links the sources', () => {
    const html = read('public/index.html');
    expect(html).toContain('<title>Exchange Course Finder (unofficial, for NUS)</title>');
    expect(html).toContain('<h1>Exchange Course Finder <span class="unofficial">(unofficial, for NUS)</span></h1>');
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
