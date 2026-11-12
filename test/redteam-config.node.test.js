// @ts-check
// Phase 7 red team (docs/evidence/phase7/redteam.md), findings L-2 and L-3: the deploy reads
// wrangler.jsonc with regexes.
//
// L-2: scripts/deploy.mjs wranglerVars matches `"vars"\s*:\s*(\{[^{}]*\})`. A var whose value is an
// object (wrangler accepts JSON values in `vars`) has a `{` inside, so the regex matches nothing and
// wranglerVars answers {}: the preflight's "vars" check then says "only DENSE_BACKEND" while the
// Worker ships every var, test-only switches included.
//
// L-3: scripts/d1-read.mjs d1Config takes the first `database_id` in `d1_databases`, whatever its
// binding. With a second D1 listed first, the guard, rollback's data check and d1:restore's re-read
// all read that database, while the Worker's DB binding is the other one.
//
// Temp files only. `it.fails`: each case asserts the safe behaviour.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { d1Config } from '../scripts/d1-read.mjs';
import { wranglerVars } from '../scripts/deploy.mjs';
import { ALLOWED_VARS } from '../scripts/preflight.mjs';

/** @type {string} */
let dir;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vnm-redteam-config-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('red team L-2: an object-valued var hides every var from the preflight', () => {
  it.fails('the vars check sees TEST_FAKE_AI next to an object-valued var', async () => {
    const path = join(dir, 'wrangler.jsonc');
    writeFileSync(path, `{
  "name": "nusmodfinder",
  "vars": { "DENSE_BACKEND": "bundle", "TEST_FAKE_AI": "1", "LIMITS": { "perMinute": 30 } },
}
`);
    const vars = await wranglerVars(path);
    // The preflight's own test: keys outside ALLOWED_VARS fail it.
    const extra = Object.keys(vars).filter((k) => !ALLOWED_VARS.includes(k));
    // Observed: vars is {}, extra is [], so the check passes with "only DENSE_BACKEND".
    expect(extra).toContain('TEST_FAKE_AI');
  });
});

describe('red team L-3: the guard reads the first D1 database listed, not the DB binding', () => {
  it.fails('d1Config answers the DB binding\'s database when another is listed first', async () => {
    const path = join(dir, 'wrangler.jsonc');
    writeFileSync(path, `{
  "d1_databases": [
    { "binding": "ANALYTICS", "database_name": "nusmods-analytics", "database_id": "11111111-1111-1111-1111-111111111111" },
    { "binding": "DB", "database_name": "nusmods-apac", "database_id": "de4527ff-19ec-4a5b-9c5c-4d1791078b25" }
  ],
}
`);
    // Observed: { databaseName: 'nusmods-analytics', databaseId: '1111…' }.
    expect(await d1Config(path)).toEqual({ databaseName: 'nusmods-apac', databaseId: 'de4527ff-19ec-4a5b-9c5c-4d1791078b25' });
  });
});
