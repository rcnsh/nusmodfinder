// Phase 3: fetch a NUSMods acad year, embed every offered module, and write it
// to D1 + Vectorize.
//
//   npm run ingest -- --year 2026-2027 --url http://localhost:8787
//
// Embedding and upserting happen inside the Worker (POST /admin/ingest), which
// already holds the AI, Vectorize and D1 bindings — so no Cloudflare API token
// needs to exist on disk. The 19 MB moduleInfo.json is parsed here, locally,
// never in a Worker (landmine L2). Requires INGEST_SECRET on both sides.
import { facetsPayload, DEFAULT_ACAD_YEAR, fetchAcadYearFile, assertExpectedShape, offeredModules, loadNgCourses } from './lib.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const has = (name) => process.argv.includes(`--${name}`);

const acadYear = arg('year', DEFAULT_ACAD_YEAR);
const base = (arg('url', process.env.WORKER_URL) ?? 'http://localhost:8787').replace(/\/$/, '');
const secret = process.env.INGEST_SECRET;
const batchSize = Number(arg('batch', 50));
const concurrency = Number(arg('concurrency', 4));
const force = has('force');

if (!secret) {
  console.error('INGEST_SECRET is not set. Export the same value the Worker is bound to.');
  process.exit(1);
}

const auth = { authorization: `Bearer ${secret}`, 'content-type': 'application/json' };

const info = await fetchAcadYearFile(acadYear, 'moduleInfo.json');
assertExpectedShape(info.data);
const ngCourses = await loadNgCourses(acadYear);
const { modules, skipped } = offeredModules(info.data, acadYear, ngCourses);

console.log(`acad year          ${acadYear}`);
console.log(`source             ${info.url} (${(info.bytes / 1e6).toFixed(1)} MB, ${info.cached ? 'from .data cache' : 'freshly fetched'})`);
console.log(`catalogue records  ${info.data.length}`);
console.log(`offered & usable   ${modules.length}`);
// R2: a record missing a title or description is skipped by code, not dropped silently.
console.log(`skipped            ${skipped.length}${skipped.length ? ` (${skipped.slice(0, 10).map((s) => `${s.code}: ${s.why}`).join('; ')})` : ''}`);
if (ngCourses.available) {
  const matched = modules.filter((m) => m.ng).length;
  const orphans = ngCourses.total - matched;
  console.log(`NG list            ${ngCourses.total} codes (updated ${ngCourses.updatedAsAt}); ${matched} matched this corpus, ${orphans} not offered this year`);
} else {
  console.log(`NG list            ABSENT — run scripts/extract-ng.py first, or every module will be marked not-NG`);
}

// /admin/facets also records where the NG list came from, so /facets reports
// the date in data/ng-courses-*.json rather than a hand-kept copy (O3).
const facetsBody = JSON.stringify(facetsPayload(ngCourses));

// Resumability (L5): ask D1 what it already has and re-embed only what changed.
let existing = {};
if (!force) {
  const res = await fetch(`${base}/admin/hashes`, { headers: auth });
  if (!res.ok) {
    console.error(`GET ${base}/admin/hashes -> HTTP ${res.status}. Is the Worker running with INGEST_SECRET bound?`);
    process.exit(1);
  }
  existing = await res.json();
}
const todo = modules.filter((m) => force || existing[m.code] !== m.textHash);
console.log(`already current    ${modules.length - todo.length}`);
console.log(`to embed           ${todo.length}`);
console.log();

if (todo.length === 0) {
  console.log('Nothing to do — every module is already indexed at its current text hash.');
  const res = await fetch(`${base}/admin/facets`, { method: 'POST', headers: auth, body: facetsBody }).catch(() => null);
  console.log(res?.ok ? 'facets rebuilt.' : 'facets rebuild skipped/failed.');
  process.exit(0);
}

const batches = [];
for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));

let done = 0;
let failed = 0;
const started = Date.now();

async function sendBatch(batch, attempt = 1) {
  const res = await fetch(`${base}/admin/ingest`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ modules: batch }),
  });
  if (res.ok) return;
  const body = await res.text();
  // Workers AI throttles under load; back off rather than losing the batch.
  if (attempt < 5 && (res.status === 429 || res.status >= 500)) {
    const wait = 2 ** attempt * 1000;
    process.stderr.write(`\n  batch ${batch[0].code}…: HTTP ${res.status}, retrying in ${wait / 1000}s\n`);
    await new Promise((r) => setTimeout(r, wait));
    return sendBatch(batch, attempt + 1);
  }
  failed += batch.length;
  process.stderr.write(`\n  batch ${batch[0].code}… FAILED after ${attempt} attempts: HTTP ${res.status} ${body.slice(0, 300)}\n`);
}

const queue = batches.slice();
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) {
    const batch = queue.shift();
    await sendBatch(batch);
    done += batch.length;
    const pct = ((done / todo.length) * 100).toFixed(1);
    const rate = done / ((Date.now() - started) / 1000);
    process.stdout.write(`\r  ${done}/${todo.length} (${pct}%)  ${rate.toFixed(0)}/s  failed ${failed}   `);
  }
}));

console.log('\n');

// Rebuild the precomputed facet row so /facets stays one row read per request
// instead of three full-table aggregates.
try {
  const res = await fetch(`${base}/admin/facets`, { method: 'POST', headers: auth, body: facetsBody });
  const body = await res.json().catch(() => ({}));
  console.log(res.ok
    ? `facets rebuilt      ${body.faculties} faculties, ${body.levels} levels, ${body.ng} NG (list updated ${body.ngListUpdatedAsAt})`
    : `facets rebuild FAILED (HTTP ${res.status}) — /facets will fall back to live aggregates`);
} catch (err) {
  console.log(`facets rebuild FAILED (${err.message})`);
}

console.log(`embedded & upserted ${done - failed}`);
console.log(`failed              ${failed}`);
console.log(`elapsed             ${((Date.now() - started) / 1000).toFixed(0)}s`);
if (failed) {
  console.log('\nRerun the same command — resumability means only the failed modules are retried.');
  process.exit(1);
}
