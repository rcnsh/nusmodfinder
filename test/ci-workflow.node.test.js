// @ts-check
// The UI job runs in Playwright's own image, whose browsers must be the ones the locked
// @playwright/test drives: bump one without the other and every UI test fails to launch.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('the ui CI job', () => {
  const workflow = read('.github/workflows/ci.yml');
  const ui = workflow.slice(workflow.indexOf('\n  ui:\n'));

  it('runs in the Playwright image of the locked @playwright/test version', () => {
    const locked = JSON.parse(read('package-lock.json')).packages['node_modules/@playwright/test'].version;
    expect(ui).toMatch(new RegExp(`image: mcr\\.microsoft\\.com/playwright:v${locked.replaceAll('.', '\\.')}-noble\\n`));
  });

  it('installs nothing with apt', () => {
    expect(ui).not.toMatch(/--with-deps|apt-get/);
  });
});
