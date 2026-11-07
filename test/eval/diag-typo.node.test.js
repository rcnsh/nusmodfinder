// @ts-check
// The dev-only 3C typo diagnostic (docs/plans/phase3.md 3C "Measured", A-N8):
// noise-model variants of clean dev queries in their own set directory,
// eval/diag/typo (`--set dev --set-dir eval/diag/typo`), so the locked dev
// files never change. Each variant's qrels are its source dev query's
// judgments. The directory's queries and qrels are checked against its
// MANIFEST.json on every read, and its report prints no verdict.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { build, DIAG_DIR, SEED, isSource, noisy } from '../../eval/diag/build-typo.mjs';
import { ManifestError } from '../../eval/lib/errors.mjs';
import { REPO, layout, loadQrels, loadQueries, validateQueries } from '../../eval/lib/sets.mjs';

const readJson = (/** @type {string} */ rel) => JSON.parse(readFileSync(join(REPO, rel), 'utf8'));
const dev = readJson('eval/dev/queries.json');
const devQrels = readJson('eval/dev/qrels.json');
const diag = readJson('eval/diag/typo/queries.json');
const diagQrels = readJson('eval/diag/typo/qrels.json');
const devById = new Map(dev.queries.map((/** @type {any} */ q) => [q.id, q]));

describe('eval/diag/typo', () => {
  it('is what eval/diag/build-typo.mjs builds from the dev set and its recorded seed', async () => {
    const out = await build();
    expect(readFileSync(join(REPO, DIAG_DIR, 'queries.json'), 'utf8')).toBe(out.queries);
    expect(readFileSync(join(REPO, DIAG_DIR, 'qrels.json'), 'utf8')).toBe(out.qrels);
    expect(readFileSync(join(REPO, DIAG_DIR, 'MANIFEST.json'), 'utf8')).toBe(out.manifest);
    expect(diag.seed).toBe(SEED);
  });

  it('holds one noise-model variant of each clean, answerable dev query, never equal to any dev text', () => {
    validateQueries(diag, 'eval/diag/typo/queries.json');
    expect(diag.diagnostic).toBe(true);
    const sources = dev.queries.filter((/** @type {any} */ q) => isSource(q, devQrels));
    expect(sources.length).toBeGreaterThanOrEqual(30);
    expect(diag.queries.map((/** @type {any} */ q) => q.source)).toEqual(sources.map((/** @type {any} */ q) => q.id));
    const devTexts = new Set(dev.queries.map((/** @type {any} */ q) => q.text));
    for (const q of diag.queries) {
      const src = devById.get(q.source);
      expect(q.id).toMatch(/^dt-\d{3}$/);
      expect(q.shapes).toEqual(['typo']);
      expect(q.origin).toBe('typo-diag');
      expect(q.filters).toEqual(src.filters);
      expect(devTexts.has(q.text), q.id).toBe(false);
      expect(q.text.split(' ').length).toBe(src.text.split(' ').length);
    }
  });

  it('applies the documented noise model: 1–2 edited words of 4+ letters, each one keyboard-adjacent substitution, transposition, deletion or doubling', () => {
    for (const q of diag.queries) {
      const a = devById.get(q.source).text.split(' ');
      const b = q.text.split(' ');
      const changed = a.map((/** @type {string} */ w, /** @type {number} */ i) => [w, b[i]]).filter(([w, v]) => w !== v);
      expect(changed.length, q.id).toBeGreaterThanOrEqual(1);
      expect(changed.length, q.id).toBeLessThanOrEqual(2);
      for (const [w, v] of changed) {
        expect(w, q.id).toMatch(/^[a-z]{4,}$/i);
        expect(Math.abs(w.length - v.length), q.id).toBeLessThanOrEqual(1);
      }
    }
    // The model itself, on a fixed word.
    expect(noisy(['learning'], () => 0.99).join(' ')).not.toBe('learning');
  });

  it('gives each variant its source dev query\'s judgments (qrels-dev, verbatim)', () => {
    expect(diagQrels.derivedFrom).toBe(devQrels.version);
    expect(diagQrels.corpus).toEqual(devQrels.corpus);
    expect(Object.keys(diagQrels.queries)).toEqual(diag.queries.map((/** @type {any} */ q) => q.id));
    for (const q of diag.queries) expect(diagQrels.queries[q.id], q.id).toEqual(devQrels.queries[q.source]);
  });

  it('README says how the qrels are derived, the noise model and the seed, and that it is never gated', () => {
    const readme = readFileSync(join(REPO, DIAG_DIR, 'README.md'), 'utf8');
    expect(readme).toMatch(/source dev query's judgments/);
    expect(readme).toContain(SEED);
    expect(readme).toMatch(/never gated/);
  });
});

describe('a plaintext set directory with a MANIFEST.json is checked against it', () => {
  it('reads eval/diag/typo through --set dev --set-dir', async () => {
    const set = layout('dev', join(REPO, DIAG_DIR));
    expect((await loadQueries(set)).queries.length).toBe(diag.queries.length);
    expect(Object.keys((await loadQrels(set)).queries).length).toBe(diag.queries.length);
  });

  it('refuses a tampered queries or qrels file', async () => {
    const dir = await mkdtemp(join(REPO, '.eval-work', 'diag-'));
    try {
      await cp(join(REPO, DIAG_DIR), dir, { recursive: true });
      const set = layout('dev', dir);
      const q = JSON.parse(await readFile(join(dir, 'queries.json'), 'utf8'));
      q.queries[0].text = 'something else entirely';
      await writeFile(join(dir, 'queries.json'), JSON.stringify(q));
      await expect(loadQueries(set)).rejects.toThrow(ManifestError);
      const r = JSON.parse(await readFile(join(dir, 'qrels.json'), 'utf8'));
      r.version = 'tampered';
      await writeFile(join(dir, 'qrels.json'), JSON.stringify(r));
      await expect(loadQrels(set)).rejects.toThrow(ManifestError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves a plaintext set without a manifest (eval/dev) as it was', async () => {
    expect((await loadQueries(layout('dev'))).queries.length).toBe(dev.queries.length);
  });
});

describe('the diagnostic report', () => {
  it('prints the tables and no verdict', async () => {
    const dir = await mkdtemp(join(REPO, '.eval-work', 'diag-report-'));
    try {
      await cp(join(REPO, DIAG_DIR), dir, { recursive: true });
      const sha = createHash('sha256').update(JSON.stringify(diag.queries)).digest('hex');
      for (const [variant, best] of /** @type {const} */ ([['base', false], ['cand', true]])) {
        /** @type {Record<string, { status: number, codes: string[] }>} */
        const results = {};
        for (const q of diag.queries) {
          const graded = Object.entries(diagQrels.queries[q.id].judgments)
            .map(([code, j]) => ({ code, g: Number(/** @type {any} */ (j).grade ?? j) }))
            .sort((x, y) => (best ? y.g - x.g : x.g - y.g) || x.code.localeCompare(y.code));
          results[q.id] = { status: 200, codes: graded.slice(0, 10).map((x) => x.code) };
        }
        await writeFile(join(dir, `${variant}.json`), JSON.stringify({
          schema: 'vnm-eval-run/1', variant, set: 'dev', ranker: { ref: 'synthetic', sha: '0'.repeat(40), dirty: false },
          corpus: { ...diagQrels.corpus }, queries: { version: diag.version, sha256: sha, count: diag.queries.length },
          config: { mode: 'hybrid', filters: true }, results, docs: {},
        }));
      }
      const r = spawnSync(process.execPath, [join(REPO, 'eval/cli.mjs'), 'report', '--set', 'dev', '--set-dir', dir,
        '--run', join(dir, 'cand.json'), '--baseline', join(dir, 'base.json')], { cwd: REPO, encoding: 'utf8' });
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/qrels qrels-diag-typo-v1/);
      expect(r.stdout).toContain('diagnostic set: reported, never gated (no verdict)');
      expect(r.stdout).not.toMatch(/^gate \(/m);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
