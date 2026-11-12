// @ts-check
// The NG-listed codes with no classes this year, for the Worker:
// data/ng-unscheduled.json (src/ng-unscheduled-file.js), imported by the bare
// name `ng-unscheduled-data` that wrangler.jsonc aliases to it. The Vitest
// configs and test/wrangler.ui.jsonc alias it to the fixture's
// (test/fixtures/ng-unscheduled.json) or, for test/full and test/oracle, to the
// pinned corpus's, built in memory; vitest.eval.config.mjs to the run
// workspace's data/ng-unscheduled.json. Parsed once per isolate.
import file from 'ng-unscheduled-data';
import { parseNgUnscheduled } from './ng-unscheduled-file.js';

/** @typedef {import('./ng-unscheduled-file.js').NgUnscheduledEntry} NgUnscheduledEntry */

/** @type {Map<string, NgUnscheduledEntry> | null} */
let parsed = null;

/** Code -> entry for the corpus this Worker serves. */
export function unscheduled() {
  parsed ??= parseNgUnscheduled(/** @type {import('./ng-unscheduled-file.js').NgUnscheduledFile} */ (/** @type {unknown} */ (file)));
  return parsed;
}

/** The acad year the file was built for. */
export const unscheduledAcadYear = () => /** @type {{ acadYear: string }} */ (file).acadYear;
