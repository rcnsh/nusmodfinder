// @ts-check
// .github/workflows/drift.yml stays thin and harmless. It may read NUSMods'
// public API and write issues, nothing else: no Cloudflare call, no live-site call, no secret but
// the run's own GITHUB_TOKEN. Text checks (the repo has no YAML parser, and needs none for this).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHECK_FOR_SCHEDULE } from '../scripts/drift.mjs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const workflow = read('.github/workflows/drift.yml');
const script = read('scripts/drift.mjs');
/** The workflow without its comments. */
const code = workflow.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');

describe('the drift workflow', () => {
  it('has exactly contents: read and issues: write, at the top and nowhere else', () => {
    expect(code).toMatch(/^permissions:\n {2}contents: read\n {2}issues: write\n(?! {2}\S)/m);
    expect(code.match(/permissions:/g)).toHaveLength(1);
  });

  it('runs weekly and monthly on a schedule, and by hand', () => {
    const crons = [...code.matchAll(/- cron: '([^']+)'/g)].map((m) => m[1]);
    expect(crons).toHaveLength(2);
    expect(crons.map((c) => CHECK_FOR_SCHEDULE[c]).sort()).toEqual(['monthly', 'weekly']);
    const [weekly] = crons.filter((c) => CHECK_FOR_SCHEDULE[c] === 'weekly');
    const [monthly] = crons.filter((c) => CHECK_FOR_SCHEDULE[c] === 'monthly');
    expect(weekly.split(' ').slice(2)).toEqual(['*', '*', expect.stringMatching(/^[0-6]$/)]);
    expect(monthly.split(' ').slice(2)).toEqual(['1', '*', '*']);
    // The workflow passes the schedule to the script, which maps it; the YAML has no logic of its own.
    expect(code).toContain('github.event.schedule');
    expect(code).toMatch(/workflow_dispatch:/);
  });

  it('makes no Cloudflare call and no live-site call', () => {
    for (const text of [code, script]) {
      expect(text).not.toMatch(/cloudflare|wrangler|CLOUDFLARE_|nusmodfinder\.rcn\.sh|\brcn\.sh\b|npm run (deploy|remote|ingest|verify)/i);
    }
  });

  it('reads only NUSMods\' public API, and writes only GitHub issues', () => {
    const hosts = (/** @type {string} */ t) => [...new Set([...t.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase()))];
    // GitHub's own hosts: the issues API, the run's URL, and the docs the 60-day note cites.
    const allowed = new Set(['api.nusmods.com', 'api.github.com', 'github.com', 'docs.github.com']);
    expect(hosts(script).filter((h) => !allowed.has(h))).toEqual([]);
    expect(hosts(script)).toContain('api.nusmods.com');
    expect(hosts(code)).toEqual([]);
  });

  it('uses no secret but GITHUB_TOKEN', () => {
    const secrets = [...code.matchAll(/secrets\.([A-Za-z_]+)/g)].map((m) => m[1]);
    expect(secrets.length).toBeGreaterThan(0);
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']));
  });

  it('keeps the cached ETag with actions/cache', () => {
    expect(code).toMatch(/uses: actions\/cache\/restore@v\d+/);
    expect(code).toMatch(/uses: actions\/cache\/save@v\d+/);
    expect(code).toMatch(/--cache-dir \.data\/drift-cache/);
    expect([...code.matchAll(/path: (\S+)/g)].map((m) => m[1])).toEqual(['.data/drift-cache', '.data/drift-cache']);
  });

  it('keeps its logic in scripts/drift.mjs, and opens an issue when a step before it fails', () => {
    expect(code).toMatch(/run: node scripts\/drift\.mjs "\$CHECK" --cache-dir/);
    expect(code).toMatch(/if: failure\(\) && steps\.drift\.outcome != 'failure'\n\s+run: node scripts\/drift\.mjs failure/);
    const runs = [...code.matchAll(/run: (.+)/g)].map((m) => m[1]);
    expect(runs.every((r) => r.startsWith('node scripts/drift.mjs'))).toBe(true);
  });

  it('installs nothing: drift.mjs needs no npm package', () => {
    expect(code).not.toMatch(/npm (ci|install)/);
    const imports = [...script.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => !i.startsWith('.') && !i.startsWith('node:'))).toEqual([]);
  });
});
