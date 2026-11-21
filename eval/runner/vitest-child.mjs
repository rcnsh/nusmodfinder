// @ts-check
import { createVitest } from 'vitest/node';
import { EvalReporter } from './reporter.mjs';

/**
 * @typedef {{
 *   config: string,
 *   root: string,
 *   perQueryOutput: boolean,
 *   payload: EvalPayload,
 *   reporter: Omit<import('./reporter.mjs').EvalReporterOptions, 'log' | 'key'> & { key: Uint8Array | null },
 * }} ChildRequest
 * @typedef {{ type: 'log', line: string } | { type: 'outcome', outcome: { ok: boolean, written: string | null, problems: string[] } }} ChildMessage
 */

/** @param {ChildMessage} msg */
const send = (msg) => new Promise((resolve) => { /** @type {any} */ (process).send(msg, resolve); });

process.once('message', async (/** @type {ChildRequest} */ req) => {
  const reporter = new EvalReporter({
    ...req.reporter,
    key: req.reporter.key ? Buffer.from(req.reporter.key) : null,
    log: (line) => { void send({ type: 'log', line }); },
  });
  let outcome;
  try {
    const vitest = await createVitest({
      config: req.config,
      root: req.root,
      watch: false,
      run: true,
      reporters: req.perQueryOutput ? ['dot', reporter] : [reporter],
      silent: !req.perQueryOutput,
    });
    try {
      /** @type {any} */ (vitest).provide('evalPayload', req.payload);
      await vitest.start();
    } finally {
      await vitest.close();
    }
    outcome = reporter.outcome ?? { ok: false, written: null, problems: ['the reporter never saw the end of the run'] };
  } catch (err) {
    outcome = { ok: false, written: null, problems: [`the runner threw: ${err instanceof Error ? err.message : String(err)}`] };
  }
  await send({ type: 'outcome', outcome });
  process.exit(0);
});
