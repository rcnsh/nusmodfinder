// @ts-check
// Phase 7 7C: `npm run ops:requests` prints live-call totals from both
// docs/evidence/requests.tsv (rows 1-131 and the back-fill, typed by hand)
// and the run records. Fake files in a temp dir, plus the committed TSV's
// back-fill and corrections.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { opsRequests, statedCalls, tsvTotals } from '../scripts/ops-requests.mjs';
import { startRun } from '../scripts/run-record.mjs';

const TSV = fileURLToPath(new URL('../docs/evidence/requests.tsv', import.meta.url));

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-opsreq-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('requests.tsv totals', () => {
  it('a curl, fetch or browser row is one call; a ref row counts the calls it states; a correction is no call', () => {
    const tsv = [
      'n\tkind\tpath_or_name\tnote',
      '1\tcurl\tGET /search?q=a | http=200\tphase0',
      '2\tfetch\tGET /module/X | http=200\tphase2',
      '3\tbrowser /search\tthe page\tphase2',
      '4\tref\tp5-live.mjs on version x: 99 requests >= 4 s apart\tPhase 5',
      '5\tref\tProduction smoke: /health + 3 /search on version y\tPhase 3',
      '6\tref\ts7-1..s7-41: docs/evidence/phase3/sc7-requests.tsv\tSC7 counted run, 41 /search calls on version z',
      '7\tref\tPhase 7 deploy token check: 4 Cloudflare API calls >= 4 s apart\tPhase 7',
      '8\tref\tBack-filled: p5-live first run: requests sent not recorded (estimate ~100)\tPhase 5',
      '9\tcorrection\tRows 4 and 5: the date is 2026-11-11, not 2026-11-12\tPhase 7 7C',
      '10\tref\tShip: 1 /health before the deploy; live re-check: 68 requests (page files, /search)\tPhase 6',
      '11\tref\tSC1 live check: 30 exchange /search calls, plus 7 re-sends\tPhase 4',
      '12\tref\tp6-live: /facets, 8 /module, 3 /module 404s; 43 requests one at a time\tPhase 6',
    ].join('\n');
    expect(tsvTotals(tsv)).toEqual({
      rows: 12, oneCallRows: 3, refRows: 8, corrections: 1, statedCalls: 3 + 99 + 41 + 4 + 68 + 30 + 43, refRowsWithoutCount: [5, 8],
      // A count's own breakdown (row 12) is not more calls; a /health before it and re-sends are.
      refRowsPartlyCounted: [10, 11],
    });
  });

  it('reads "N requests", "N calls" and "N <words> calls", not row counts or other numbers', () => {
    expect(statedCalls('43 requests one at a time')).toBe(43);
    expect(statedCalls('30 exchange /search calls on version efd3dc25, plus 7 re-sends')).toBe(30);
    expect(statedCalls('guard read 6,778 D1 rows; 2 Cloudflare API calls')).toBe(2);
    expect(statedCalls('1,234 requests')).toBe(1234);
    expect(statedCalls('6,771 texts in 68 requests, 2,187.1 neurons')).toBe(68);
    expect(statedCalls('/health + 3 /search')).toBeNull();
    expect(statedCalls('count not recorded')).toBeNull();
  });

  it('the committed TSV: rows 1-131 as they were, then the back-fill and the corrections, each marked', () => {
    const lines = readFileSync(TSV, 'utf8').trimEnd().split('\n');
    const rows = lines.slice(1).map((l) => l.split('\t'));
    // Rows up to 131 keep their ids (the oldest use b1-style ids); the back-fill numbers on from 132.
    const last = rows.findIndex((r) => r[0] === '131');
    expect(rows[last][2]).toMatch(/^Phase 7 7-0 GraphQL Analytics/);
    const later = rows.slice(last + 1);
    expect(later.map((r) => Number(r[0]))).toEqual(later.map((_, i) => 132 + i));
    expect(later.length).toBeGreaterThanOrEqual(8);
    for (const r of later) expect(`${r[2]} ${r[3]}`).toMatch(/back-filled|correction/i);
    expect(later.some((r) => /a6103634/.test(r[2]) && /a7b90f4/.test(r[2]))).toBe(true);
    expect(later.some((r) => /59986aa3/.test(r[2]) && /3 requests/.test(r[2]))).toBe(true);
    expect(later.some((r) => /59986aa3/.test(r[2]) && /99 requests/.test(r[2]))).toBe(true);
    const corrections = later.filter((r) => r[1] === 'correction').map((r) => r[2]).join(' ');
    for (const n of ['124', '125', '127']) expect(corrections).toContain(n);
    expect(corrections).toMatch(/2026-11-11/);
  });
});

describe('npm run ops:requests', () => {
  it('prints the TSV totals, the run records\' requests by script and path, and the sum', () => {
    writeFileSync(join(dir, 'requests.tsv'), 'n\tkind\tpath_or_name\tnote\n1\tcurl\tGET /health\tx\n2\tref\t5 requests\ty\n');
    const runs = join(dir, 'runs');
    const a = startRun('smoke', { dir: runs, target: 'https://nusmodfinder.rcn.sh' });
    a.request('/health');
    a.request('/search', 2);
    a.finish('ok');
    const b = startRun('p6-live', { dir: runs, target: 'https://nusmodfinder.rcn.sh' });
    b.request('/module/CS2040', 3);
    b.finish('failed', { exitCode: 1 });
    const out = opsRequests({ tsvPath: join(dir, 'requests.tsv'), runsDir: runs });
    expect(out.tsv.statedCalls).toBe(6);
    expect(out.runs).toEqual({ records: 2, requests: 6, byScript: { smoke: 3, 'p6-live': 3 }, byPath: { '/health': 1, '/search': 2, '/module/CS2040': 3 } });
    expect(out.total).toBe(12);
    expect(out.lines.join('\n')).toMatch(/requests\.tsv: 2 rows/);
    expect(out.lines.join('\n')).toMatch(/0 state a count but describe more calls besides/);
    expect(out.lines.join('\n')).toMatch(/run records: 2 .* 6 requests/);
    expect(out.lines.join('\n')).toMatch(/total: 12 live calls stated/);
  });
});
