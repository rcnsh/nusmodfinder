// Phase 6 6-0 mockup (docs/plans/phase6.md §2): the shortlist inside direction D.
// Static and offline: the course data is window.P6 (data.js, derived by
// ../derive.mjs from the fixture through the page's own code); this file only
// works out each entry by 6B's rules and draws the four states. Nothing here is
// product code.
//
//   index.html                                   the gallery: every state, both widths, both themes
//   index.html#solo-<state>-<desktop|phone>-<light|dark>   one state, full window (screenshots, checks)
//   states: results, view, fullyear, print
/* global P6 */
(function () {
  'use strict';
  const C = P6.courses;
  const YEAR = '2026/27';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- icons: the page's own shapes (public/icons.js), plus a bookmark for the list ----
  const ICON = {
    open: '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5 8.2l2 2 4-4.4" fill="none" stroke="currentColor" stroke-width="1.5"/>',
    note: '<path d="M8 1.3 14.7 8 8 14.7 1.3 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>',
    closed: '<rect x="1.8" y="1.8" width="12.4" height="12.4" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 5.2l5.6 5.6M10.8 5.2l-5.6 5.6" stroke="currentColor" stroke-width="1.4"/>',
    check: '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.4v4.6M8 10.6v1.4" stroke="currentColor" stroke-width="1.5"/>',
    x: '<path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" stroke-width="1.5"/>',
    'mark-off': '<path d="M4 1.8h8v12.4L8 11.2l-4 3Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    'mark-on': '<path d="M4 1.8h8v12.4L8 11.2l-4 3Z" fill="currentColor" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
    ext: '<path d="M5.5 2.5H2.5v9h9v-3M8 2h4v4M12 2 6.5 7.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  };
  const icon = (n) => `<svg class="i i-${n}" viewBox="0 0 ${n === 'x' ? 12 : n === 'ext' ? 14 : 16} ${n === 'x' ? 12 : n === 'ext' ? 14 : 16}" aria-hidden="true" focusable="false">${ICON[n]}</svg>`;
  const STAMP = { open: 'open', note: 'note', closed: 'closed' };
  const stamp = (status, text) => `<span class="st st-${STAMP[status]} exchange-status" data-status="${status}">${icon(STAMP[status])}<span>${esc(text)}</span></span>`;
  // A row's button: its visible text, and an accessible name of that text then the code
  // ("Move up, CS3244"; 6C), set as aria-label so no stray space joins the two.
  const act = (label, code, attrs = '') => `<button type="button" class="btn" aria-label="${esc(`${label}, ${code}`)}"${attrs}>${esc(label)}</button>`;

  // ---- NUS's words, quoted (docs/evidence/phase6/facts.md has each source) ----
  const Q = {
    oversub: { text: 'NUS says these courses are extremely oversubscribed, gives priority to students majoring in them, and advises students with other majors against choosing them.', src: 'NUS Global, Incoming Exchange Students' },
    level4: { text: '“Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very limited supply and are usually NOT available to exchange students. In order to increase the chances of securing enough courses, incoming exchange students should consider taking courses with course code starting from 1000 to 3000.”', src: 'NUS Global, Incoming Exchange Students' },
    ruleE: '“If the courses cannot be found at the Course offerings list, they are not available during application stage but may be available during Course registration.”',
    bizOnly: '“Only students who have been offered Business courses during the application stage will be able to see the courses during “Submit Course Requests.””',
    bizGRO: '“Business and Law courses are only available to students who are invited by NUS Business School and NUS Law respectively to apply for the exchange during the nomination period”',
  };
  const FULLYEAR = 'NUS has asked full-year students to choose Sem 2 courses later, by email before Sem 1 ends (NUS info sheet, 2018/19): check with NUS whether to list them now.';
  const FORM_INTRO = 'This order uses NUS’s 2026/27 exchange list and exams. Applying for 2027/28? NUS publishes Sem 1’s list in March or April, Sem 2’s later (the 2026/27 list is dated 1 Sep 2026), and the timetable in mid-July: check each course there.';

  // ---- 6B's rules, over the derived rows ----
  const BUSINESS = 'NUS Business School';
  const CONFIRM_KINDS = new Set(['semester', 'restricted-elsewhere', 'year', 'partner', 'audition', 'unknown']);
  const parse = (v) => { const [code, s] = v.split('.'); return { code, sem: s ? Number(s) : null }; };
  const levelText = (l) => (l <= 3 ? 'Level 1000–3000, undergraduate' : l === 4 ? 'Level 4000, Honours' : 'Level 5000 and above, graduate');
  const examAt = (c, sem) => {
    const line = c.exams.lines.find((l) => l.startsWith(`Sem ${sem}: `));
    return line ? line.slice(7) : null;
  };
  const examWindow = (c, sem) => {
    const e = c.examDates.find((x) => x.sem === sem);
    if (!e) return null;
    const a = Date.parse(e.date);
    return [a, a + (e.durationMins || 0) * 60000];
  };

  function nusNotes(c) {
    const out = [];
    const letters = c.code.match(/^[A-Z]+/)[0];
    if (['AR', 'CE', 'CS', 'EC'].includes(letters)) out.push(Q.oversub);
    if (c.level >= 4 && c.faculty !== 'Law') out.push(Q.level4);
    return out;
  }

  /** Every entry worked out at its own semester (6B "shortlist.js"). */
  function workOut(list) {
    const entries = [
      ...list.picks.map((v, i) => ({ ...parse(v), list: 'pick', rank: i + 1, raw: v })),
      ...list.alts.map((v, i) => ({ ...parse(v), list: 'alt', rank: i + 1, raw: v })),
    ];
    for (const e of entries) {
      const c = (e.c = C[e.code]);
      e.biz = c.faculty === BUSINESS || c.faculty === 'Law';
      e.notes = nusNotes(c);
      e.flags = [];
      if (e.sem === null) { e.cat = 'unplaced'; continue; }
      const ex = (e.ex = c.exchange[e.sem]);
      if (ex.status === 'closed') e.cat = 'closed';
      else if (c.kind === 'ng-listed') e.cat = 'confirm';
      else if (e.biz && !list.inv) e.cat = 'invited';
      else if (ex.reasons.some((r) => CONFIRM_KINDS.has(r.kind))) e.cat = 'confirm';
      else e.cat = 'counted';
    }
    // NUS's application form, per semester: picks then backups, rank order, against 40 units.
    for (const sem of [1, 2]) {
      let units = 0; let n = 0;
      const order = entries.filter((e) => e.sem === sem && e.list === 'pick').concat(entries.filter((e) => e.sem === sem && e.list === 'alt'));
      for (const e of order) {
        if (e.cat !== 'counted' && e.cat !== 'confirm') continue;
        if (units + e.c.credits > 40) { e.form = { wontFit: true }; continue; }
        units += e.c.credits; n += 1; e.form = { n, sem, units };
      }
      // Exam overlaps between counted or to-confirm entries in one semester (flagged, never dropped).
      const live = order.filter((e) => e.cat === 'counted' || e.cat === 'confirm');
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          const a = examWindow(live[i].c, sem); const b = examWindow(live[j].c, sem);
          if (a && b && a[0] < b[1] && b[0] < a[1]) {
            const [x, y] = [live[i], live[j]].sort((p, q) => p.code.localeCompare(q.code));
            const text = `${x.code} and ${y.code}: their 2026/27 exams overlap. If they still do in the year you go, NUS won’t approve both and its form won’t take both (GRO). NUS publishes each year’s timetable in mid-July.`;
            live[i].flags.push(text); live[j].flags.push(text);
          }
        }
      }
    }
    return entries;
  }

  // ---- the page's frame: header, rail, search form (the live page's markup) ----
  function header() {
    return `<a class="skip" href="#main">Skip to main content</a>
<header class="hdr"><h1 class="brand"><svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><rect width="32" height="32" rx="7" fill="currentColor"/><g class="lens" fill="none" stroke-linecap="round"><circle cx="14" cy="14" r="6.5" stroke-width="2.6"/><path d="M19 19l5.5 5.5" stroke-width="3"/></g></svg><span class="brand-name">NUS Mod Finder</span> <span class="unofficial"><span class="paren">(</span>unofficial<span class="paren">)</span></span></h1><p class="hdr-r">Academic year 2026/27</p></header>`;
  }
  function footer() {
    return `<footer class="ftr site-footer"><p>An unofficial site, not run by NUS or NUSMods. Course data comes from NUSMods; who may take each course comes from the NUS Registrar’s lists. Check with NUS before you register.</p>
<ul class="footer-links"><li><a href="#">NUSMods</a></li><li><a href="#">Courses offered to exchange (NG) students</a></li><li><a href="#">Course restrictions for exchange (NG) students</a></li><li><a href="#">The Registrar’s course vacancy report</a></li></ul></footer>`;
  }
  /** The shortlist button: "Your shortlist", then each semester's picked units. */
  function slButton(label, current) {
    return `<button type="button" class="btn sl-open"${current ? ' aria-current="true"' : ''}>${icon('mark-on')}<span class="sl-open-t"><b>Your shortlist</b><small class="sl-open-n">${esc(label)}</small></span></button>`;
  }
  function rail(sem, label, current) {
    const seg = [['1', 'Sem 1'], ['2', 'Sem 2'], ['', 'Both']].map(([v, l]) => `<label class="seg-opt"><input type="radio" name="xsem" value="${v}"${String(sem) === v ? ' checked' : ''}>${l}</label>`).join('');
    return `<aside class="rail" aria-label="Your exchange and filters">
  ${slButton(label, current)}
  <div class="panel" id="panel">
    <section class="rail-sec" aria-labelledby="exTitle"><h2 class="lbl" id="exTitle">Your exchange</h2>
      <label class="checkline"><input type="checkbox" checked> <span>Only courses open to exchange students</span></label>
      <fieldset class="grp"><legend class="gl">Semester at NUS</legend><div class="seg">${seg}</div></fieldset>
      <div class="grp"><label class="gl" for="study">Year of study during your exchange</label><select class="select" id="study"><option>2nd year</option></select></div>
    </section>
    <section class="rail-sec" aria-labelledby="filtTitle"><h2 class="lbl" id="filtTitle">Filters</h2>
      <div class="grp"><label class="gl" for="level">Level</label><select class="select" id="level"><option>Any level</option></select></div>
      <div class="grp"><label class="gl" for="credits">Units</label><select class="select" id="credits"><option>Any units</option></select></div>
      <div class="grp"><label class="gl" for="faculty">Faculty</label><select class="select" id="faculty"><option>Any faculty</option></select></div>
    </section>
  </div>
  <section class="rail-sec key-sec" aria-labelledby="keyTitle"><h2 class="lbl" id="keyTitle">Key</h2><ul class="key">
    <li class="k k-open">${icon('open')}<span><b>Open.</b> Exchange students may take it in that semester.</span></li>
    <li class="k k-note">${icon('note')}<span><b>Open, with notes.</b> Read every note: some limit who may take it.</span></li>
    <li class="k k-closed">${icon('closed')}<span><b>Not open.</b> You cannot take it in that semester. Type its course code in the search box to see why.</span></li>
  </ul></section>
</aside>`;
  }
  function searchForm(q, semChip, label, current) {
    const chips = [`<li><span class="chip chip-fixed">${esc(semChip)}</span></li>`, '<li><span class="chip chip-fixed">2nd year</span></li>',
      `<li><button type="button" class="chip" aria-label="Remove filter: Exchange students">Exchange students${icon('x')}</button></li>`].join('');
    return `<form class="search" role="search" aria-label="Search courses"><div class="bar"><label class="vh" for="q">Search courses</label><input class="field" type="search" id="q" value="${esc(q)}" placeholder="A subject, a course name, or codes"><button class="btn pri" type="submit" id="go">Search</button></div>
<div class="filterrow"><button type="button" class="btn filters-btn"><span>Filters (3)</span></button><ul class="chips" aria-label="Filters applied">${chips}</ul></div></form>
<div class="sl-row">${slButton(label, current)}</div>`;
  }

  // ---- state 1: results with toggles ----
  function card(code, pressed) {
    const c = C[code];
    const per = [1, 2].map((s) => c.exchange[s]);
    const texts = per.map((p) => new Set(p.reasons.map((r) => r.text)));
    const shared = per[0].reasons.filter((r) => texts[1].has(r.text));
    const only = per.map((p, i) => p.reasons.filter((r) => !texts[1 - i].has(r.text)));
    const group = (scope, items) => (items.length ? `<p class="scope">${scope}</p><ul class="notes">${items.map((r) => `<li>${r.kind === 'closed' ? '' : `<span class="k">${esc(r.lead)}</span> `}${esc(r.text)}</li>`).join('')}</ul>` : '');
    const notes = group('Notes for Sem 1', only[0]) + group('Notes for Sem 2', only[1]) + group('Notes for Sem 1 and Sem 2', shared);
    const variants = c.otherCodes.filter((v) => C[v] && C[v].ngSemesters.length);
    const fac = c.faculty !== c.department ? `<span class="fac"> · ${esc(c.faculty)}</span>` : '';
    const exams = c.exams.both.length ? c.exams.both.map((e) => `<span class="exam"><span class="exl">${esc(e.label)}</span> <span class="mono">${esc(e.when)}</span></span>`).join('') : '<span class="exam">No final exam listed</span>';
    return `<li class="card entry">
  <h2 class="card-head"><button class="card-toggle" type="button" aria-expanded="false"><span class="code">${code}</span> <span class="title">${esc(c.title)}</span></button></h2>
  <div class="unitcol"><p class="units">${c.credits} units</p>
    <button type="button" class="btn sl-toggle" aria-pressed="${pressed}" aria-label="Shortlist, ${code}">${icon('mark-off')}${icon('mark-on')}<span>Shortlist</span></button></div>
  <p class="meta"><span class="dept">${esc(c.department)}${fac}</span><span class="sems">Taught in ${c.semesters.filter((s) => s < 3).map((s) => `Sem ${s}`).join(', ')}</span>${exams}</p>
  ${variants.length ? `<p class="variants">Also as ${variants.map((v) => `<a class="variant-link" href="#">${v}</a>`).join(', ')}</p>` : ''}
  <div class="exchange guide"><div class="stamps both">${per.map((p, i) => stamp(p.status, p.stampShort)).join('')}</div>${notes ? `<div class="notes-box">${notes}</div>` : ''}</div>
</li>`;
  }
  function stateResults(label) {
    const q = 'ACC1701XB CS2113 CS2030';
    const cards = [['ACC1701XB', true], ['CS2113', true], ['CS2030', false]];
    return page(rail('', label, false), `${searchForm(q, 'Both semesters', label, false)}
<div class="status"><div class="countrow"><p class="count"><strong>3 courses</strong> shown: ACC1701XB, CS2113, CS2030</p><p class="tz">Exam times are Singapore time (UTC+8)</p></div></div>
<ol class="entries" aria-label="Results">${cards.map(([c, p]) => card(c, p)).join('')}</ol>`);
  }

  // ---- states 2 and 3: the view ----
  function countLine(e) {
    const s = e.sem ? `Sem ${e.sem}` : '';
    switch (e.cat) {
      case 'counted': return '<span class="sl-count">Counted</span>, if NUS accepts you into it';
      case 'confirm': return e.c.kind === 'ng-listed'
        ? `<span class="sl-count">To confirm with NUS:</span> NUS lists it for ${s} in 2026/27, but NUSMods shows no classes: ask NUS`
        : '<span class="sl-count">To confirm with NUS</span> (see the note)';
      case 'invited': return `<span class="sl-count">Only for students invited by ${e.c.faculty === 'Law' ? 'NUS Law' : 'NUS Business School'}.</span> If you’re not sure whether you were, ask your exchange office.`;
      case 'closed': return `<span class="sl-count">Not counted:</span> not on NUS’s 2026/27 exchange course list for ${s}`;
      default: return '<span class="sl-count">Not counted:</span> choose Sem 1 or Sem 2';
    }
  }
  function formSlot(e, applicants) {
    if (!applicants) return '';
    if (e.form && e.form.n) return `<p class="sl-form">Application form, Sem ${e.form.sem}: <b>${e.form.n}</b></p>`;
    if (e.form && e.form.wontFit) return '<p class="sl-form mark">Won’t fit in NUS’s 40 units</p>';
    if (e.cat === 'invited') return '<p class="sl-form">On the form only if invited</p>';
    if (e.cat === 'closed') return `<p class="sl-form">Not on the form: not open in Sem ${e.sem}</p>`;
    if (e.cat === 'unplaced') return '<p class="sl-form">Not on the form until you choose a semester</p>';
    return '';
  }
  function guide(e) {
    if (e.sem === null) {
      const both = [1, 2].map((s) => stamp(e.c.exchange[s].status, e.c.exchange[s].stampShort)).join('');
      return `<div class="stamps both">${both}</div>`;
    }
    const items = e.ex.reasons.map((r) => `<li>${r.kind === 'closed' ? '' : `<span class="k">${esc(r.lead)}</span> `}${esc(r.text)}</li>`);
    if (e.cat === 'invited') {
      items.push(`<li><span class="k">Invitation.</span> NUS: ${esc(Q.bizGRO)}. NUS’s CourseReg FAQ: ${esc(Q.bizOnly)}</li>`);
    }
    if (e.cat === 'closed') items.push(`<li>The Registrar: ${esc(Q.ruleE)}</li>`);
    const box = items.length ? `<div class="notes-box"><ul class="notes">${items.join('')}</ul></div>` : '';
    const nus = e.cat !== 'closed' && e.notes.length ? `<ul class="sl-nus">${e.notes.map((n) => `<li>${icon('check')}<span>${esc(n.text)} <span class="src">(${esc(n.src)})</span></span></li>`).join('')}</ul>` : '';
    return `<div class="stamps">${stamp(e.ex.status, e.ex.stamp)}</div>${box}${nus}`;
  }
  function row(e, list, applicants, ends) {
    const c = e.c;
    const exam = e.sem ? examAt(c, e.sem) : null;
    const examLine = c.kind === 'ng-listed' ? 'Exam timetable not published in NUSMods'
      : e.sem === null ? (c.exams.lines.join('; '))
        : exam ? `<span class="exl">2026/27 exam</span> <span class="mono">${esc(exam)}</span>` : 'No final exam listed in 2026/27';
    const other = e.sem === 1 ? 2 : 1;
    const listed = (s) => c.ngSemesters.includes(s);
    const semBtns = e.sem === null
      ? act('Sem 1', e.code) + act('Sem 2', e.code)
      : listed(other) ? act(`Move to Sem ${other}`, e.code) : '';
    const name = e.list === 'pick' ? `Pick ${e.rank}` : `Backup ${e.rank}`;
    return `<li class="sl-entry" data-code="${e.code}">
  <div class="sl-side"><p class="sl-rank">${name}</p><p class="sl-sem">${e.sem ? `Sem ${e.sem}` : 'No semester yet'}</p>${formSlot(e, applicants)}</div>
  <h4 class="sl-ehead"><span class="code">${e.code}</span> <span class="title">${esc(c.title)}</span></h4>
  <p class="sl-facts"><span>${c.credits} units · ${esc(c.department)} · Level ${c.level}000</span><span class="exam">${examLine}</span><span>Workload (NUSMods): ${esc(c.workloadText)}</span><span class="count">${countLine(e)}</span></p>
  <div class="sl-guide">${guide(e)}</div>
  ${e.flags.length ? `<div class="sl-flags">${e.flags.map((f) => `<p class="sl-flag">${icon('check')}<span><b>Exams overlap.</b> ${esc(f)}</span></p>`).join('')}</div>` : ''}
  <div class="sl-acts">
    ${act('Move up', e.code, ends.first ? ' aria-disabled="true"' : '')}
    ${act('Move down', e.code, ends.last ? ' aria-disabled="true"' : '')}
    ${act(e.list === 'pick' ? 'Make backup' : 'Make primary', e.code)}
    ${semBtns}
    ${act('Remove', e.code)}
  </div>
</li>`;
  }
  const sum = (es) => es.reduce((n, e) => n + e.c.credits, 0);
  function totals(entries, sem, fullYear) {
    const picks = entries.filter((e) => e.list === 'pick' && e.sem === sem);
    const counted = sum(picks.filter((e) => e.cat === 'counted'));
    const confirm = sum(picks.filter((e) => e.cat === 'confirm'));
    const invited = picks.filter((e) => e.cat === 'invited');
    const out = entries.filter((e) => e.sem === sem && e.cat === 'closed');
    const unplaced = entries.filter((e) => e.sem === null && e.list === 'pick');
    const over20 = sum(picks.filter((e) => e.cat === 'counted' || e.cat === 'confirm' || e.cat === 'invited')) > 20;
    const overlap = entries.some((e) => e.sem === sem && e.flags.length);
    const quota = invited.flatMap((e) => e.ex.reasons.filter((r) => r.kind === 'quota')).map((r) => r.text)[0];
    return `<section class="sl-total" aria-labelledby="tot${sem}"><h4 id="tot${sem}">Sem ${sem} picks</h4>
  <p class="sl-sum"><span class="big"><b class="mono">${counted}</b> units counted, if NUS accepts you into each</span>
  ${confirm ? `<span>plus <b class="mono">${confirm}</b> units to confirm with NUS</span>` : ''}
  ${invited.length ? `<span>plus <b class="mono">${sum(invited)}</b> units only if invited</span>` : ''}
  <span class="sl-src">${counted} units is about ${counted * 2.5} hours a week at NUS’s rate (2.5 hours a week per unit).</span></p>
  ${quota ? `<p class="sl-src">If you were invited: ${esc(quota)}</p>` : ''}
  ${overlap ? '<p class="sl-flag">' + icon('check') + '<span>Picks with overlapping 2026/27 exams: NUS approves at most one of each pair.</span></p>' : ''}
  ${over20 ? `<p class="sl-flag">${icon('check')}<span><b>Over 20 units.</b> ${esc(G2)} This limits the courses NUS enrols you in, not the courses you list.</span></p>` : ''}
  ${out.length || unplaced.length ? `<div class="sl-out"><p class="lbl">Not counted</p>${out.map((e) => `<p><span class="mono">${e.code}</span> (${e.list === 'pick' ? 'pick' : 'backup'}): not on NUS’s 2026/27 exchange course list for Sem ${sem}</p>`).join('')}${unplaced.map((e) => `<p><span class="mono">${e.code}</span> (pick ${e.rank}): no semester chosen; choose Sem 1 or Sem 2 on its row</p>`).join('')}</div>` : ''}
</section>`;
  }
  function formTable(entries, sem, fullYear) {
    const order = entries.filter((e) => e.sem === sem && e.list === 'pick').concat(entries.filter((e) => e.sem === sem && e.list === 'alt'))
      .filter((e) => e.form);
    const used = order.filter((e) => e.form.n).reduce((n, e) => n + e.c.credits, 0);
    return `<table class="sl-ftab"><caption>Sem ${sem} on NUS’s form: ${used} of 40 units</caption>
<thead><tr><th scope="col">No.</th><th scope="col">Course</th><th scope="col">Units</th><th scope="col">On your list</th></tr></thead>
<tbody>${order.map((e) => `<tr><td class="mono${e.form.n ? '' : ' mark'}">${e.form.n ? e.form.n : '–'}</td><th scope="row" class="mono">${e.code}</th><td class="mono">${e.c.credits}</td><td${e.form.n ? '' : ' class="mark"'}>${e.list === 'pick' ? 'Pick' : 'Backup'} ${e.rank}${e.form.n ? '' : ': won’t fit in NUS’s 40 units'}</td></tr>`).join('')}</tbody></table>
${fullYear && sem === 2 ? `<p class="sl-src">${esc(FULLYEAR)}</p>` : ''}`;
  }
  const APPLICANT_LINES = [
    ['NUS recommends listing as many relevant courses as you can, up to 40 units.', 'NUS Global'],
    ['“It is recommended that you rank your compulsory courses among your top three course choices.”', 'NUS Global'],
    ['NUS’s form asks, for each course with a prerequisite, the home course that meets it.', 'NUS’s application guide'],
    ['“If you did not secure any of the popular courses during the first round … please do not repeat your request for any of these courses in subsequent rounds.”', 'NUS Global'],
  ];
  const G2 = 'NUS’s brochure says at most 23 units a semester (NUS Business School’s exchange students: 20); some pages say 20, so ask NUS before going above 20.';
  const LIMIT_LINES = [
    ['To be admitted, NUS must accept you into at least 12 units in a semester.', 'NUS brochure; NUS Global: “three pre-registered courses (or 12 units)”'],
    ['In CourseReg you must keep at least 12 units or three courses.', 'NUS Global'],
    [`${G2} This limits the courses NUS enrols you in, not the courses you list.`, 'G2'],
    ['NUS states hours a week only; your university’s own conversion decides credit.', ''],
    ['“Each semester normally includes 13 weeks of instruction and 2 weeks of examinations.”', 'NUS Global'],
  ];
  const lines = (ls) => `<ul class="sl-lines">${ls.map(([t, s]) => `<li>${esc(t)}${s ? ` <span class="src">(${esc(s)})</span>` : ''}</li>`).join('')}</ul>`;
  const COURSEREG = [
    ['Keep at least 12 units or three courses a semester; drop any course that clashes.', 'NUS Global'],
    ['On Business, Law and Economics courses: “If you are not successful in gaining placements into these popular courses at the point of offer, you are not able to add these courses during CourseReg.”', 'NUS Global'],
    ['Missing the drop deadlines “could lead to a Grade “W” (Withdrawn) or a Grade “F” (Fail) printed on your transcript”.', 'NUS Global'],
    ['The Non-Graduating Office signs your Learning Agreement or Study Plan; “no particular course can be guaranteed by NUS”.', 'NUS Global'],
    ['A course not approved at application can be requested in “Submit Course Requests”, or appealed as “Unable to secure course”. “Students are not allowed to read courses with any kind of timetable clashes.” You can’t drop below the minimum. “You can select courses up to 23 Units in one course request”; above the maximum, a “Max Workload Waiver” appeal.', 'NUS CourseReg FAQ'],
    ['Courses not on the exchange course list “are not available during application stage but may be available during Course registration”.', 'the Registrar, rule E'],
    ['“To check if the course is offered to Non-Graduating students, refer to the Vacancy Report.”', 'NUS CourseReg FAQ'],
    ['Get your home university’s approval before changing your study plan.', 'NUS brochure'],
  ];
  function view(list, opts) {
    const entries = workOut(list);
    const picks = entries.filter((e) => e.list === 'pick');
    const alts = entries.filter((e) => e.list === 'alt');
    const sems = opts.semOrder;
    const ol = (es) => `<ol class="sl-list" role="list">${es.map((e, i) => row(e, e.list, true, { first: i === 0, last: i === es.length - 1 })).join('')}</ol>`;
    const hasBiz = entries.some((e) => e.biz);
    return `<section class="sl-view" aria-labelledby="slTitle">
  <div class="sl-head"><div><h2 class="sl-title" id="slTitle" tabindex="-1">Your shortlist</h2>
    <p class="sl-sub">${esc(opts.sub)}</p>${opts.sentence ? `<p class="sl-sentence">${esc(opts.sentence)}</p>` : ''}</div>
    <button type="button" class="btn sl-close">Back to results</button></div>
  <div class="sl-actions"><div class="btns"><button type="button" class="btn">Copy link</button><button type="button" class="btn">Download CSV</button><button type="button" class="btn">Print or save as PDF</button></div>
    <p class="hint">On a phone: Share, then Print, then pinch out the preview to save the PDF. Excel shows one column? Use Data › From Text/CSV.</p></div>
  ${hasBiz ? `<fieldset class="sl-inv"><legend>Did NUS Business School invite you to apply for its exchange programme (an invitation during the nomination period)?</legend>
    <label class="checkline"><input type="checkbox"${list.inv ? ' checked' : ''}> <span>Yes, NUS Business School invited me</span></label>
    <p class="hint">Business courses count only if it did. If you’re not sure, ask your exchange office.</p></fieldset>` : ''}
  <section class="sl-sec" aria-labelledby="slPicks"><h3 class="lbl" id="slPicks" tabindex="-1">Primary picks <span class="n">${picks.length}</span></h3>${ol(picks)}</section>
  <section class="sl-sec" aria-labelledby="slAlts"><h3 class="lbl" id="slAlts" tabindex="-1">Backups <span class="n">${alts.length}</span></h3>${ol(alts)}</section>
  <section class="sl-sec" aria-labelledby="slTot"><h3 class="lbl" id="slTot">Totals</h3><div class="sl-totals" style="margin-top:14px">${sems.map((s) => totals(entries, s, opts.fullYear)).join('')}</div>
    <div style="margin-top:14px">${lines(LIMIT_LINES)}</div></section>
  <section class="sl-sec sl-formsec" aria-labelledby="slForm"><h3 class="lbl" id="slForm">NUS’s application form order, for applicants</h3>
    <p class="intro">${esc(FORM_INTRO)}</p><div class="sl-forms">${sems.map((s) => `<div>${formTable(entries, s, opts.fullYear)}</div>`).join('')}</div>${lines(APPLICANT_LINES)}</section>
  <section class="sl-box" aria-labelledby="slCR"><h3 id="slCR">Already admitted? NUS’s rules for CourseReg</h3>${lines(COURSEREG)}
    <p class="own">This page can’t see your offer. Your offer and CourseReg show which courses are yours.</p></section>
  <div class="sl-close-lines"><p>Class times and corequisites aren’t checked here: see each course on NUSMods.</p>
    <p>NUS posts each course’s full syllabus on Canvas when the semester starts; the text here is NUS’s course description (the Registrar’s NG course list).</p>
    <p>For courses that have prerequisites, NUS asks for the syllabi of the courses you have completed or are taking (NUS brochure).</p>
    <p class="sl-forget"><button type="button" class="linkbtn">Forget this list on this device</button></p></div>
</section>`;
  }

  const LISTS = {
    // State 2: Sem 1, 2nd year, 4 picks and 2 backups (§2).
    view: { picks: ['CS2113.1', 'GE2101.1', 'PC3270.1', 'ACC1701XA.1'], alts: ['CS3244.1', 'EE4407.1'], inv: false },
    // State 3: a full-year student, Sem changed to 2 in the view (§2).
    fullyear: {
      picks: ['CS2030.1', 'CS3244.2', 'GE2101.1', 'HY1101E', 'ACC1701XA.1', 'EN3264.1', 'PS3251.2', 'MA3220.1', 'ST2137.2', 'GES1034.1', 'LSM2212.1'],
      alts: ['CS2113.1', 'CM3267.1', 'PC3232.1', 'GESS1007.1', 'PC4262.1', 'TS2239.2'], inv: false,
    },
  };
  const picked = (list, sem) => list.picks.map(parse).filter((p) => p.sem === sem).reduce((n, p) => n + C[p.code].credits, 0);
  function stateView() {
    const l = LISTS.view;
    const label = `Sem 1: ${picked(l, 1)} units picked`;
    return page(rail('1', label, true), `${searchForm('ACC1701XB CS2113 CS2030', 'Sem 1', label, true)}
${view(l, { sub: 'Sem 1 · 2nd-year exchange student · NUS’s 2026/27 courses', semOrder: [1], fullYear: false })}`);
  }
  function stateFullYear() {
    const l = LISTS.fullyear;
    const label = `Sem 1: ${picked(l, 1)} · Sem 2: ${picked(l, 2)} units picked`;
    return page(rail('2', label, true), `${searchForm('ACC1701XB CS2113 CS2030', 'Sem 2', label, true)}
${view(l, { sub: 'Sem 1 and Sem 2 · 2nd-year exchange student · NUS’s 2026/27 courses', sentence: `Sem 2 first: ${picked(l, 2)} units picked; Sem 1: ${picked(l, 1)}`, semOrder: [2, 1], fullYear: true })}`);
  }

  // ---- state 4: the print page (6D), built from state 2's list ----
  const LINK = 'https://nusmodfinder.rcn.sh/?pick=CS2113.1&pick=GE2101.1&pick=PC3270.1&pick=ACC1701XA.1&alt=CS3244.1&alt=EE4407.1&ay=2026-2027&ng=1&sem=1&study=ug2&view=shortlist';
  function ppCourse(e) {
    const c = e.c;
    const wl = c.workload && 'total' in c.workload ? c.workload : null;
    const est = c.credits * 2.5;
    const exam = c.kind === 'ng-listed' ? 'exam timetable not published in NUSMods' : examAt(c, e.sem) ? `${examAt(c, e.sem)} (Singapore time)` : 'no final exam listed';
    const count = { counted: 'Counted, if NUS accepts you into it', confirm: c.kind === 'ng-listed' ? `To confirm: NUS lists it for Sem ${e.sem} in 2026/27, but NUSMods shows no classes: ask NUS` : 'To confirm with NUS', invited: 'Only if invited by NUS Business School (not counted until you say so)', closed: `Not counted: not on NUS’s 2026/27 exchange course list for Sem ${e.sem}` }[e.cat];
    const notes = e.ex.reasons.map((r) => `${r.kind === 'closed' ? '' : `${r.lead} `}${r.line}`);
    if (e.cat === 'closed') notes.push(`The Registrar: ${Q.ruleE}`);
    if (e.cat === 'invited') notes.push(`NUS: ${Q.bizGRO}.`, 'If you’re not sure whether you were invited, ask your exchange office.', `NUS’s CourseReg FAQ: ${Q.bizOnly}`);
    const form = e.form && e.form.n ? `Application form, Sem ${e.sem}<b>${e.form.n}</b>` : e.cat === 'invited' ? 'On the form only if invited' : e.cat === 'closed' ? 'Not on the form' : '';
    return `<article class="pp-course"><div class="pp-ch"><div><span class="code">${e.code}</span> <span class="title">${esc(c.title)}</span></div><div class="form">${form}</div>
  <div class="src">${e.list === 'pick' ? 'Primary pick' : 'Backup'} ${e.rank} · Sem ${e.sem} · ${c.credits} units</div></div>
<dl class="pp-facts">
  <dt>Department, faculty</dt><dd>${esc(c.department)}, ${esc(c.faculty)}</dd>
  <dt>Level</dt><dd>${levelText(c.level)}</dd>
  <dt>Counts</dt><dd>${esc(count)}</dd>
  <dt>Exchange status, Sem ${e.sem}</dt><dd>${stamp(e.ex.status, e.ex.stamp)}${notes.length ? `<ul class="pp-list" style="margin-top:4px">${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</dd>
  ${e.cat !== 'closed' && e.notes.length ? `<dt>NUS’s notes</dt><dd><ul class="pp-list">${e.notes.map((n) => `<li>${esc(n.text)} <span class="src">(${esc(n.src)})</span></li>`).join('')}</ul></dd>` : ''}
  <dt>2026/27 exam</dt><dd>${esc(exam)}</dd>
  <dt>Workload (NUSMods)</dt><dd>${wl ? `${esc(c.workloadText)}` : 'not listed'}</dd>
  <dt>Estimated study time</dt><dd>about ${est} hours a week (NUS’s rate: 2.5 hours a week per unit)${wl && wl.total !== est ? `; NUSMods lists ${wl.total} hours a week for this course` : ''}. NUS states hours a week only; your university’s own conversion decides credit.</dd>
  ${e.flags.map((f) => `<dt>Flag</dt><dd>${esc(f)}</dd>`).join('')}
  <dt>Prerequisite</dt><dd>${esc(c.prerequisiteText || 'None listed')}</dd>
  <dt>Preclusion</dt><dd>${esc(c.preclusionText || 'None listed')}</dd>
  <dt>NUSMods</dt><dd><a href="#">https://nusmods.com/courses/${e.code}</a></dd>
</dl>
<p class="pp-lbl" style="margin-top:8px">Course description (NUS, via NUSMods)</p><p class="pp-desc">${esc(c.description)}</p></article>`;
  }
  function statePrint() {
    const entries = workOut(LISTS.view);
    const live = entries.filter((e) => e.cat !== 'closed');
    const closed = entries.filter((e) => e.cat === 'closed');
    const picks = live.filter((e) => e.list === 'pick');
    const alts = live.filter((e) => e.list === 'alt');
    const counted = sum(picks.filter((e) => e.cat === 'counted'));
    const paper = `<div class="sl-paper pp" role="document" aria-label="Print preview">
<div class="pp-head"><h1>Courses planned for Sem 1, based on NUS’s 2026/27 courses, exams and exchange list</h1>
  <p>Year of study during the exchange: 2 · Made on 11 Nov 2026</p>
  <p class="pp-link">${esc(LINK)}</p>
  <p class="src">For a later year, check that year’s: NUS publishes the exchange course list in March or April and updates it later (this one is dated 1 Sep 2026), and publishes the course descriptions and exam timetable in July or August (NUS Global).</p></div>
<h2>Sem 1</h2><h3>Primary picks</h3>${picks.map(ppCourse).join('')}<h3>Backups</h3>${alts.map(ppCourse).join('')}
<h3>Sem 1 totals</h3><ul class="pp-list"><li>Picks: ${counted} units counted, if NUS accepts you into each; plus ${sum(picks.filter((e) => e.cat === 'confirm'))} units to confirm with NUS; plus ${sum(picks.filter((e) => e.cat === 'invited'))} units only if invited</li>
${(() => { const q = picks.filter((e) => e.cat === 'invited').flatMap((e) => e.ex.reasons.filter((r) => r.kind === 'quota'))[0]; return q ? `<li>If you were invited: ${esc(q.text)}</li>` : ''; })()}
<li>${counted} units is about ${counted * 2.5} hours a week at NUS’s rate (2.5 hours a week per unit). NUS states hours a week only; your university’s own conversion decides credit.</li>
<li>“Each semester normally includes 13 weeks of instruction and 2 weeks of examinations.” (NUS Global)</li>
<li>To be admitted, NUS must accept you into at least 12 units in a semester (NUS brochure). NUS’s brochure says at most 23 units a semester (NUS Business School’s exchange students: 20); some pages say 20, so ask NUS before going above 20.</li></ul>
<h2>Closed, or not on NUS’s exchange list, in that semester</h2>${closed.map(ppCourse).join('')}
<div class="pp-break"><span>page break</span></div>
<h2>NUS’s application form order, for applicants</h2><p class="src" style="margin-top:6px">${esc(FORM_INTRO)}</p>
<div style="margin-top:8px">${formTable(entries, 1, false)}</div>
<ul class="pp-list" style="margin-top:8px">${APPLICANT_LINES.map(([t, s]) => `<li>${esc(t)} <span class="src">(${esc(s)})</span></li>`).join('')}</ul>
<div class="pp-foot"><p class="pp-lbl">Already admitted? NUS’s rules for CourseReg</p><ul class="pp-list" style="margin-top:4px">${COURSEREG.map(([t, s]) => `<li>${esc(t)} <span class="src">(${esc(s)})</span></li>`).join('')}<li>This page can’t see your offer. Your offer and CourseReg show which courses are yours.</li></ul>
<ul class="pp-list" style="margin-top:8px"><li>NUS posts each course’s full syllabus on Canvas when the semester starts; the text here is NUS’s course description (the Registrar’s NG course list).</li>
<li>“Transfer of units is entirely at the discretion of your home university.” (NUS Global)</li>
<li>NG course list updated as at 01 Sep 2026; NG course restrictions updated as at 31 Aug 2026.</li>
<li>Class times and corequisites aren’t checked here.</li>
<li>For courses that have prerequisites, NUS asks for the syllabi of the courses you have completed or are taking (NUS brochure).</li>
<li><b>Unofficial. Check with NUS before you register.</b> NUS Mod Finder, nusmodfinder.rcn.sh</li></ul></div>
</div>`;
    return page(null, `<div class="sl-printable sl-paper-wrap"><p class="sl-paper-cap">What “Print or save as PDF” prints, A4 (on a phone, shown at 45%). Paper is always light. The browser places the other page breaks; the one marked is forced, before the foot’s form order.</p>${paper}</div>`);
  }

  function page(railHtml, mainHtml) {
    return `<div class="app" data-view="results">${header()}<div class="layout"${railHtml ? '' : ' style="grid-template-columns:minmax(0,1fr)"'}>${railHtml || ''}<main class="main" id="main" aria-label="Search and results" tabindex="-1">${mainHtml}</main></div>${footer()}</div>`;
  }

  const STATES = {
    results: ['1. Results with three courses shortlisted', 'Both semesters, 2nd year. ACC1701XB and CS2113 are on the list (toggles pressed: filled bookmark, tint, accent edge), CS2030 is not; GE2101 is the third entry, not in these results. The shortlist button sits in the rail outside #panel on a wide screen, and under the search form, outside the search landmark, on a phone.', () => stateResults('Sem 1: 8 · Sem 2: 4 units picked')],
    view: ['2. The shortlist view: Sem 1, 2nd year', 'Four picks and two backups: CS2113 (Computer Science, NUS’s note), GE2101 (a quota note, counted), PC3270 (a semester note, to confirm), ACC1701XA (Business, only if invited); CS3244 (not open in Sem 1: its reason, not counted) and EE4407 (on NUS’s list, no classes in NUSMods).', stateView],
    fullyear: ['3. A full-year student, after changing Sem to 2 in the view', 'One list for the year, each row with its semester and its number on that semester’s form; Sem 2’s totals first; NUS may ask for Sem 2’s choices later; CS2113 (a backup) and CS2030 (a pick) share a 2026/27 exam slot, flagged; HY1101E has no semester yet; PC4262 is the Sem 1 entry past 40 units; ACC1701XA is Business with the box unticked.', stateFullYear],
    print: ['4. The print page', 'Page one (the head and Sem 1’s courses), Sem 1’s totals and the closed entry, the forced page break, then the foot: NUS’s form order, the lines for applicants, the CourseReg rules and the closing lines. Built from state 2’s list.', statePrint],
  };

  const solo = location.hash.match(/^#solo-(results|view|fullyear|print)-(desktop|phone)-(light|dark)$/);
  if (solo) {
    document.documentElement.dataset.theme = solo[3];
    document.documentElement.classList.add('solo');
    if (solo[1] === 'print') document.documentElement.dataset.print = '';
    document.title = solo[1] === 'print' ? 'exchange-shortlist-sem1-2026-27-courses' : `Shortlist mockup: ${solo[1]}`;
    document.body.innerHTML = STATES[solo[1]][2]();
  } else {
    const g = document.getElementById('gallery');
    for (const [id, [h, p]] of Object.entries(STATES)) {
      const sec = document.createElement('section');
      sec.className = 'state';
      sec.id = id;
      const frames = ['light', 'dark'].map((t) => `<div class="pair"><div class="fw d"><p class="fl">Desktop, 1280 × 800 · ${t}</p><div class="scaler"><iframe title="${esc(h)}, desktop, ${t} theme" src="#solo-${id}-desktop-${t}" width="1280" height="800" loading="lazy"></iframe></div></div><div class="fw p"><p class="fl">Phone, 390 × 664 · ${t}</p><iframe title="${esc(h)}, phone, ${t} theme" src="#solo-${id}-phone-${t}" width="390" height="664" loading="lazy"></iframe></div></div>`).join('');
      sec.innerHTML = `<h2>${esc(h)}</h2><p>${esc(p)}</p>${frames}`;
      g.append(sec);
    }
  }
  for (const f of document.querySelectorAll('form')) f.addEventListener('submit', (ev) => ev.preventDefault());
  for (const a of document.querySelectorAll('a[href="#"]')) a.addEventListener('click', (ev) => ev.preventDefault());
  addEventListener('hashchange', () => location.reload());
}());
