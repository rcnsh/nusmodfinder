// @ts-check
// Phase 7 7E (docs/plans/phase7.md 7E, tests first): scripts/yst-text.mjs, the YST page's text
// extraction that was done by hand ("tags stripped, one text node per line"). The lead checks it
// on the Mac against the saved pages (`--expect <the manifest's sha256>`); here, fake pages in a
// temp dir, and like the --full cases these run on the Mac only and skip in CI.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, ystText } from '../scripts/yst-text.mjs';
import { sha } from './year-fakes.node.mjs';

const PAGE = `<!doctype html><html><head><title>Courses</title><style>p { color: red }</style>
<script>var x = "<p>not text</p>";</script></head><body>
<!-- a comment -->
<h3><span style="color:#ff5200">MUA1101</span> Music &amp; Society (4 Units)</h3>
<p>Pre-requisite:   MUA1100
  or&nbsp;equivalent</p><p></p><p>&nbsp;</p>
<div>MUH2201 <em>Western</em> Music&#39;s History (4 Units)&nbsp;</div>
</body></html>`;

describe.skipIf(Boolean(process.env.CI))('yst-text (on the Mac)', () => {
  /** @type {string} */
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-yst-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('one text node per line: script, style and comments dropped, entities decoded, white space collapsed', () => {
    // As the Phase 4 hand extraction did (the committed .txt files reproduce byte for byte, checked
    // on the Mac against the saved pages): only ASCII white space collapses, so a no-break space
    // inside a node stays; each node is trimmed of every space, no-break ones too, and a node of
    // only those is dropped; lines are joined by newlines with none after the last.
    expect(ystText(PAGE)).toBe([
      'Courses', 'MUA1101', 'Music & Society (4 Units)', 'Pre-requisite: MUA1100 or equivalent',
      'MUH2201', 'Western', "Music's History (4 Units)",
    ].join('\n'));
  });

  it('--out writes the text, and --expect refuses any other sha256', () => {
    const html = join(dir, 'page.html');
    writeFileSync(html, PAGE);
    const out = join(dir, 'page.txt');
    /** @type {string[]} */
    const lines = [];
    const log = (/** @type {string} */ m) => { lines.push(m); };
    const want = sha(ystText(PAGE));
    expect(main([html, '--out', out, '--expect', want], { log })).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(ystText(PAGE));
    expect(main([html, '--expect', 'f'.repeat(64)], { log, out: () => {} })).toBe(1);
    expect(lines.at(-1)).toMatch(new RegExp(`has sha256 ${want}, not f{64}`));
    expect(main([], { log })).toBe(2);
  });
});
