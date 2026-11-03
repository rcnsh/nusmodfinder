// @ts-check
// Dev query ids used by the Phase 2c analysis (dev set v2.1 only).

/**
 * The 15 fidelity queries: a spread of shapes, mostly sent unfiltered, a few
 * with their dev filters. `filtered: false` drops the query's filters.
 * @type {{ id: string, filtered: boolean }[]}
 */
export const FIDELITY = [
  { id: 'd-001', filtered: false }, // topical
  { id: 'd-015', filtered: false }, // topical, short
  { id: 'd-039', filtered: false }, // topical
  { id: 'd-055', filtered: false }, // topical, natural-language question
  { id: 'd-073', filtered: false }, // mapping (pasted course, 123 chars)
  { id: 'd-018', filtered: false }, // alternatives
  { id: 'd-007', filtered: false }, // language
  { id: 'd-076', filtered: false }, // abbreviation ("OS")
  { id: 'd-079', filtered: false }, // ge
  { id: 'd-085', filtered: false }, // code-exact (pinned)
  { id: 'd-095', filtered: false }, // typo
  { id: 'd-063', filtered: true }, // level, sem 2 + ng
  { id: 'd-043', filtered: true }, // sea, ng
  { id: 'd-065', filtered: true }, // no-answer, sem 2 + ng
  { id: 'd-088', filtered: true }, // code-space, ng
];
export const FIDELITY_IDS = FIDELITY.map((f) => f.id);

/** Five more dev queries for the one re-embedding request (20 texts). */
export const REEMBED_EXTRA_IDS = ['d-003', 'd-021', 'd-047', 'd-067', 'd-091'];
