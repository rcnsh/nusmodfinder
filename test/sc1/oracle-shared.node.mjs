// The SC1 oracle's year-invariant readings (Phase 7 7E: moved out of the 2026/27 oracle, as
// written): R3's year-of-study note, read from a course's NUS prerequisite, and R6-2's GRO level
// 4000 note. Neither depends on a year's PDFs, so every year's oracle (test/sc1/oracle-<year>.node.mjs)
// imports them from here, and the selector (test/sc1/oracle.mjs) re-exports them.
//
// R3 (Jacob's ruling, docs/decisions/0008-phase5-frontend-plan.md): a NUS prerequisite that requires an
// undergraduate year of study ("must be Year N") leaves the status above alone, but an undergraduate
// whose home year is below N gets an "ask NUS" note on a course that is not closed. explainShown() and
// oracleShown() add it; explain() and oracle() stay the Registrar's lists only (what ingest stores).
// The prerequisite text is read here with its own tokenizer and parser:
//  Y1  Only unambiguous texts: no "if undertaking" (the whole rule is for undergraduates, and it names no
//      graduate degree), or exactly one, "if undertaking (an) Undergraduate Degree then", at the start.
//  Y2  The text is parsed into AND / OR groups by its brackets. A level holding both AND and OR has no
//      stated precedence: ambiguous. Words side by side with no keyword ("… inclusive ( must … )") are
//      read as AND.
//  Y3  A "must be (in) Year a[, b] [or c]" item binds when every group around it is an AND group. One
//      that is an alternative anywhere above (an OR group, or an ambiguous one) gives no note.
//  Y4  "or greater" (and higher, better, above, more) after a GPA or units figure is a comparison, not OR.
//  Y5  Several binding items: the one with the highest lowest year. The note fires when the home year
//      (ug1..ug4 = 1..4) is below that lowest year; a home year above every year named is not R3's case.
//
// R6-2 (Jacob's ruling, docs/decisions/0010-phase6-shortlist-plan.md): NUS Global (GRO), "Incoming Exchange
// Students": "Higher level undergraduate courses (e.g. course code starting from 4000 & above) have very
// limited supply and are usually NOT available to exchange students." It leaves the status above alone, but
// a course that is not closed gets it as a note (a condition, like a quota). explainShown() and
// oracleShown() add it. Read here as:
//  G1  NUS's undergraduate courses run from 1000 to 4000 (the "Exchange at NUS" brochure: "1000–3000:
//      Undergraduate courses; 4000: Honours courses; 5000–6000: Not open to exchange students"; rule D:
//      level 5000 and 6000 courses are graduate courses). So the undergraduate courses "from 4000 & above"
//      are those whose code's first digit is 4. A graduate course is rule D's and the departments' business.
//  G2  Undergraduate exchange students only (ug1..ug4): GRO's list is of "courses available to undergraduate
//      exchange students" (phase 6 plan, C5-m1: no note for a graduate).
//  G3  Not Law (C5-m1): §5 opens only LL4 electives to exchange students, so every Law course on the list
//      is level 4000 and NUS Law, not the general pool, decides who takes it. By NUSMods `faculty` (D3).

// ---- R3: the year-of-study note ---------------------------------------------------------------------

/** The years an unambiguous prerequisite requires of every undergraduate (Y1-Y5), ascending, or null. */
export function prereqYears(prerequisite) {
  if (!prerequisite || !/\byear\b/i.test(prerequisite)) return null;
  // NUS glues its capital keywords to the next word or bracket ("DANDmust", "XDPANDmust", ")OR("),
  // and after a lower-case word, a digit or a bracket ("DegreeTHEN", "Year 4AND").
  const spaced = prerequisite
    .replace(/(AND|OR|THEN)(?=[a-z(])/g, ' $1 ')
    .replace(/([a-z0-9)])(AND|OR|THEN)\b/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  const ifs = spaced.match(/if undertaking/gi) || [];
  let body = spaced;
  if (ifs.length > 1) return null;
  if (ifs.length === 1) {
    const m = spaced.match(/^(\(\s*)?if undertaking (an )?undergraduate degree then\b(.*)$/i);
    if (!m) return null;
    body = m[3];
    if (m[1]) {
      if (!body.trim().endsWith(')')) return null;
      body = body.trim().slice(0, -1);
    }
  } else if (/graduate/i.test(spaced.replace(/undergraduate/gi, ''))) return null;

  // Tokens: brackets, AND, OR, YEAR items and words.
  const tokens = [];
  const re = /\(|\)|must be (?:in )?year (\d(?: ?, ?\d)*(?: or \d)?)(?![\d,])|\bor (?:greater|higher|better|above|more)\b|\b(and|or)\b|[^()\s]+/gi;
  for (const t of body.matchAll(re)) {
    if (t[0] === '(' || t[0] === ')') tokens.push({ k: t[0] });
    else if (t[1] !== undefined) tokens.push({ k: 'year', years: t[1].split(/ ?, ?| or /).map(Number).sort((a, b) => a - b) });
    else if (t[2] !== undefined) tokens.push({ k: t[2].toLowerCase() });
    else tokens.push({ k: 'word' });
  }
  if (!tokens.some((t) => t.k === 'year')) return null;

  // Recursive descent: group := item* ; item := '(' group ')' | year | word ; operators between items.
  let at = 0;
  const group = () => {
    const node = { ops: new Set(), kids: [] };
    while (at < tokens.length && tokens[at].k !== ')') {
      const t = tokens[at++];
      if (t.k === 'and' || t.k === 'or') node.ops.add(t.k);
      else if (t.k === '(') {
        node.kids.push(group());
        if (tokens[at]?.k !== ')') throw new Error('unbalanced');
        at++;
      } else if (t.k === 'year') node.kids.push(t);
    }
    return node;
  };
  let tree;
  try {
    tree = group();
    if (at !== tokens.length) return null; // a stray ')'
  } catch {
    return null;
  }
  const binding = [];
  const walk = (node, andPath) => {
    for (const kid of node.kids) {
      if (kid.k === 'year') { if (andPath) binding.push(kid.years); }
      else walk(kid, andPath && !kid.ops.has('or'));
    }
  };
  walk(tree, !tree.ops.has('or'));
  if (!binding.length) return null;
  binding.sort((a, b) => b[0] - a[0]);
  return binding[0];
}

/** R3's note for (m, study), or null. */
export function yearNoteOf(m, study) {
  const home = { ug1: 1, ug2: 2, ug3: 3, ug4: 4 }[study];
  if (!home) return null;
  const years = prereqYears(m.prerequisite);
  if (!years || home >= years[0]) return null;
  return `R3: NUS's prerequisite lists it for Year ${years.join('/')}`;
}

// ---- R6-2: GRO's level 4000 note -----------------------------------------------------------------------

/** R6-2's note for (m, study) (G1-G3), or null. */
export function levelNoteOf(m, study) {
  if (!['ug1', 'ug2', 'ug3', 'ug4'].includes(study)) return null;
  const firstDigit = (String(m.code).match(/\d/) || [''])[0];
  if (firstDigit !== '4' || m.faculty === 'Law') return null;
  return 'R6-2: GRO, level 4000 undergraduate courses have very limited supply';
}
