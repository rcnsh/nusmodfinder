// @ts-check
// Properties of the source, the docs and CI rather than of a request: the schema
// rebuild, the CI steps, where the NG list date comes from, the cost arithmetic in
// docs/cost.md and the eval gate's inputs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR } from '../../scripts/lib.mjs';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const exists = (/** @type {string} */ rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

// The Worker source, all modules (src/index.js is only the router).
const worker = readdirSync(fileURLToPath(new URL('../../src', import.meta.url)))
  .filter((f) => f.endsWith('.js')).sort().map((f) => read(`src/${f}`)).join('\n');
const operations = read('docs/operations.md');
const costDoc = read('docs/cost.md');
/** Every doc under docs/, for claims no doc may make. */
const allDocs = readdirSync(fileURLToPath(new URL('../../docs', import.meta.url)))
  .filter((f) => f.endsWith('.md')).map((f) => read(`docs/${f}`)).join('\n');
const ngList = JSON.parse(read(`data/ng-courses-${DEFAULT_ACAD_YEAR}.json`));

describe('ops', () => {
  it('the operations doc rebuilds the schema from migrations/, which start at 0001 and include ng in the metadata loop', () => {
    expect(exists('schema.sql')).toBe(false);
    for (const f of ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql']) expect(exists(`migrations/${f}`)).toBe(true);
    expect(operations).toContain('npx wrangler d1 migrations apply nusmods-apac --local');
    expect(operations).toContain('ng:boolean; do');
    expect(JSON.parse(read('package.json')).scripts['db:rebuild-check']).toBe('node scripts/schema-snapshot.mjs');
  });

  it('lint, typecheck, tests and the schema rebuild run in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const step of ['npm run lint', 'npm run typecheck', 'npm run types:check', 'npm test', 'npm run db:rebuild-check']) {
      expect(ci).toContain(`run: ${step}`);
    }
    // The eval gate.
    expect(ci).toContain('run: npm run eval:lock -- --check --base');
  });

  it('the NG list date has one source: ingest posts it from data/ng-courses-*.json, no copy is kept by hand', () => {
    expect(worker).not.toContain('NG_LIST_UPDATED');
    expect(worker).not.toContain(ngList.updatedAsAt);
    expect(allDocs).not.toContain('NG_LIST_UPDATED');
    const ingest = read('scripts/ingest.mjs');
    // The payload is built by scripts/lib.mjs facetsPayload (unit-tested in
    // test/facets-payload.node.test.js) and posted by the ingest core on every
    // run that gets past its guards (test/ingest.test.js drives it).
    expect(ingest).toContain('const facetsBody = facetsPayload(ngCourses);');
    expect(ingest).toContain('runIngest({ modules, facetsBody,');
    const core = read('scripts/ingest-core.mjs');
    expect(core.match(/send\('\/admin\/facets', facetsBody, 'facets'\)/g)).toHaveLength(1);
  });

  it('wrangler.jsonc declares no cron trigger: scheduled checks run in GitHub Actions', () => {
    expect(read('wrangler.jsonc')).not.toMatch(/"triggers"|"crons"/);
  });

  it('docs/cost.md states the binding limit (Workers CPU or the account\'s shared Workers AI neurons) with its arithmetic, and the per-search D1 rows read', () => {
    expect(allDocs).not.toContain('D1 row reads are the binding constraint');
    const cost = costDoc.replace(/\s+/g, ' ');
    // CPU, 30M CPU-ms/month at the ~12 ms a request measured live; or Workers AI, 10k
    // neurons/day shared by the account, at 0.033 a search (0.066 when the typo step
    // corrects a word). Other projects used ~2,500 on the month's busiest day.
    expect(30_000_000 / 12).toBe(2_500_000);
    expect(Math.floor(10_000 / 0.066 / 10_000) * 10_000).toBe(150_000);
    expect(Math.floor(10_000 / 0.033 / 100_000) * 100_000).toBe(300_000);
    expect(((10_000 * 30) / 0.066 / 1e6).toFixed(1)).toBe('4.5');
    expect(Math.floor((10_000 * 30) / 0.033 / 1e6)).toBe(9);
    expect(Math.floor((10_000 - 2_500) / 0.066 / 10_000) * 10_000).toBe(110_000);
    expect(cost).toContain('**The limit is CPU or the shared neurons.**');
    expect(cost).toContain('30M CPU-ms cover **~2.5M searches a month**');
    expect(cost).toContain('150,000 to 300,000 uncached searches a day (4.5M to 9M a month) at 0.066 to 0.033 each');
    expect(cost).toContain('about 110,000 uncached searches fit beside other projects\' ~2,500');
    expect(cost).toContain('**30,000,000 ms / month**');
    expect(cost).toContain('25,000,000,000 / month');
    // Per-search D1 rows read, as counted on production.
    expect(cost).toMatch(/\| D1 rows read \|[^|]*\|[^|]*p50 255, max 1,403; unfiltered p50 240, filtered p50 613\.5/);
  });
});

describe('eval', () => {
  it('the eval gate\'s lists come from eval/dev (judged qrels) and the fixture', async () => {
    const { LOCK_PATH, SEEDS } = await import('../../eval/lib/ranking-lock.mjs');
    const lock = JSON.parse(read(LOCK_PATH));
    expect(Object.keys(lock.lists).sort()).toEqual(['dev', 'fixture']);
    expect(SEEDS.dev.dir).toBe('eval/dev');
    expect(SEEDS.fixture.dir).toBe('eval/fixtures');
    // Every dev query in each mode, and nothing else.
    const dev = JSON.parse(read('eval/dev/queries.json')).queries.map((/** @type {{ id: string }} */ q) => q.id).sort();
    for (const mode of ['filtered', 'strip-ng', 'unfiltered']) expect(Object.keys(lock.lists.dev[mode]).sort()).toEqual(dev);
    expect(JSON.parse(read('eval/dev/qrels.json')).version).toMatch(/^qrels-dev-v\d+$/);
  });
});
