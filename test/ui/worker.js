// @ts-check
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
    AI.calls.length = 0;
    SEARCH_LIMIT.calls.length = 0;
    SEARCH_LIMIT.seen.clear();
    SEARCH_LIMIT_MINUTE.calls.length = 0;
    SEARCH_LIMIT_MINUTE.seen.clear();
    return worker.fetch(request, /** @type {Env} */ (/** @type {unknown} */ ({ ...env, AI, SEARCH_LIMIT, SEARCH_LIMIT_MINUTE })), ctx);
  },
};
