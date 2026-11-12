// @ts-check
// A strict RFC 4180 reader for the export tests: written apart
// from public/csv.js, so the tests read the file the way a spreadsheet would,
// not the way the page wrote it. It refuses anything RFC 4180 doesn't allow:
// a bare LF or CR, a quote inside an unquoted field, text after a closing
// quote, an unterminated quoted field, and a file that doesn't end with CRLF.

/**
 * The records of a CSV text (no byte-order mark: the caller strips it).
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const records = [];
  /** @type {string[]} */
  let record = [];
  let i = 0;
  const n = text.length;
  if (!text.endsWith('\r\n')) throw new Error('the file does not end with CRLF');
  while (i < n) {
    let field = '';
    if (text[i] === '"') {
      i += 1;
      for (;;) {
        if (i >= n) throw new Error(`unterminated quoted field in record ${records.length + 1}`);
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i += 1;
          break;
        }
        field += text[i];
        i += 1;
      }
      if (i < n && text[i] !== ',' && text[i] !== '\r') throw new Error(`text after a closing quote in record ${records.length + 1}: ${JSON.stringify(text.slice(i, i + 20))}`);
    } else {
      while (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        if (text[i] === '"') throw new Error(`a quote inside an unquoted field in record ${records.length + 1}`);
        field += text[i];
        i += 1;
      }
      if (text[i] === '\n') throw new Error(`a bare LF in record ${records.length + 1}`);
    }
    record.push(field);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`a bare CR in record ${records.length + 1}`);
      i += 2;
      records.push(record);
      record = [];
    }
  }
  return records;
}

/**
 * Whether every field of a CSV text is quoted (the export quotes every field).
 * @param {string} text
 */
export function everyFieldQuoted(text) {
  // Outside quoted runs, only the separators may appear.
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (!inQuotes && ch !== ',' && ch !== '\r' && ch !== '\n') return false;
  }
  return !inQuotes;
}
