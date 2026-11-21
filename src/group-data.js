// @ts-check
import groupsFile from 'groups-data';
import { parseGroupsFile } from './groups.js';

/** @type {{ groupOf: Map<string, string>, members: Map<string, string[]> } | null} */
let parsed = null;

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
