// @ts-check
// The test config must not be able to reach a metered or remote service, and
// must not load the root .dev.vars secret. If this fails, stop: the harness
// is no longer safe to run.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('raw test env', () => {
  /** @type {Record<string, unknown>} */
  const raw = /** @type {any} */ (env);

  it('has no AI, Vectorize, rate limiter or ingest secret', () => {
    expect(raw.AI).toBeUndefined();
    expect(raw.VECTORIZE).toBeUndefined();
    expect(raw.SEARCH_LIMIT).toBeUndefined();
    expect(raw.INGEST_SECRET).toBeUndefined();
    expect(raw.EMBEDDING_MODEL).toBeUndefined();
  });

  it('binds only the local D1 database and the migrations list', () => {
    // The plugin adds its own __VITEST_POOL_WORKERS_* plumbing bindings.
    const ours = Object.keys(raw).filter((k) => !k.startsWith('__VITEST_POOL_WORKERS_')).sort();
    expect(ours).toEqual(['DB', 'TEST_MIGRATIONS']);
    expect(env.TEST_MIGRATIONS.map((m) => m.name)).toEqual([
      '0001_init.sql', '0002_fts.sql', '0003_ng.sql', '0004_meta.sql', '0005_rank.sql', '0006_fts_external.sql', '0007_intents.sql', '0008_catalogue.sql',
    ]);
  });
});
