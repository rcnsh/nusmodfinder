// @ts-check
// Custom Vitest reporter: the only way results leave workerd. Reads each test's
// task.meta.vnmEval, and at the end of the run writes the run file — plain
// JSON for dev/fixture, AES-256-GCM ciphertext only for holdout/test. Missing
// embedding texts go to .eval-work/missing-<set>.json(.enc) for eval:embed.
// For encrypted sets nothing per-query is printed (ids, errors or counts).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeEncryptedJson } from '../lib/crypto.mjs';

/**
 * @typedef {import('vitest/node').Reporter} Reporter
 * @typedef {import('vitest/node').TestCase} TestCase
 * @typedef {import('vitest/node').TestModule} TestModule
 */

/**
 * @typedef {{
 *   output: string,
 *   missingOutput: string,
 *   key: Buffer | null,
 *   header: Record<string, unknown>,
 *   expectedIds: string[],
 *   log?: (line: string) => void,
 * }} EvalReporterOptions
 */

/** @implements {Reporter} */
export class EvalReporter {
  /** @type {Map<string, EvalQueryResult>} */
  results = new Map();
  /** @type {{ id: string, message: string }[]} */
  failures = [];
  /** @type {string[]} */
  missing = [];
  /** @type {{ ok: boolean, written: string | null, problems: string[] } | null} */
  outcome = null;

  /** @param {EvalReporterOptions} options */
  constructor(options) {
    this.options = options;
    this.log = options.log ?? ((/** @type {string} */ l) => console.log(l));
  }

  /** @param {TestCase} testCase */
  onTestCaseResult(testCase) {
    const meta = /** @type {{ vnmEval?: EvalQueryResult }} */ (testCase.meta()).vnmEval;
    const id = testCase.name;
    if (meta) {
      this.results.set(id, meta);
      this.missing.push(...meta.missing);
    }
    const result = testCase.result();
    if (result.state === 'failed') {
      this.failures.push({ id, message: result.errors?.[0]?.message ?? 'failed' });
    }
  }

  /**
   * @param {ReadonlyArray<TestModule>} modules
   * @param {ReadonlyArray<unknown>} unhandled
   */
  async onTestRunEnd(modules, unhandled) {
    const { output, missingOutput, key, header, expectedIds } = this.options;
    const encrypted = key !== null;
    /** @type {string[]} */
    const problems = [];
    for (const m of modules) {
      for (const e of m.errors()) problems.push(`module error: ${encrypted ? '(hidden)' : e.message}`);
    }
    if (unhandled.length) problems.push(`${unhandled.length} unhandled error(s)`);
    const absent = expectedIds.filter((id) => !this.results.has(id));
    if (absent.length) problems.push(`${absent.length} of ${expectedIds.length} queries produced no result`);
    if (this.failures.length) {
      problems.push(`${this.failures.length} query test(s) failed`);
      if (!encrypted) for (const f of this.failures.slice(0, 20)) problems.push(`  ${f.id}: ${f.message}`);
    }

    if (this.missing.length) {
      const unique = [...new Set(this.missing)];
      const file = { schema: 'vnm-eval-missing/1', texts: unique };
      await mkdir(dirname(missingOutput), { recursive: true });
      if (key) await writeEncryptedJson(missingOutput, file, key);
      else await writeFile(missingOutput, `${JSON.stringify(file, null, 1)}\n`);
      problems.push(`${unique.length} text(s) without a precomputed embedding, listed in ${missingOutput}; run \`npm run eval:embed\` locally`);
    }

    if (problems.length) {
      this.outcome = { ok: false, written: null, problems };
      return;
    }

    /** @type {Record<string, { status: number, codes: string[], error?: string }>} */
    const results = {};
    /** @type {Record<string, EvalDocMeta>} */
    const docs = {};
    for (const id of expectedIds) {
      const r = /** @type {EvalQueryResult} */ (this.results.get(id));
      results[id] = { status: r.status, codes: r.codes, ...(r.error ? { error: r.error } : {}) };
      Object.assign(docs, r.docs);
    }
    const sortedDocs = Object.fromEntries(Object.entries(docs).sort(([a], [b]) => a.localeCompare(b)));
    const run = { ...header, results, docs: sortedDocs };
    await mkdir(dirname(output), { recursive: true });
    if (key) await writeEncryptedJson(output, run, key);
    else await writeFile(output, `${JSON.stringify(run, null, 1)}\n`);
    this.outcome = { ok: true, written: output, problems: [] };
  }
}
