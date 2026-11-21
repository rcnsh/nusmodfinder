// @ts-check

/** @param {string} text */
export function stripJsonc(text) {
  /** @type {string[]} */
  const out = [];
  let comma = -1;
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) if (text[j] === '\\') j++;
      out.push(text.slice(i, j + 1));
      comma = -1;
      i = j + 1;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('an unterminated /* comment');
      out.push(' ');
      i = end + 2;
    } else {
      if (c === '}' || c === ']') { if (comma >= 0) out[comma] = ''; comma = -1; }
      else if (c === ',') comma = out.length;
      else if (!/\s/.test(c)) comma = -1;
      out.push(c);
      i++;
    }
  }
  return out.join('');
}

/**
 * @param {string} text
 * @param {string} [where]
 * @returns {unknown}
 */
export function parseJsonc(text, where = 'the file') {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (err) {
    throw new Error(`${where} is not readable JSONC: ${/** @type {Error} */ (err).message}`);
  }
}
