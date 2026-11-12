// @ts-check
// Building DOM nodes. Text only ever enters the page as a Text node or through
// textContent, so data can never become markup; lint bans every HTML-string
// sink in public/ (eslint.config.mjs).

/** @typedef {Node | string | number | null | undefined | false} Child */

/**
 * An element with a class, attributes and children. Strings and numbers become
 * Text nodes; null, undefined and false are skipped.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {{ class?: string, attrs?: Record<string, string> } | null} [props]
 * @param {...Child} children
 * @returns {HTMLElementTagNameMap[K]}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props?.class) el.className = props.class;
  for (const [name, value] of Object.entries(props?.attrs ?? {})) el.setAttribute(name, value);
  el.append(...nodes(children));
  return el;
}

/**
 * @param {Child[]} children
 * @returns {(Node | string)[]}
 */
export function nodes(children) {
  return children.filter((c) => c !== null && c !== undefined && c !== false).map((c) => (typeof c === 'number' ? String(c) : /** @type {Node | string} */ (c)));
}

/**
 * Replaces an element's children.
 * @param {Element} el
 * @param {...Child} children
 */
export function setChildren(el, ...children) {
  el.replaceChildren(...nodes(children));
}
