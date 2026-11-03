// @ts-check
// Phase 2c item 3: ONE Workers AI REST request re-embedding 20 dev query texts
// (raw form, as eval-v0 embeds them) that `npm run eval:embed -- --set dev`
// already embedded in batches of 100. The difference is pure Workers AI
// nondeterminism (same model, same text, different batch). Logs the spend to
// docs/evidence/neurons.tsv like scripts/embed.mjs; the token comes from
// `wrangler auth token` and is never stored or printed. Refuses to run twice.
//
//   node docs/evidence/phase2/reembed.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIMS, MODEL, estimateTokens, f32ToBase64, neuronsFor } from '../../../eval/lib/embeddings.mjs';
import { REPO } from '../../../eval/lib/sets.mjs';
import { FIDELITY_IDS, REEMBED_EXTRA_IDS } from './ids.mjs';

const OUT = join(REPO, 'docs/evidence/phase2/reembed-20.json');
if (existsSync(OUT)) throw new Error(`${OUT} exists; this request is made once`);
const ids = [...FIDELITY_IDS, ...REEMBED_EXTRA_IDS];
if (ids.length !== 20) throw new Error(`expected 20 ids, got ${ids.length}`);
const queries = JSON.parse(await readFile(join(REPO, 'eval/dev/queries.json'), 'utf8')).queries;
const texts = ids.map((id) => {
  const q = queries.find((/** @type {any} */ x) => x.id === id);
  if (!q) throw new Error(`no dev query ${id}`);
  return q.text;
});
const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
const neurons = neuronsFor(tokens);
console.log(`re-embed: ${texts.length} texts, ~${tokens} tokens, ~${neurons.toFixed(2)} neurons, 1 request`);

const bin = join(REPO, 'node_modules/.bin/wrangler');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false' };
const tok = spawnSync(bin, ['auth', 'token', '--json'], { cwd: tmpdir(), env, encoding: 'utf8' });
if (tok.status !== 0) throw new Error('`wrangler auth token` failed');
const token = JSON.parse(tok.stdout).token;
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!account) {
  const who = spawnSync(bin, ['whoami', '--json'], { cwd: tmpdir(), env, encoding: 'utf8' });
  const accounts = JSON.parse(who.stdout).accounts ?? [];
  if (accounts.length !== 1) throw new Error(`${accounts.length} accounts; set CLOUDFLARE_ACCOUNT_ID`);
  account = accounts[0].id;
}

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${MODEL}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ text: texts }),
});
const body = /** @type {any} */ (await res.json().catch(() => null));
await appendFile(join(REPO, 'docs/evidence/neurons.tsv'),
  `${new Date().toISOString()}\treembed\t${texts.length}\t${tokens}\t${neurons.toFixed(1)}\t1\tphase2/baseline 2c item 3: 20 dev query texts re-embedded once (HTTP ${res.status})\n`);
if (!res.ok || !body?.success) throw new Error(`Workers AI HTTP ${res.status}: ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
const data = body.result?.data;
if (!Array.isArray(data) || data.length !== texts.length || data.some((v) => v.length !== DIMS)) throw new Error('bad response shape');
const out = {
  schema: 'vnm-phase2-reembed/1',
  model: MODEL,
  createdAt: new Date().toISOString(),
  note: 'raw dev query texts re-embedded in one request of 20; compare with eval/dev/embeddings.json (batches of 100)',
  vectors: Object.fromEntries(ids.map((id, i) => [id, f32ToBase64(Float32Array.from(data[i]))])),
};
await writeFile(OUT, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${OUT}`);
