// @ts-check
// scripts/verify.mjs: paging through `wrangler vectorize list-vectors --json`
// (stubbed: never run against Cloudflare), and exit codes. The comparison
// itself runs against the real route in test/verify.test.js.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INDEX, listVectorIds, main, preDeployDataFiles } from '../scripts/verify.mjs';

/**
 * A stub `npx wrangler vectorize list-vectors` serving `ids` in pages.
 * @param {string[]} ids
 * @param {number} pageSize
 */
function stubWrangler(ids, pageSize) {
  /** @type {string[][]} */
  const calls = [];
  /** @type {import('../scripts/deploy.mjs').Exec} */
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    // Like wrangler (yargs): a cursor sent as its own word that starts with "-h" is read as --help,
    // which prints the usage and exits 0. Cursors are base64url, so one can start with "-".
    const i = args.indexOf('--cursor');
    if (i !== -1 && args[i + 1]?.startsWith('-')) return { code: 0, stdout: 'wrangler vectorize list-vectors <name>\n\nList vector identifiers' };
    const eq = args.find((a) => a.startsWith('--cursor='));
    const start = eq ? Number(eq.slice('--cursor=-h'.length)) : 0;
    const page = ids.slice(start, start + pageSize);
    const more = start + pageSize < ids.length;
    // wrangler prints its banner before the JSON.
    return { code: 0, stdout: `\n ⛅️ wrangler\n${JSON.stringify({
      count: page.length, totalCount: ids.length, isTruncated: more, nextCursor: more ? `-h${start + pageSize}` : null,
      vectors: page.map((id) => ({ id })),
    })}` };
  };
  return { exec, calls };
}

describe('scripts/verify.mjs', () => {
  it('pages through list-vectors --json with the cursor until it is not truncated, a cursor starting with "-" included', async () => {
    const ids = Array.from({ length: 2345 }, (_, i) => `M${i}`);
    const w = stubWrangler(ids, 1000);
    expect(await listVectorIds('idx', w.exec)).toEqual(ids);
    expect(w.calls).toEqual([
      ['npx', 'wrangler', 'vectorize', 'list-vectors', 'idx', '--json', '--count', '1000'],
      ['npx', 'wrangler', 'vectorize', 'list-vectors', 'idx', '--json', '--count', '1000', '--cursor=-h1000'],
      ['npx', 'wrangler', 'vectorize', 'list-vectors', 'idx', '--json', '--count', '1000', '--cursor=-h2000'],
    ]);
  });

  it('defaults to the index wrangler.jsonc binds', () => {
    const cfg = readFileSync(fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)), 'utf8');
    expect(cfg).toContain(`"index_name": "${DEFAULT_INDEX}"`);
  });

  /**
   * @param {{ codes: string[], ids: string[] }} state
   */
  const runMain = async ({ codes, ids }) => {
    /** @type {string[]} */
    const lines = [];
    /** @type {typeof fetch} */
    const fetchImpl = async () => new Response(JSON.stringify({
      codes, rowHash: { checked: codes.length, drift: [], missing: [] },
      sample: { checked: 0, codes: [], missingVectors: [], metadataDrift: [] }, meta: { rows_read: codes.length },
    }));
    const code = await main(['--url', 'http://worker.test'], {
      fetchImpl, exec: stubWrangler(ids, 1000).exec, log: (l) => lines.push(l), envVars: { INGEST_SECRET: 's' },
    });
    return { code, lines };
  };

  it('exits 0 when D1 and Vectorize agree, 1 on drift, 2 when it cannot verify', async () => {
    expect((await runMain({ codes: ['A', 'B'], ids: ['B', 'A'] })).code).toBe(0);
    const drift = await runMain({ codes: ['A', 'B'], ids: ['A', 'C'] });
    expect(drift.code).toBe(1);
    expect(drift.lines.join('\n')).toMatch(/missing vectors\s+1 {2}B/);
    expect(drift.lines.join('\n')).toMatch(/extra vectors\s+1 {2}C/);
    const failing = await main([], { exec: async () => ({ code: 1, stdout: '' }), log: () => {},
      fetchImpl: async () => new Response('{}', { status: 401 }), envVars: { INGEST_SECRET: 's' } });
    expect(failing).toBe(2);
    expect(await main([], { log: () => {}, envVars: {} })).toBe(2);
  });
});

describe('verify --pre-deploy\'s data files (6A)', () => {
  it('reads the committed year files and the year\'s NG list: 1,207 NG codes, the file\'s 40 among them', () => {
    const files = preDeployDataFiles('2026-2027');
    expect(files.ngReasonsAcadYear).toBe('2026-2027');
    expect(files.unscheduled.acadYear).toBe('2026-2027');
    expect(files.ngCodes).toHaveLength(1207);
    expect(files.unscheduled.codes.length).toBeGreaterThan(0);
    expect(files.unscheduled.codes.filter((c) => !files.ngCodes.includes(c))).toEqual([]);
  });
});
