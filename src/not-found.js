// @ts-check
import page from './404.html';

export const PAGE_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'none'; script-src 'self' 'sha256-/v4Rz6x05oDSZmmOGtRO1IG3UBcWMdE63isXFGHVCQU='; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
});

/** @param {string | null} accept */
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

export const notFoundPage = () => new Response(page, {
  status: 404,
  headers: { 'content-type': 'text/html; charset=utf-8', ...PAGE_HEADERS },
});
