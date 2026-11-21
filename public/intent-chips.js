// @ts-check
import { h } from './dom.js';
import { intentChips } from './intents.js';

/**
 * @param {unknown} interpreted
 * @param {readonly string[]} ignore
 * @param {(intent: import('./intents.js').PhraseIntent) => void} onRemove
 * @returns {HTMLElement | null}
 */
export function intentChipRow(interpreted, ignore, onRemove) {
  const chips = intentChips(interpreted, ignore);
  if (!chips.length) return null;
  const items = chips.map(({ intent, label }) => {
    const remove = h('button', { class: 'chip-remove', attrs: { type: 'button', 'aria-label': `Remove “${label}” and search again` } }, '×');
    remove.addEventListener('click', () => onRemove(intent));
    return h('li', { class: 'chip intent', attrs: { 'data-intent': intent } }, h('span', null, label), remove);
  });
  return h('div', { class: 'chips intents' },
    h('span', { class: 'intents-label', attrs: { id: 'intentsLabel' } }, 'Read from your query:'),
    h('ul', { attrs: { 'aria-labelledby': 'intentsLabel' } }, ...items));
}
