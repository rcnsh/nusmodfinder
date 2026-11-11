// @ts-check
// The page's icons (Phase 5 5D, direction D): small line drawings built as SVG
// nodes (F8: no markup strings). Each is decorative (aria-hidden): the words
// beside it carry the meaning, so a status is never colour or shape alone.

const NS = 'http://www.w3.org/2000/svg';

/**
 * Each icon: its viewBox and its shapes, as [tag, attributes].
 * @type {Readonly<Record<string, { box: string, parts: [string, Record<string, string>][] }>>}
 */
const ICONS = Object.freeze({
  // Open: a ticked circle.
  open: { box: '0 0 16 16', parts: [
    ['circle', { cx: '8', cy: '8', r: '6.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }],
    ['path', { d: 'M5 8.2l2 2 4-4.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' }],
  ] },
  // Open, with notes: a diamond with a dot.
  note: { box: '0 0 16 16', parts: [
    ['path', { d: 'M8 1.3 14.7 8 8 14.7 1.3 8Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }],
    ['circle', { cx: '8', cy: '8', r: '1.8', fill: 'currentColor' }],
  ] },
  // Not open / not shown: a crossed square.
  closed: { box: '0 0 16 16', parts: [
    ['rect', { x: '1.8', y: '1.8', width: '12.4', height: '12.4', rx: '1', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }],
    ['path', { d: 'M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6', stroke: 'currentColor', 'stroke-width': '1.4' }],
  ] },
  x: { box: '0 0 12 12', parts: [['path', { d: 'M2.5 2.5l7 7M9.5 2.5l-7 7', stroke: 'currentColor', 'stroke-width': '1.5' }]] },
  tick: { box: '0 0 16 16', parts: [['path', { d: 'M3 8.5l3.2 3.2L13 4.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8' }]] },
  // "Check with NUS": an exclamation in a circle.
  check: { box: '0 0 16 16', parts: [
    ['circle', { cx: '8', cy: '8', r: '6.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }],
    ['path', { d: 'M8 4.4v4.6M8 10.6v1.4', stroke: 'currentColor', 'stroke-width': '1.5' }],
  ] },
  ext: { box: '0 0 14 14', parts: [['path', { d: 'M5.5 2.5H2.5v9h9v-3M8 2h4v4M12 2 6.5 7.5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4' }]] },
  filter: { box: '0 0 16 16', parts: [['path', { d: 'M1.5 4h13M4 8h8M6.5 12h3', stroke: 'currentColor', 'stroke-width': '1.5' }]] },
  // The shortlist (Phase 6 6C): a bookmark, outlined when a course is off the list and filled
  // when it is on it, so a pressed toggle shows by shape, not colour alone.
  'mark-off': { box: '0 0 16 16', parts: [['path', { d: 'M4 1.8h8v12.4L8 11.2l-4 3Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }]] },
  'mark-on': { box: '0 0 16 16', parts: [['path', { d: 'M4 1.8h8v12.4L8 11.2l-4 3Z', fill: 'currentColor', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }]] },
});

/** @typedef {keyof typeof ICONS} IconName */

/**
 * A decorative icon.
 * @param {string} name one of ICONS
 * @param {string} [cls] extra classes
 * @returns {SVGSVGElement}
 */
export function icon(name, cls = '') {
  const spec = ICONS[name];
  const svg = /** @type {SVGSVGElement} */ (document.createElementNS(NS, 'svg'));
  svg.setAttribute('viewBox', spec.box);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `i i-${name}${cls ? ` ${cls}` : ''}`);
  for (const [tag, attrs] of spec.parts) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}
