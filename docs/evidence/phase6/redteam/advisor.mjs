#!/usr/bin/env node
// @ts-check
// Phase 6 red team: the advisor's expected answers, from the link it is given
// and production's data alone, by rules fixed (and pushed) before any persona
// runs. The link is only known after p2 makes it, so this file fixes how the
// answers are worked out, not the answers. Sends nothing.
//
//   node docs/evidence/phase6/redteam/advisor.mjs '<the copied link>' [out.json]
//
// For each entry, in the link's order (picks, then backups, each in rank):
// - list, rank and semester: the link's (`pick`/`alt` order, `CODE.S`);
// - department, level, units, NUSMods' weekly hours and description: the
//   production-normalised module (or data/ng-unscheduled.json's row for an
//   NG-listed code with no classes);
// - open to the student (yes / yes if / no / ask NUS): rules.mjs over the SC1
//   oracle at the link's study level and the entry's semester, with the
//   advisor's brief (rules.mjs advisorBrief: no student facts, the link's `inv`);
// - its standing (counted, to confirm, only if invited, not counted, the same
//   course as another): the independent reference
//   (test/web/shortlist-reference.node.mjs) over production's rows, an
//   NG-listed code with no classes "to confirm" unless NUS's restrictions
//   close it (plan 6B), and a backup the same course as a kept pick or an
//   earlier kept backup a duplicate (plan 6B; the reference settles picks only);
// - its number on NUS's form, per semester (plan 6B "the order for NUS's
//   application form"): counted and to-confirm entries only, not duplicates,
//   `audition` entries or uninvited Business and Law ones; the semester's
//   picks then its backups, each in rank; numbered 1, 2, 3 … while the
//   running units stay at or under 40, "won't fit" past that (a later smaller
//   entry that fits takes the next number); past the 10th, numbered and marked.
// Per semester: the reference's counted, to-confirm and only-if-invited units
// of the picks, and the counted units × 2.5 hours a week (NUS's rate). The year:
// 2026/27's courses and exams (the data's acadYear).
import { readFileSync, writeFileSync } from 'node:fs';
import { loadData, refData } from '../../../../scripts/p6-live-plan.mjs';
import { reference } from '../../../../test/web/shortlist-reference.node.mjs';
import { expectedFor, loadModules } from './expected.mjs';
import { advisorBrief } from './rules.mjs';

const ROOT = new URL('../../../../', import.meta.url);

/** @param {string} text @param {string} code @param {string} study the reference's preclusion match */
function namesRef(text, code, study) {
  if (!text) return false;
  if (study === 'grad' && /^\s*\(?\s*if undertaking an undergraduate degree/i.test(text) && !/graduate degree coursework/i.test(text.split(/then/i)[0])) return false;
  if (new RegExp(`(^|[^A-Za-z])${code}(?=[^A-Za-z0-9]|$|OR|AND|THEN)`).test(text)) return true;
  return [...text.matchAll(/beginning with\s+([A-Z]+\d*)/g)].some((m) => code.startsWith(m[1]));
}

/**
 * @param {string} link the copied link
 */
export async function advisorExpected(link) {
  const u = new URL(link);
  const q = u.searchParams;
  const study = q.get('ng') === '1' ? (q.get('study') ?? '') : '';
  const brief = advisorBrief(q);
  const byCode = await loadModules();
  const data = await loadData('production');
  const ref = refData(data);
  const unscheduled = new Map(JSON.parse(readFileSync(new URL('data/ng-unscheduled.json', ROOT), 'utf8')).modules.map((/** @type {any} */ m) => [m.code, m]));
  /** @param {string} v */
  const parse = (v) => { const [code, sem = ''] = v.toUpperCase().split('.'); return { code, sem }; };
  const entries = [
    ...q.getAll('pick').map((v, i) => ({ which: 'pick', rank: i + 1, ...parse(v) })),
    ...q.getAll('alt').map((v, i) => ({ which: 'alt', rank: i + 1, ...parse(v) })),
  ];
  const r = reference(entries, study, q.getAll('inv'), ref);
  const flags = [];
  const rows = entries.map((e, i) => {
    const m = byCode.get(e.code);
    let standing = r.standings[i].standing;
    const sem = Number(e.sem);
    const exp = m && sem ? expectedFor(byCode, { study, brief }, e.code, sem) : null;
    if (m?.ngListed404) standing = exp?.oracle.result === 'closed' ? 'out' : 'confirm';
    if (m?.faculty === 'NUS Business School' || m?.faculty === 'Law') flags.push(`${e.code}: a Business or Law entry; the form's invited numbering is not worked out here`);
    return {
      list: e.which === 'pick' ? 'primary' : 'backup', rank: e.rank, code: e.code, sem: e.sem || null,
      title: m?.title ?? null, department: m?.department ?? null, faculty: m?.faculty ?? null,
      level: m?.level != null ? m.level * 1000 : null, units: m?.credits ?? null,
      // An offered row's `workloadHours` (NUSMods' five parts summed, as ingest stores it); an NG-listed 404's `workload.total`.
      nusmodsHoursPerWeek: m?.workloadHours ?? m?.workload?.total ?? null,
      hoursAtNusRate: m?.credits != null ? m.credits * 2.5 : null,
      description: m?.description ?? unscheduled.get(e.code)?.description ?? null,
      open: exp?.answer ?? 'no', kinds: exp?.kinds ?? ['no semester or no row'], standing,
      /** @type {string | null} */ form: null,
    };
  });
  // Backups: a duplicate of a kept pick or an earlier kept backup (both counted or to confirm).
  const takes = (/** @type {string} */ st) => st === 'counted' || st === 'confirm' || st === 'invite';
  const kept = rows.filter((x) => x.list === 'primary' && takes(x.standing));
  const same = (/** @type {any} */ a, /** @type {any} */ b) => {
    if (!ref.groupOf(a.code).includes(b.code)) return false;
    const ma = byCode.get(a.code); const mb = byCode.get(b.code);
    if (ma?.ng && mb?.ng) return true;
    return namesRef(ma?.preclusion, b.code, study) || namesRef(mb?.preclusion, a.code, study);
  };
  for (const x of rows.filter((y) => y.list === 'backup' && takes(y.standing))) {
    if (kept.some((k) => same(k, x))) x.standing = 'dup';
    else kept.push(x);
  }
  // The form, per semester.
  if (study) {
    for (const s of ['1', '2']) {
      let running = 0;
      let n = 0;
      for (const x of rows.filter((y) => y.sem === s)) {
        if (!(x.standing === 'counted' || x.standing === 'confirm') || x.kinds.includes('audition')) continue;
        if (running + (x.units ?? 0) > 40) { x.form = `won't fit in NUS's 40 units`; continue; }
        running += x.units ?? 0;
        n += 1;
        x.form = `Sem ${s}: ${n}${n > 10 ? ' (past NUS\'s 10: check)' : ''}`;
      }
    }
  }
  /** @type {Record<string, any>} */
  const semesters = {};
  for (const s of /** @type {('1' | '2')[]} */ (['1', '2'])) {
    const t = { ...r.totals[s] };
    // The reference has no row for an NG-listed code with no classes (it reads offered rows only):
    // the plan's "to confirm" with its units, added here.
    for (const x of rows) if (x.list === 'primary' && x.sem === s && byCode.get(x.code)?.ngListed404 && x.standing === 'confirm') t.confirm += x.units ?? 0;
    semesters[s] = { ...t, hoursPerWeekAtNusRate: t.counted * 2.5, weeks: '13 weeks of instruction and 2 weeks of examinations (GRO)' };
  }
  return { link, study, inv: q.getAll('inv'), year: { courses: '2026/27', exams: '2026/27' }, rows, semesters, flags };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [link, out] = process.argv.slice(2);
  if (!link) { console.error('usage: advisor.mjs <link> [out.json]'); process.exit(2); }
  const x = await advisorExpected(link);
  const text = `${JSON.stringify(x, null, 1)}\n`;
  if (out) writeFileSync(out, text);
  else process.stdout.write(text);
}
