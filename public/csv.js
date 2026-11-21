// @ts-check

/** @typedef {import('./export.js').Doc} Doc */

export const EXCEL_HINT = 'Excel shows one column? Use Data › From Text/CSV.';

/** @param {string} value */
export const guard = (value) => (/^[=+\-@\t\r]/.test(value) ? `'${value}` : value);

/** @param {string} value */
const field = (value) => `"${guard(value).replaceAll('"', '""')}"`;

/**
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
  if (doc.form) {
    rows.push(line('NUS\'s application form', doc.form.intro));
    for (const t of doc.form.tables) {
      const label = `NUS's application form, ${t.caption.replace(/ on NUS's form.*$/, '')}`;
      rows.push(line(label, t.caption));
      for (const r of t.rows) rows.push(line(label, `${r.number}: ${r.code}, ${r.list}, ${r.units} units${r.note ? `${r.mark ? ':' : '.'} ${r.note}` : ''}`));
      if (t.note) rows.push(line(label, t.note));
    }
    for (const a of doc.form.applicants) rows.push(line('For applicants', a));
  }
  if (doc.courseReg) {
    for (const r of doc.courseReg.rules) rows.push(line(doc.courseReg.heading, r));
    rows.push(line(doc.courseReg.heading, doc.courseReg.page));
  }
  for (const c of doc.closing) rows.push(line(c.label, c.value));
  rows.push(line('Excel', EXCEL_HINT));
  return rows;
}

/** @param {Doc} doc */
export function toCsv(doc) {
  return `\uFEFF${csvRows(doc).map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;
}
