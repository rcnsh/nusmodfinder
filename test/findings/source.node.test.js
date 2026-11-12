// @ts-check
// Findings that are properties of the source, the docs or the committed data
// rather than of a request: the README, the eval scripts and the NG list. The
// frontend findings read the frozen Phase 4 page in frontend.node.test.js.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (/** @type {string} */ rel) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');
const exists = (/** @type {string} */ rel) => existsSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)));

// The Worker source, all modules (src/index.js is only the router since Phase 1).
const worker = readdirSync(fileURLToPath(new URL('../../src', import.meta.url)))
  .filter((f) => f.endsWith('.js')).sort().map((f) => read(`src/${f}`)).join('\n');
const readme = read('docs/REFERENCE.md');
const ngList = JSON.parse(read('data/ng-courses-2026-2027.json'));

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

  it('[B9 fixed] README names the binding limit with its arithmetic (Vectorize queried dims before 3-0; since 3-0, Workers CPU, the smaller of CPU and neurons, B2-8), and states the per-search D1 rows read measured with SC7', () => {
    expect(readme).not.toContain('D1 row reads are the binding constraint');
    const cost = readme.slice(readme.indexOf('## Cost'), readme.indexOf('## Data source'));
    // FINDINGS B9, on Workers Paid (ADR 0004): 50,000,000 queried dims/month,
    // billed as (stored vectors + queries) x 384. It bound until 3-0 took
    // Vectorize off the search path; the README keeps the arithmetic.
    const vectorizePerMonth = 50_000_000 / 384 - 6771;
    expect(Math.round(vectorizePerMonth / 100) * 100).toBe(123400);
    expect(cost).toContain('50,000,000 / 384 − 6,771 ≈ **123,400 uncached searches a month**');
    expect(cost).toContain(`about ${(Math.round(vectorizePerMonth / 30 / 100) * 100).toLocaleString('en-US')} a day`);
    expect(cost).toContain('**Since 3-0, Vectorize is off the search path, so the binding limit is Workers CPU or Workers AI\nneurons');
    // B2-8: the README names whichever is smaller. CPU: 30M CPU-ms/month at the ~12 ms a
    // request measured after the 3-0 cutover; neurons: 10k/day at ~0.03 a search (~0.05 after 3A-1).
    expect(30_000_000 / 12).toBe(2_500_000);
    expect(Math.round((10_000 * 30) / 0.03 / 1e6)).toBe(10);
    expect(Math.round((10_000 * 30) / 0.05 / 1e6)).toBe(6);
    expect(cost).toContain('**CPU is the smaller limit.**');
    expect(cost).toContain('30M\nCPU-ms cover **~2.5M searches a month**');
    expect(cost).toContain('**30,000,000 ms / month**');
    expect(cost).toContain('25,000,000,000 / month');
    // Per-search D1 numbers after Phase 1 are measured, not invented.
    expect(cost).toMatch(/\| D1 rows read \|[^\n]*\| per search: unfiltered 137–239 \(median 239\), filtered 249–1,784 \(median 497\), measured on 36 production searches with SC7 \(\[`sc7\.md`\]\(evidence\/phase1\/sc7\.md\)/);
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

  it('[S1 known-bug] held-out relevance is a regex over titles, recall@10 ignores order, and hybrid MRR trails lexical', () => {
    const judge = read('eval/v1/judge-holdout.mjs');
    const rules = judge.match(/rule: \(m\) => [^\n]+/g) ?? [];
    expect(rules).toHaveLength(12);
    // 11 of 12 are a regex over the title; h1 is a department check.
    expect(rules.filter((r) => /^rule: \(m\) => \/.*\/i\.test\(m\.title\)/.test(r))).toHaveLength(11);

    const evalSrc = read('eval/v1/eval.mjs');
    expect(evalSrc).toContain("const K = Number(arg('k', fixture.k ?? 10));");
    expect(evalSrc).toContain('recall: h / q.relevant.length,');
    // Production returns 20 from a candidate depth of up to 50.
    expect(worker).toContain('const DEFAULT_TOPK = 20;');
    expect(worker).toContain('const MAX_TOPK = 50;');

    const evalMd = read('EVAL.md');
    expect(evalMd).toMatch(/MRR\s+0\.833\s+0\.674\s+0\.903\s+0\.820/);
    expect(evalMd).toContain('`ORDER BY rank` has not been re-run against these fixtures');
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
