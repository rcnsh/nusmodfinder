// @ts-check
// Phase 7 7D: the Worker reports D1's catalogueKey (src/rowhash.js, over the
// catalogue_only codes) in GET /admin/hashes, the deploy guard's read, and in
// POST /admin/verify `{ preDeploy: true }`, the read of `verify --pre-deploy`,
// which refuses a key that is not the bundled catalogue file's.
import { describe, expect, it } from 'vitest';
import { runPreDeployVerify } from '../scripts/verify-core.mjs';
import { catalogueKey } from '../src/rowhash.js';
import { encodeBundle, parseBundle } from '../src/vector-bundle.js';
import manifest from '../data/vectors.json';
import { knownReason } from '../src/ng-reasons.js';
import ngReasons from '../data/ng-reasons.json';
import fixtureUnscheduled from './fixtures/ng-unscheduled.json';
import { hashEmbed } from './fakes.js';
import { adminCall, fixture, seed } from './helpers.js';
import { adminApi } from './ingest-support.js';

const CODES = ['ZZ1000', 'ZZ1001', 'ZZ1002'];
const YEAR = fixture.modules[0].acadYear;

/** Seeds the fixture and three catalogue_only rows. */
async function seeded() {
  const fakes = await seed();
  const res = await adminCall('/admin/catalogue', fakes, { upsert: CODES.map((code) => ({ code, title: `Old ${code}`, description: null, acadYear: YEAR })) });
  expect(res.status).toBe(200);
  return fakes;
}

describe('catalogueKey from the Worker', () => {
  it('GET /admin/hashes reports the catalogueKey of catalogue_only\'s codes', async () => {
    const fakes = await seeded();
    const res = await adminCall('/admin/hashes', fakes);
    expect(res.status).toBe(200);
    const body = /** @type {any} */ (await res.json());
    expect(body.catalogueKey).toBe(await catalogueKey(CODES));
  });

  it('verify --pre-deploy refuses D1\'s catalogue when it is not the bundled file\'s, and passes it when it is', async () => {
    const fakes = await seeded();
    const fixtureEntry = /** @type {any} */ (manifest).bundles.fixture;
    const bytes = await encodeBundle({ corpus: 'production', embedding: 'fake-hash-embed', model: 'fake', modules: fixture.modules, vectorOf: (m) => hashEmbed(/** @type {NormalisedModule} */ (m).text) });
    const bundle = parseBundle(/** @type {ArrayBuffer} */ (bytes.buffer));
    const unscheduledCodes = fixtureUnscheduled.modules.map((e) => e.code);
    const dataFiles = {
      ngReasonsAcadYear: ngReasons.acadYear,
      unscheduled: { acadYear: fixtureUnscheduled.acadYear, codes: unscheduledCodes },
      ngCodes: [...fixture.modules.filter((m) => m.ng).map((m) => m.code), ...unscheduledCodes],
    };
    const args = { api: adminApi(() => fakes), bundle, manifest: fixtureEntry, committedDataVersion: fixtureEntry.dataVersion, knownReason, dataFiles };
    const good = await runPreDeployVerify({ ...args, catalogue: { codes: CODES } });
    expect(good.ok).toBe(true);
    expect(good.catalogueKey).toEqual({ d1: await catalogueKey(CODES), file: await catalogueKey(CODES) });
    const bad = await runPreDeployVerify({ ...args, catalogue: { codes: [...CODES, 'ZZ1003'] } });
    expect(bad.ok).toBe(false);
    expect(bad.catalogueKey.d1).not.toBe(bad.catalogueKey.file);
  });
});
