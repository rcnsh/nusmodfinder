// @ts-check

export const PHRASE_INTENTS = Object.freeze(/** @type {const} */ (['exam', 'su', 'hoursBelow', 'prereq']));

/** @typedef {typeof PHRASE_INTENTS[number]} PhraseIntent */
/** @typedef {{ intent: PhraseIntent, label: string }} IntentChip */

/**
 * @param {unknown} interpreted
 * @param {readonly string[]} [ignore]
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
