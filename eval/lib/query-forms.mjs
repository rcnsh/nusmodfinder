// @ts-check

/**
 * @param {string} text
 * @returns {string[]}
 */
export function queryTextForms(text) {
  const canonical = text.trim().replace(/\s+/g, ' ').replace(/[A-Z]+/g, (m) => m.toLowerCase());
  return canonical === text ? [text] : [text, canonical];
}
