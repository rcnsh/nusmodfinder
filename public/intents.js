// @ts-check
// The parsed-phrase chips' words: what /search read from the query's words ("no
// final exam", "under 10 hours", "no prerequisites", S/U), from its
// `interpreted` echo. Pure, so test/web runs it in Node; the chip row is
// intent-chips.js. Only the four phrase intents get a chip (the Worker reads
// them when PARSE_PHRASES is on).

/** The intents a chip can undo, in the order chips show (src/query-intent.js INTERPRETED_KEYS). */
export const PHRASE_INTENTS = Object.freeze(/** @type {const} */ (['exam', 'su', 'hoursBelow', 'prereq']));

/** @typedef {typeof PHRASE_INTENTS[number]} PhraseIntent */
/** @typedef {{ intent: PhraseIntent, label: string }} IntentChip */

/**
 * The chips for a /search `interpreted` echo: one per parsed phrase intent the
 * student hasn't already undone. Values the Worker never sends give no chip.
 * @param {unknown} interpreted
 * @param {readonly string[]} [ignore] the intents the URL already undoes
 * @returns {IntentChip[]}
 */
export function intentChips(interpreted, ignore = []) {
  if (!interpreted || typeof interpreted !== 'object') return [];
  const i = /** @type {Record<string, any>} */ (interpreted);
  /** @type {IntentChip[]} */
  const out = [];
  for (const intent of PHRASE_INTENTS) {
    if (ignore.includes(intent)) continue;
    const v = i[intent];
    if (intent === 'exam' && v === 0) out.push({ intent, label: 'No final exam' });
    if (intent === 'su' && (v?.value ?? v) === 1) out.push({ intent, label: 'Can be taken S/U' });
    if (intent === 'hoursBelow' && Number.isInteger(v) && v > 0) out.push({ intent, label: `Under ${v} h a week` });
    if (intent === 'prereq' && (v?.value ?? v) === 'none') out.push({ intent, label: 'No prerequisites' });
  }
  return out;
}
