// @ts-check
// The UI test stack's Worker entry (Phase 5 5B, A-1): src/index.js with the
// fakes test/wrangler.ui.jsonc deliberately has no bindings for. FakeAI
// reproduces the fixture bundle's embedder (hashEmbed), so hybrid search runs
// both halves and no-signal can occur; both FakeRateLimits allow everything. No
// metered Cloudflare service is bound, so `wrangler dev` on this config makes
// no remote call. Run through scripts/ui-server.mjs, which seeds its D1.
import worker from '../../src/index.js';
import { FakeAI, FakeRateLimit } from '../fakes.js';

const AI = new FakeAI();
const SEARCH_LIMIT = new FakeRateLimit();
const SEARCH_LIMIT_MINUTE = new FakeRateLimit();

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  fetch(request, env, ctx) {
    // The fakes keep a call log; nothing reads it here, so drop it per request.
    AI.calls.length = 0;
    SEARCH_LIMIT.calls.length = 0;
    SEARCH_LIMIT.seen.clear();
    SEARCH_LIMIT_MINUTE.calls.length = 0;
    SEARCH_LIMIT_MINUTE.seen.clear();
    return worker.fetch(request, /** @type {Env} */ (/** @type {unknown} */ ({ ...env, AI, SEARCH_LIMIT, SEARCH_LIMIT_MINUTE })), ctx);
  },
};
