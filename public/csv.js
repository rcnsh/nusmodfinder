// @ts-check
// The shortlist as CSV: RFC 4180, every field quoted, `"` doubled, CRLF line
// ends, UTF-8 with a byte-order mark, and OWASP's CSV injection guard. The
// column header is the first row, then one row per entry in the export's order
// (export.js); then a separator row of empty fields, then the head's, the
// totals' and the foot's lines as label/value rows. Every row has the header's
// field count. Pure: test/web/csv.node.test.js.

/** @typedef {import('./export.js').Doc} Doc */

/** Beside the button and in the file's foot: Excel in `;` locales puts a CSV in one column. */
export const EXCEL_HINT = 'Excel shows one column? Use Data › From Text/CSV.';

/**
 * OWASP's CSV injection advice: a field starting with `=`, `+`, `-`, `@`, a
 * tab or a CR gets a leading `'`, so a spreadsheet never reads it as a formula.
 * @param {string} value
 */
export const guard = (value) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

/** One field, guarded and quoted. @param {string} value */
const field = (value) => `"${guard(value).replaceAll('"', '""')}"`;

/**
 * The CSV's rows, as plain fields (before guarding and quoting).
 * @param {Doc} doc
 * @returns {string[][]}
 */
export function csvRows(doc) {
  const width = doc.columns.length;
  /** @param {string} label @param {string} value */
  const line = (label, value) => [label, value, ...Array(width - 2).fill('')];
  /** @type {string[][]} */
  const rows = [doc.columns.map((c) => c.label)];
  for (const s of doc.sections) for (const g of s.groups) for (const e of g.entries) rows.push(doc.columns.map((c) => e.cells[c.key] ?? ''));
  rows.push(Array(width).fill(''));
  for (const h of doc.head) rows.push(line(h.label, h.value));
  for (const s of doc.sections) for (const t of s.totals) rows.push(line(`${s.heading} totals`, t));
  rows.push(line('NUS\'s application form', doc.form.intro));
  for (const t of doc.form.tables) {
    const label = `NUS's application form, ${t.caption.replace(/ on NUS's form.*$/, '')}`;
    rows.push(line(label, t.caption));
    for (const r of t.rows) rows.push(line(label, `${r.number}: ${r.code}, ${r.list}, ${r.units} units${r.note ? `${r.mark ? ':' : '.'} ${r.note}` : ''}`));
    if (t.note) rows.push(line(label, t.note));
  }
  for (const a of doc.form.applicants) rows.push(line('For applicants', a));
  for (const r of doc.courseReg.rules) rows.push(line(doc.courseReg.heading, r));
  rows.push(line(doc.courseReg.heading, doc.courseReg.page));
  for (const c of doc.closing) rows.push(line(c.label, c.value));
  rows.push(line('Excel', EXCEL_HINT));
  return rows;
}

/**
 * The file's text: the byte-order mark, then every row, CRLF after each.
 * @param {Doc} doc
 */
export function toCsv(doc) {
  return `\uFEFF${csvRows(doc).map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;
}
