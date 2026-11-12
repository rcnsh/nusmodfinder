// @ts-check
// The 404 for a browser (Phase 8 8B). An unknown path answers JSON, as every API route does,
// unless the request prefers HTML: then it gets src/404.html (a Text module) with the security
// headers of public/_headers' `/*` rule. Cloudflare applies _headers to static assets only, so the
// Worker sets them itself. They are copied here, not imported, so the Worker (and the ranking
// lock's inputs, eval/lib/ranking-lock.mjs) reaches no file outside src/: test/visitor.test.js
// parses public/_headers and fails when a value here differs from the file's.
import page from './404.html';

/** public/_headers' `/*` rule: its CSP, X-Frame-Options and X-Content-Type-Options. */
export const PAGE_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self' 'sha256-/v4Rz6x05oDSZmmOGtRO1IG3UBcWMdE63isXFGHVCQU='; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
});

/**
 * Whether an Accept header prefers HTML to JSON: text/html (or XHTML) is named with q > 0, and its
 * q is at least what JSON would get (application/json, application/*, or *\/*). A browser's
 * navigation does (text/html at 1, *\/* at 0.8); curl and Node's fetch (*\/* alone) and the page's
 * own fetches (application/json) don't, so they keep the JSON 404.
 * @param {string | null} accept
 */
export function prefersHtml(accept) {
  if (!accept) return false;
  /** @type {Map<string, number>} */
  const q = new Map();
  for (const part of accept.split(',')) {
    const [type, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    const qParam = params.find((p) => p.startsWith('q='));
    const value = qParam ? Number(qParam.slice(2)) : 1;
    q.set(type, Math.max(q.get(type) ?? 0, Number.isFinite(value) ? value : 0));
  }
  const html = Math.max(q.get('text/html') ?? 0, q.get('application/xhtml+xml') ?? 0);
  const json = Math.max(q.get('application/json') ?? 0, q.get('application/*') ?? 0, q.get('*/*') ?? 0);
  return html > 0 && html >= json;
}

/** The HTML 404, with the page's security headers. */
export const notFoundPage = () => new Response(page, {
  status: 404,
  headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS },
});
