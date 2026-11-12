// @ts-check
// Findings that are properties of the source, the docs or the committed data
// rather than of a request: the README, the eval scripts and the NG list. The
// frontend findings read the frozen Phase 4 page in frontend.node.test.js.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ACAD_YEAR } from '../../scripts/lib.mjs';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const exists = (/** @type {string} */ rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

// The Worker source, all modules (src/index.js is only the router since Phase 1).
const worker = readdirSync(fileURLToPath(new URL('../../src', import.meta.url)))
  .filter((f) => f.endsWith('.js')).sort().map((f) => read(`src/${f}`)).join('\n');
const readme = read('docs/REFERENCE.md');
const ngList = JSON.parse(read(`data/ng-courses-${DEFAULT_ACAD_YEAR}.json`));

describe('ops', () => {
  it('[O1 fixed] the README rebuilds the schema from migrations/, which start at 0001 and include ng in the metadata loop', () => {
    expect(exists('schema.sql')).toBe(false);
    for (const f of ['0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql']) expect(exists(`migrations/${f}`)).toBe(true);
    expect(readme).toContain('npx wrangler d1 migrations apply nusmods-apac --local');
    expect(readme).toContain('ng:boolean; do');
    expect(JSON.parse(read('package.json')).scripts['db:rebuild-check']).toBe('node scripts/schema-snapshot.mjs');
  });

  it('[O2 fixed] lint, typecheck, tests and the schema rebuild run in CI', () => {
    const ci = read('.github/workflows/ci.yml');
    for (const step of ['npm run lint', 'npm run typecheck', 'npm run types:check', 'npm test', 'npm run db:rebuild-check']) {
      expect(ci).toContain(`run: ${step}`);
    }
    // Phase 7 7A: the eval gate.
    expect(ci).toContain('run: npm run eval:lock -- --check --base');
  });

  it('[O3 fixed] the NG list date has one source: ingest posts it from data/ng-courses-*.json, no copy is kept by hand', () => {
    expect(worker).not.toContain('NG_LIST_UPDATED');
    expect(worker).not.toContain(ngList.updatedAsAt);
    expect(readme).not.toContain('NG_LIST_UPDATED');
    const ingest = read('scripts/ingest.mjs');
    // The payload is built by scripts/lib.mjs facetsPayload (unit-tested in
    // test/facets-payload.node.test.js) and posted by the ingest core on every
    // run that gets past its guards (test/ingest.test.js drives it).
    expect(ingest).toContain('const facetsBody = facetsPayload(ngCourses);');
    expect(ingest).toContain('runIngest({ modules, facetsBody,');
    const core = read('scripts/ingest-core.mjs');
    expect(core.match(/send\('\/admin\/facets', facetsBody, 'facets'\)/g)).toHaveLength(1);
  });

  it('[O4 known-bug] wrangler.jsonc declares no cron trigger', () => {
    expect(read('wrangler.jsonc')).not.toMatch(/"triggers"|"crons"/);
  });

  it('[B9 fixed] REFERENCE names the binding limit with its arithmetic (Vectorize queried dims before 3-0; since 3-0, Workers CPU or the account\'s shared Workers AI neurons), and states the per-search D1 rows read measured with SC7', () => {
    expect(readme).not.toContain('D1 row reads are the binding constraint');
    const cost = readme.slice(readme.indexOf('## Cost'), readme.indexOf('## Data source')).replace(/\s+/g, ' ');
    // FINDINGS B9, on Workers Paid (ADR 0004): 50,000,000 queried dims/month,
    // billed as (stored vectors + queries) x 384. It bound until 3-0 took
    // Vectorize off the search path; the Cost section keeps the arithmetic as history.
    const vectorizePerMonth = 50_000_000 / 384 - 6771;
    expect(Math.round(vectorizePerMonth / 100) * 100).toBe(123400);
    expect(cost).toContain('50,000,000 / 384 − 6,771 ≈ **123,400 uncached searches a month**');
    expect(cost).toContain(`about ${(Math.round(vectorizePerMonth / 30 / 100) * 100).toLocaleString('en-US')} a day`);
    expect(cost).toContain('**Since 3-0, Vectorize is off the search path, so the binding limit is Workers CPU or Workers AI neurons');
    // Since 3-0: CPU, 30M CPU-ms/month at the ~12 ms a request measured after the cutover; or
    // Workers AI, 10k neurons/day shared by the account, at 0.033 a search (0.066 with a 3C
    // correction). The month's busiest day left other projects ~2,500 (Phase 8 plan §1).
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
    // Per-search D1 rows read are Phase 3's counted SC7 run on production, as its evidence states them.
    const sc7 = read('docs/evidence/phase3/sc7.md').replace(/\s+/g, ' ');
    expect(sc7).toContain('**Rows read per search:** p50 255, max 1,403. Unfiltered searches have a p50 of 240 and filtered ones 613.5.');
    expect(cost).toMatch(/\| D1 rows read \|[^|]*\| per search, Phase 3's SC7 run on production: p50 255, max 1,403; unfiltered p50 240, filtered p50 613\.5 \(\[`sc7\.md`\]\(evidence\/phase3\/sc7\.md\)\)/);
  });
});

describe('eval (S1)', () => {
  it('[S1 fixed] the eval gate\'s lists come from eval/dev (v2, judged qrels) and the fixture, never from eval/v1/', async () => {
    const { LOCK_INPUTS, LOCK_PATH, SEEDS } = await import('../../eval/lib/ranking-lock.mjs');
    const lock = JSON.parse(read(LOCK_PATH));
    expect(Object.keys(lock.lists).sort()).toEqual(['dev', 'fixture']);
    expect(SEEDS.dev.dir).toBe('eval/dev');
    expect(SEEDS.fixture.dir).toBe('eval/fixtures');
    // Every dev query in each mode, and nothing else: the v2 set, judged.
    const dev = JSON.parse(read('eval/dev/queries.json')).queries.map((/** @type {{ id: string }} */ q) => q.id).sort();
    for (const mode of ['filtered', 'strip-ng', 'unfiltered']) expect(Object.keys(lock.lists.dev[mode]).sort()).toEqual(dev);
    expect(JSON.parse(read('eval/dev/qrels.json')).version).toMatch(/^qrels-dev-v\d+$/);
    const v1 = JSON.parse(read('eval/v1/queries.json')).queries.map((/** @type {{ id: string }} */ q) => q.id);
    for (const id of v1) expect(dev).not.toContain(id);
    expect(LOCK_INPUTS.some((/** @type {string} */ p) => p.startsWith('eval/v1'))).toBe(false);
  });
});

describe('data', () => {
  /** @type {Map<string, number[]>} */
  const bySem = new Map();
  for (const [sem, list] of Object.entries(/** @type {Record<string, string[]>} */ (ngList.semesters))) {
    for (const code of list) bySem.set(code, [...(bySem.get(code) ?? []), Number(sem)]);
  }

  it('[P1 evidence] 934 of the 1,207 NG courses are open to exchange students in one semester only', () => {
    expect(bySem.size).toBe(1207);
    expect([...bySem.values()].filter((s) => s.length === 1)).toHaveLength(934);
  });

  it('[P2 evidence] 28 NG courses are level 5 or above', () => {
    const grad = [...bySem.keys()].filter((c) => Number(c.match(/\d/)?.[0]) >= 5);
    expect(grad).toHaveLength(28);
    expect(grad).toEqual(expect.arrayContaining(['LI5202', 'LI5204', 'PP5288']));
  });
});
