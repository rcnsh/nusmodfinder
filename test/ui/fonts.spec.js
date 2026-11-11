// @ts-check
// The fonts (Phase 5 5D): IBM Plex Sans (400, 500, 600) and Plex Mono (400,
// 500), self-hosted as WOFF2 under public/fonts/ with their SIL OFL licence,
// `font-display: swap` and a fallback stack; the page makes no request to any
// other origin; and neither face draws a slashed or dotted zero.
import { expect, test } from '@playwright/test';

test('the page loads only from its own origin: fonts, styles and scripts included', async ({ page, baseURL }) => {
  /** @type {string[]} */
  const elsewhere = [];
  /** @type {string[]} */
  const fonts = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== new URL(String(baseURL)).origin && u.protocol !== 'data:') elsewhere.push(r.url());
    if (r.resourceType() === 'font') fonts.push(u.pathname);
  });
  await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB');
  await expect(page.locator('#results .detail-close')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(elsewhere).toEqual([]);
  expect(fonts.length).toBeGreaterThanOrEqual(3);
  for (const f of fonts) expect(f).toMatch(/^\/fonts\/IBMPlex(Sans|Mono)-[A-Za-z]+-Latin1\.woff2$/);
});

test('every weight the page uses is loaded, and each face swaps in (font-display: swap) over a fallback stack', async ({ page }) => {
  await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1');
  await expect(page.locator('#results > li.card').first()).toBeVisible();
  const faces = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = await Promise.all(['400', '500', '600'].map((w) => document.fonts.load(`${w} 16px "IBM Plex Sans"`))
      .concat(['400', '500'].map((w) => document.fonts.load(`${w} 16px "IBM Plex Mono"`))));
    const rules = [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => r instanceof CSSFontFaceRule)
      .map((r) => {
        const st = /** @type {CSSFontFaceRule} */ (r).style;
        return `${st.getPropertyValue('font-family').replace(/"/g, '')} ${st.getPropertyValue('font-weight')} ${st.getPropertyValue('font-display')}`;
      });
    return { loaded: loaded.map((l) => l.length), rules, body: getComputedStyle(document.body).fontFamily, code: getComputedStyle(/** @type {Element} */ (document.querySelector('.code'))).fontFamily };
  });
  expect(faces.loaded).toEqual([1, 1, 1, 1, 1]);
  expect(faces.rules.sort()).toEqual([
    'IBM Plex Mono 400 swap', 'IBM Plex Mono 500 swap', 'IBM Plex Sans 400 swap', 'IBM Plex Sans 500 swap', 'IBM Plex Sans 600 swap',
  ]);
  // WebKit leaves the quotes out of the computed value.
  expect(faces.body).toMatch(/^"?IBM Plex Sans"?, system-ui, .*sans-serif$/);
  expect(faces.code).toMatch(/^"?IBM Plex Mono"?, ui-monospace, .*monospace$/);
});

test('no weight above 600 is used anywhere on the page', async ({ page }) => {
  await page.goto('/?q=ACC1701XB&ng=1&study=ug2&sem=1&open=ACC1701XB');
  await expect(page.locator('#results .detail-close')).toBeVisible();
  const heavy = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter((el) => Number(getComputedStyle(el).fontWeight) > 600).map((el) => el.tagName));
  expect(heavy).toEqual([]);
});

test('the WOFF2 files are served as fonts, and the licence beside them', async ({ request }) => {
  for (const f of ['IBMPlexSans-Regular', 'IBMPlexSans-Medium', 'IBMPlexSans-SemiBold', 'IBMPlexMono-Regular', 'IBMPlexMono-Medium']) {
    const res = await request.get(`/fonts/${f}-Latin1.woff2`);
    expect(res.status(), f).toBe(200);
    expect(res.headers()['content-type'], f).toContain('font/woff2');
  }
  const ofl = await request.get('/fonts/OFL.txt');
  expect(ofl.status()).toBe(200);
  expect(await ofl.text()).toContain('SIL Open Font License, Version 1.1');
});

test('neither face draws a slashed or dotted zero: the middle of every 0 the page draws is empty', async ({ page }) => {
  await page.goto('/?q=CS3244&sem=1');
  const card = page.locator('#results > li.card').first();
  await expect(card).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  /**
   * The share of dark pixels in the middle fifth of the ink a "0" in `el`
   * draws at 200px, from a screenshot (so the page's own font features apply).
   * @param {import('@playwright/test').Locator} el
   * @param {string} [features] a font-feature-settings value to force, for the controls
   */
  const middleInk = async (el, features) => {
    await el.evaluate((node, f) => {
      const e = /** @type {HTMLElement} */ (node);
      e.textContent = '0';
      Object.assign(e.style, { fontSize: '200px', lineHeight: '1', display: 'inline-block', padding: '20px', color: '#000', background: '#fff', textDecoration: 'none' });
      if (f) e.style.fontFeatureSettings = f;
    }, features);
    const png = (await el.screenshot()).toString('base64');
    return page.evaluate(async (b64) => {
      // Decoded in place, not fetched: the page's CSP (connect-src 'self', 5G S3) refuses a data: fetch.
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = /** @type {OffscreenCanvasRenderingContext2D} */ (c.getContext('2d'));
      ctx.drawImage(bmp, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, bmp.width, bmp.height);
      const dark = (/** @type {number} */ x, /** @type {number} */ y) => data[(y * width + x) * 4] < 128;
      let [x0, y0, x1, y1] = [width, height, 0, 0];
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (dark(x, y)) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const [w, h] = [x1 - x0, y1 - y0];
      let n = 0; let total = 0;
      for (let y = Math.round(y0 + h * 0.4); y < y0 + h * 0.6; y++) for (let x = Math.round(x0 + w * 0.4); x < x0 + w * 0.6; x++) { total++; if (dark(x, y)) n++; }
      return n / total;
    }, png);
  };
  const faces = {
    'Plex Mono 400 (units)': card.locator('.units'),
    'Plex Mono 500 (code)': card.locator('.code'),
    'Plex Sans 600 (count)': page.locator('#status .count strong'),
    'Plex Sans 400 (department)': card.locator('.meta .dept'),
  };
  for (const [face, el] of Object.entries(faces)) expect(await middleInk(el), face).toBe(0);
  // Controls: the probe sees Plex Mono's own dotted zero and its slashed one.
  await page.reload();
  await expect(card).toBeVisible();
  expect(await middleInk(card.locator('.units'), 'normal')).toBeGreaterThan(0.05);
  expect(await middleInk(card.locator('.code'), '"zero"')).toBeGreaterThan(0.05);
});
