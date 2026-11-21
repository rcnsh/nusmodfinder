// @ts-check
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVariant } from '../runner/run.mjs';
import { MODES, SEEDS, queryHash } from './ranking-lock.mjs';
import { layout } from './sets.mjs';

/**
 * @param {{ ref?: string, log?: (line: string) => void }} [o]
 * @returns {Promise<import('./ranking-lock.mjs').Computed & { resultsSha256: Record<string, string> }>}
 */
export async function computeLists(o = {}) {
  const log = o.log ?? ((/** @type {string} */ l) => console.log(l));
  const out = await mkdtemp(join(tmpdir(), 'vnm-lock-runs-'));
  try {
    /** @type {import('./ranking-lock.mjs').Lists} */
    const lists = {};
    /** @type {Record<string, string>} */
    const resultsSha256 = {};
    let embedding = '';
    /** @type {import('./ranking-lock.mjs').RankingLock['corpus']} */
    let corpus = { release: null, moduleInfoSha256: '' };
    for (const set of Object.keys(SEEDS)) {
      lists[set] = {};
      for (const [mode, opts] of Object.entries(MODES)) {
        const res = await runVariant({
          set: layout(set), variant: `lock-${mode}`, ref: o.ref,
          unfiltered: opts.unfiltered, strip: [...opts.strip],
          output: join(out, `${set}-${mode}.json`), log,
        });
        if (!res.ok) throw new Error(`the ${set} ${mode} run failed:\n  ${res.problems.join('\n  ')}`);
        /** @type {import('./metrics.mjs').RunFile} */
        const run = JSON.parse(await readFile(res.output, 'utf8'));
        lists[set][mode] = Object.fromEntries(Object.entries(run.results).map(([id, r]) => [id, queryHash(r.status, r.codes)]));
        resultsSha256[`${set} ${mode}`] = createHash('sha256').update(JSON.stringify(run.results)).digest('hex');
        if (set === 'dev') {
          const r = /** @type {any} */ (run);
          embedding = String(r.embedding?.corpus ?? '');
          corpus = { release: r.corpus?.release ?? null, moduleInfoSha256: String(r.corpus?.moduleInfoSha256 ?? '') };
        }
      }
    }
    return { embedding, corpus, lists, resultsSha256 };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}
