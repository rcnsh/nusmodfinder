// @ts-check
// Static assets in front of the Worker: `/` is the page from
// public/, and every API path still reaches the Worker.
import { expect, test } from '@playwright/test';

test('/ and the page files are static assets, with no x-app-version (GET /health is the trace)', async ({ request }) => {
  const root = await request.get('/');
  expect(root.status()).toBe(200);
  expect(root.headers()['content-type']).toContain('text/html');
  expect(await root.text()).toContain('<script type="module" src="/app.js"></script>');
  expect(root.headers()['x-app-version']).toBeUndefined();
  for (const [path, type] of [['/app.js', 'javascript'], ['/state.js', 'javascript'], ['/styles.css', 'text/css']]) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toContain(type);
  }
});

test('every API path reaches the Worker: JSON with x-app-version', async ({ request }) => {
  const paths = /** @type {const} */ ([
    ['/search?q=networks', 200], ['/facets', 200], ['/module/CS5562', 200], ['/module/ZZ0000', 404],
    ['/health', 200], ['/admin/hashes', 401], ['/nope', 404],
  ]);
  for (const [path, status] of paths) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(status);
    expect(res.headers()['content-type'], path).toContain('application/json');
    expect(res.headers()['x-app-version'], path).toBe('dev');
  }
  const health = await (await request.get('/health')).json();
  expect(health.vectors.corpus).toBe('fixture');
});
