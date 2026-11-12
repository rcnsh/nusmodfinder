// @ts-check
// `npm run ops:requests` prints live-call totals from the run records. Fake
// records in a temp dir.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opsRequests } from '../scripts/ops-requests.mjs';
import { startRun } from '../scripts/run-record.mjs';

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-opsreq-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('npm run ops:requests', () => {
  it('prints the run records\' requests by script and path, and the sum', () => {
    const runs = join(dir, 'runs');
    const a = startRun('smoke', { dir: runs, target: 'https://nusmodfinder.rcn.sh' });
    a.request('/health');
    a.request('/search', 2);
    a.finish('ok');
    const b = startRun('live-shortlist', { dir: runs, target: 'https://nusmodfinder.rcn.sh' });
    b.request('/module/CS2040', 3);
    b.finish('failed', { exitCode: 1 });
    startRun('verify', { dir: runs, target: 'x' }).finish('ok');
    const out = opsRequests({ runsDir: runs });
    expect(out.runs).toEqual({ records: 3, requests: 6, byScript: { smoke: 3, 'live-shortlist': 3 }, byPath: { '/health': 1, '/search': 2, '/module/CS2040': 3 } });
    expect(out.lines.join('\n')).toMatch(/run records: 3 .* 6 requests/);
    expect(out.lines.join('\n')).toMatch(/\/module\/CS2040: 3/);
  });

  it('an empty or missing runs dir totals nothing', () => {
    expect(opsRequests({ runsDir: join(dir, 'none') }).runs).toEqual({ records: 0, requests: 0, byScript: {}, byPath: {} });
  });
});
