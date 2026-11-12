// @ts-check
// The duplicate groups for the Worker: data/groups.json, groups-v1
// (src/groups.js) over the production bundle's corpus, built with it
// (scripts/build-groups.mjs) and versioned the same way, imported by the bare
// name `groups-data` that wrangler.jsonc aliases to it. The Vitest configs alias
// it to the fixture's or the pinned corpus's groups; vitest.eval.config.mjs to
// each run workspace's data/groups.json, which the run overwrites with the run
// corpus's.
// Parsed once per isolate.
import groupsFile from 'groups-data';
import { parseGroupsFile } from './groups.js';

/** @type {{ groupOf: Map<string, string>, members: Map<string, string[]> } | null} */
let parsed = null;

/**
 * For the corpus this Worker serves: code -> group key, and group key -> its
 * members in code order. A code in no group is in neither map.
 */
export function groups() {
  if (!parsed) {
    const groupOf = parseGroupsFile(/** @type {import('./groups.js').GroupsModuleFile} */ (/** @type {unknown} */ (groupsFile)));
    /** @type {Map<string, string[]>} */
    const members = new Map();
    for (const [code, key] of groupOf) {
      const m = members.get(key);
      if (m) m.push(code); else members.set(key, [code]);
    }
    for (const m of members.values()) m.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    parsed = { groupOf, members };
  }
  return parsed;
}
