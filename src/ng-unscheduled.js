// @ts-check
import file from 'ng-unscheduled-data';
import { parseNgUnscheduled } from './ng-unscheduled-file.js';

/** @typedef {import('./ng-unscheduled-file.js').NgUnscheduledEntry} NgUnscheduledEntry */

/** @type {Map<string, NgUnscheduledEntry> | null} */
let parsed = null;

export function unscheduled() {
  parsed ??= parseNgUnscheduled(/** @type {import('./ng-unscheduled-file.js').NgUnscheduledFile} */ (/** @type {unknown} */ (file)));
  return parsed;
}

export const unscheduledAcadYear = () => /** @type {{ acadYear: string }} */ (file).acadYear;
