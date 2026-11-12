// @ts-check
// The year-refresh runbook (docs/year-refresh/) and `year next`'s checklist name only
// commands that exist, with flags their scripts take, and name one secret: the sources key's
// backup in Bitwarden Secrets Manager.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKLIST } from '../scripts/year.mjs';
import { REPO } from './year-fakes.node.mjs';

const DIR = 'docs/year-refresh';
const docs = readdirSync(join(REPO, DIR)).filter((f) => f.endsWith('.md')).map((f) => ({ file: `${DIR}/${f}`, text: readFileSync(join(REPO, DIR, f), 'utf8') }));
const scripts = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).scripts;
const read = (/** @type {string} */ rel) => readFileSync(join(REPO, rel), 'utf8');

/** `npm run remote -- <command>` runs scripts/<command>.mjs (scripts/remote.mjs). */
const REMOTE = { ingest: 'scripts/ingest.mjs', verify: 'scripts/verify.mjs', vectors: 'scripts/vectors.mjs' };

/**
 * Each command in a text, with the file that parses its flags.
 * @param {string} text
 * @returns {{ cmd: string, file: string | null, problem?: string, flags: string[] }[]}
 */
function commands(text) {
  const out = [];
  const re = /(npm run [a-z0-9:-]+(?: -- [^`\n;]*)?|node scripts\/[\w./-]+[^`\n;]*|python3 scripts\/[\w./-]+[^`\n;]*)/g;
  for (const m of text.matchAll(re)) {
    const cmd = m[1].replace(/\s+#.*$/, '').trim().replace(/[.,:]$/, '');
    const flags = [...cmd.matchAll(/(?:^|\s)--([a-z][a-z0-9-]*)/g)].map((f) => f[1]);
    const npm = /^npm run ([a-z0-9:-]+)(?: -- (\S+))?/.exec(cmd);
    if (npm) {
      const script = scripts[npm[1]];
      if (!script) { out.push({ cmd, file: null, problem: `no npm script ${npm[1]}`, flags }); continue; }
      const file = /node (scripts\/\S+\.mjs)/.exec(script)?.[1] ?? null;
      if (npm[1] === 'remote' && npm[2]) {
        const target = REMOTE[/** @type {keyof typeof REMOTE} */ (npm[2])];
        out.push(target ? { cmd, file: target, flags } : { cmd, file: null, problem: `npm run remote runs no ${npm[2]} here`, flags });
      } else out.push({ cmd, file, flags });
      continue;
    }
    const file = /^(?:node|python3) (scripts\/[\w./-]+)/.exec(cmd)?.[1] ?? null;
    out.push(file && existsSync(join(REPO, file)) ? { cmd, file, flags } : { cmd, file: null, problem: `no ${file}`, flags });
  }
  return out;
}

/** Whether a script parses a flag. @param {string} file @param {string} flag */
const takes = (file, flag) => {
  const src = read(file);
  return [`'${flag}'`, `"${flag}"`, `--${flag}`, `${flag}:`, `'${flag}':`].some((s) => src.includes(s));
};

describe('docs/year-refresh/', () => {
  it('has the runbook and its four briefs', () => {
    expect(docs.map((d) => d.file).sort()).toEqual(['README.md', 'brief-oracle.md', 'brief-transcription.md', 'overlay.md', 'register.md'].map((f) => `${DIR}/${f}`).sort());
  });

  it('names only commands that exist, with flags their scripts take', () => {
    /** @type {string[]} */
    const bad = [];
    let n = 0;
    for (const { file: doc, text } of [...docs, { file: 'CHECKLIST (scripts/year.mjs)', text: CHECKLIST('2099-2100') }]) {
      for (const c of commands(text)) {
        n++;
        if (c.problem) { bad.push(`${doc}: ${c.cmd}: ${c.problem}`); continue; }
        if (!c.file) continue;
        for (const f of c.flags) if (!takes(c.file, f)) bad.push(`${doc}: ${c.cmd}: ${c.file} takes no --${f}`);
      }
    }
    expect(bad).toEqual([]);
    expect(n).toBeGreaterThan(30);
  });

  it('gives the year switch\'s write budget and every step the plan names', () => {
    const runbook = read(`${DIR}/README.md`);
    for (const s of ['npm run year -- next', 'npm run sources -- publish', 'npm run year -- check --full', 'npm run deploy -- --preflight', 'npm run d1:bookmark',
      'npm run remote -- ingest --d1-only --allow-year-change --write-budget 80000', 'npm run remote -- verify --pre-deploy', 'npm run deploy', 'npm run smoke',
      'npm run remote -- vectors standby', 'npm run d1:restore', 'npm run rollback', 'npm run smoke -- --expect', 'npm run corpus -- fetch', 'npm run corpus -- publish',
      'npm run sources -- restore']) expect(runbook, s).toContain(s);
  });

  it('names one secret, the sources key\'s backup, and the key path is never the holdout key\'s', () => {
    const all = docs.map((d) => d.text).join('\n');
    expect(all).toContain('Bitwarden\nSecrets Manager as `nusmodfinder/sources-archive-key` (project `apps`)');
    expect([...new Set([...all.matchAll(/nusmodfinder\/[\w-]+/g)].map((m) => m[0]))]).toEqual(['nusmodfinder/sources-archive-key']);
    expect(all.match(/\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b/g)).toBeNull();
    expect(all).not.toMatch(/holdout\.key|custodian/);
    expect([...new Set(read('scripts/sources.mjs').match(/nusmodfinder\/[\w-]+/g))]).toEqual(['nusmodfinder/sources-archive-key']);
  });
});
