#!/usr/bin/env node
// @ts-check
// Phase 6 red team: the live totals against the independent reference
// (test/web/shortlist-reference.node.mjs over production's rows, through
// advisor.mjs, which adds an NG-listed 404's units to confirm as the plan
// says). For each persona's saved exports (artifacts/<id>/): the CSV's
// "Sem N totals" rows read as p6-live reads them, the view's text at the
// moment of printing, and the PDF holding the CSV's totals lines (squashed,
// as test/ui/pdf-text.mjs compares). The link each was made from is the one
// the CSV carries. Sends nothing.
//
//   node docs/evidence/phase6/redteam/totals.mjs p1 p2
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { csvTotals, readTotals } from '../../../../scripts/p6-live-plan.mjs';
import { pdfPages, squash } from '../../../../test/ui/pdf-text.mjs';
import { parseCsv } from '../../../../test/web/rfc4180.node.mjs';
import { advisorExpected } from './advisor.mjs';

const HERE = new URL('.', import.meta.url);
/** @type {Record<string, any>} */
const out = {};
let failed = 0;
for (const id of process.argv.slice(2)) {
  const dir = new URL(`artifacts/${id}/`, HERE);
  const files = readdirSync(dir);
  const csvFile = files.find((f) => f.endsWith('.csv'));
  const pdfFile = files.find((f) => f.endsWith('.pdf'));
  const viewFile = files.find((f) => f.endsWith('.view.txt'));
  /** @type {string[]} */
  const problems = [];
  /** @type {Record<string, any>} */
  const r = { csv: csvFile ?? null, pdf: pdfFile ?? null, view: viewFile ?? null };
  let link = '';
  /** @type {string[]} */
  let totalLines = [];
  if (csvFile) {
    const text = readFileSync(new URL(csvFile, dir), 'utf8');
    if (text.charCodeAt(0) !== 0xFEFF) problems.push('CSV: no byte-order mark');
    const records = parseCsv(text.slice(text.charCodeAt(0) === 0xFEFF ? 1 : 0));
    const [header, ...rest] = records;
    if (records.some((x) => x.length !== header.length)) problems.push('CSV: a row with another field count than the header');
    const sep = rest.findIndex((x) => x.every((f) => f === ''));
    const tail = rest.slice(sep + 1);
    link = /https:\/\/nusmodfinder\.rcn\.sh\/\?[^\s",]+/.exec(text)?.[0] ?? '';
    r.csvEntries = sep;
    r.csvTotals = csvTotals(tail);
    totalLines = tail.filter(([label]) => /^Sem [12] totals$/.test(label)).map(([, v]) => v);
  }
  if (!link) {
    try { link = readFileSync(new URL('clipboard.txt', dir), 'utf8').trim(); } catch { /* none */ }
  }
  r.link = link;
  if (!link) { problems.push('no link in the CSV or the clipboard'); out[id] = { ...r, problems }; failed++; continue; }
  const want = await advisorExpected(link);
  r.reference = want.semesters;
  const cmp = (/** @type {string} */ where, /** @type {Record<string, any>} */ got) => {
    for (const s of ['1', '2']) {
      const w = want.semesters[s];
      const g = got[s];
      const empty = w.counted === 0 && w.confirm === 0 && w.invite === 0;
      if (!g) { if (!empty) problems.push(`${where}: no Sem ${s} totals, the reference ${JSON.stringify(w)}`); continue; }
      if (g.atLeast) problems.push(`${where}: Sem ${s} says "at least"`);
      for (const k of ['counted', 'confirm', 'invite']) if (g[k] !== w[k]) problems.push(`${where}: Sem ${s} ${k} ${g[k]}, the reference ${w[k]}`);
    }
  };
  if (r.csvTotals) cmp('the CSV', r.csvTotals);
  if (viewFile) {
    const view = readFileSync(new URL(viewFile, dir), 'utf8');
    /** @type {Record<string, any>} */
    const got = {};
    const parts = view.split(/\n(?=Sem [12] picks\n)/);
    for (const part of parts) {
      const s = /^Sem ([12]) picks\n/.exec(part)?.[1];
      if (s) got[s] = readTotals([part]);
    }
    r.viewTotals = got;
    cmp('the view', got);
  }
  if (pdfFile) {
    const text = squash(pdfPages(readFileSync(new URL(pdfFile, dir))).join(''));
    const missing = totalLines.filter((l) => !text.includes(squash(l)));
    r.pdfHoldsCsvTotals = totalLines.length - missing.length;
    for (const l of missing) problems.push(`the PDF: no CSV totals line "${l}"`);
    // The PDF's own totals, read from its squashed text ("Sem1:16unitspicked,…plus4unitstoconfirmwithNUS…").
    /** @type {Record<string, any>} */
    const got = {};
    for (const m of text.matchAll(/Sem([12]):(atleast)?(\d+(?:\.\d+)?)unitspicked(.{0,400})/g)) {
      const rest = m[4].split(/Sem[12]:/)[0];
      const plus = (/** @type {RegExp} */ re) => Number(re.exec(rest)?.[1] ?? 0);
      got[m[1]] = { counted: Number(m[3]), atLeast: Boolean(m[2]), confirm: plus(/plus(\d+(?:\.\d+)?)unitstoconfirmwithNUS/), invite: plus(/plus(\d+(?:\.\d+)?)unitsonlyifinvited/) };
    }
    r.pdfTotals = got;
    cmp('the PDF', got);
    for (const row of want.rows) if (row.description && !text.includes(squash(row.description).slice(0, 120))) problems.push(`the PDF: ${row.code}'s description not found`);
  }
  r.problems = problems;
  if (problems.length) failed++;
  out[id] = r;
  console.log(`${id}: ${problems.length ? problems.join('\n  ') : 'totals equal the reference in every export read'}`);
}
writeFileSync(new URL('totals.json', HERE), `${JSON.stringify(out, null, 1)}\n`);
process.exit(failed ? 1 : 0);
