// SC1 oracle: which NUS courses an incoming exchange (Non-Graduating, NG) student may take, AY2026/27.
//
// Written independently from the sources only:
//   - NUS Registrar "Course Restrictions for Non-Graduating Students" (updated 31 Aug 2026)
//   - "Courses in the NUS Self-funded Programmes" (rule A)
//   - YST "Courses for NUS Non-Music Majors" pages, AY26/27 Sem 1 and AY25/26 Sem 2 (rule I9)
//   - Faculty of Law compulsory LLB course listing (image)
//   - docs/evidence/phase4/interpretations.md (R*, C*, I* rows are cited by id below)
//
// oracle(m, ctx) -> 'open' | 'note' | 'closed'. explain(m, ctx) returns the same plus the reasons.
//
// DECISIONS WHERE THE REGISTER IS SILENT (PDF read literally otherwise)
//  D1  sem 'any': the least restrictive of the per-semester results over the course's NG semesters
//      (open < note < closed). This reproduces R3 (shown if NG-listed in either semester; the R2
//      note only if no NG semester is a NUSMods semester) and extends it to the semester-specific
//      YST-page rule (I9).
//  D2  Pattern rules other than C2's three blanket ones (PL328x, FMA120XH, LSM33xx, PC33xx, MA15XX,
//      FMS12XXM, FSCXXXX, SEA5XXX, AIS5xxx, BPS5XXX, CN5XXX, EE5/6, CEG5, EEK5, QF5, MA5/6, ST/DSS5/6,
//      FST5, CE/ESE5/6, IE/MT/SDM5/6, FT/IT/BT/CS/IS/CP5/6) apply by code wherever the course is
//      hosted. None of them touches an NG-listed course outside its own department this year.
//  D3  Department-wide statements apply by NUSMods `department` (I5 generalised); Business, Law and
//      Music sections apply by NUSMods `faculty`.
//  D4  CNM "suffix 'Y'": codes ending in Y in the Communications and New Media department.
//  D5  Rule D/R4 covers levels 5 and 6 only (first digit). Level 0/7/8/9/null courses are not
//      touched by it (none is NG-listed).
//  D6  History "All History (Honours) Level 4000 courses": every level-4 course in the History dept.
//      "FMA120XH": /^FMA120\dH$/ by code.
//  D7  Built Environment "Building undergraduate courses must be taken on graded basis": graded note
//      on Built Environment level 1-4 courses.
//  D8  Centre for Language Studies "Language courses … graded basis": graded note on every course of
//      that department.
//  D9  "All courses cannot be audited" (Malay, South Asian, Southeast Asian Studies): no-audit note on
//      every course of the department.
//  D10 Japanese Studies "All Level 4000 courses – Approval … case-by-case": approval note, not closed.
//  D11 Public Policy: the rule names "Course codes with prefix PP" at every level: closed to
//      undergraduates; graduates get the partner + graded notes, and PP level 5/6 counts as
//      "specified" for graduates (R5).
//  D12 BMA / BMS are named at level 5000 only; closed to undergraduates, partner note for graduates.
//      R7 still applies, so a BMA/BMS code on the self-funded list stays closed.
//  D13 Music audition/placement list: a note in every semester (the NG list governs semesters).
//  D14 YST pages: codes are taken from course headings only, not from prerequisite / preclusion /
//      co-requisite mentions (so NHT2204, CFA2111A, MUL1107 … are not "on the page"). A combined
//      heading (MUA1192/MUA1193/MUA2192/MUA2193, GESS1015/GES1020, CFA2210/…) lists every code.
//  D15 Rule C UROP title match: case-sensitive \bUROPS?\b or /Undergraduate Research Opportunit/i
//      (a case-insensitive "urop" would hit "European").
//  D16 Rule A Public Health "Graduate courses only": level 5 and above. Nursing by department;
//      SCALE (§11) and the Logistics Institute (§12) by faculty (I12).
//  D17 RMI notes by department "Risk Management Institute", whichever faculty hosts it (HS2301 sits
//      under faculty "NUS").
//  D18 Rules that close levels 4000+ "to undergraduate students" (Chinese Studies, ELTS, Political
//      Science, Social Work, Sociology) leave level 4 open to graduates.
//  D19 Malay / South Asian Studies "Graduate Courses" = levels 5 and 6.
//  D20 Table cells "A/B" expand to both codes (PF1103/IPM1103, CN4119/CN4123R, DSE4211/QF4211), and
//      "PC4288A/Q/N", "MA4288P/O" expand the suffix letters.
//  D21 Self-funded list: every code in its code column (2451 codes), including the undergraduate-level
//      ones (CH1101S, BMI1101, XFA4408 …).
//  D22 Title remarks such as "(offered in Sem 2 ONLY)" and "(to be taken with AR2101)" are not rules;
//      the NG list governs semesters.
//  D23 C2's blanket prefixes match the letters before the first digit exactly (CG, DSA, GEH).
//  D24 Notes do not depend on study level unless the sentence names one.
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

const RANK = { open: 0, note: 1, closed: 2 };

const set = (s) => new Set(s.trim().split(/\s+/));

// ---- Rule B ---------------------------------------------------------------------------------------
const RULE_B = set('CM1417X CM1502X CS1010X MA1301X NM1101X PC1221X PC1222X');

// ---- Code tables that close courses (by code, wherever hosted; I14) --------------------------------
const CLOSED_TABLES = {
  'Centre for Language Studies (I2)': 'LAG3203 LAF3203 LAK3203',
  'Communications and New Media (I2, I4)': 'NM2101 NM2103 NM2104 NM4102',
  'English, Linguistics & Theatre Studies (I2)': 'TS3103 TS3245',
  'Japanese Studies (I2)': 'JS2101 JS3101 JS4401 JS4660',
  'Psychology': 'PL2131 PL2132 PL3231 PL3551',
  'Southeast Asian Studies': 'SE2225 SE4101',
  "Dean's Office, School of Computing":
    'CP1008 CP2106 CP2202 CP3107 CP3108A CP3108B CP3109 CP3110 CP3200 CP3201 CP3202 CP3209 CP3880 ' +
    'CP3881 CP4101 IFS3201 IFS3202 IFS4205 XFC4101 UIS2951R UIS2952R UIS3951CS UIS3951R UIS3952CS ' +
    'UIS3952R UIS3953R UIS3954R UIS3955R UIS3956R UIS3957R UIS3958R UIS4951R UIS4952R UIS4953R ' +
    'UIS5951R UIS6951R',
  'Multidisciplinary Programme': 'CG1111A CG2111A CG2271',
  'Computer Science':
    'CP4281 CP4282 CP4283 CP4284 CP4285 CS1101S CS1010S CS1231S CS2030S CS2040 CS2040S CS2102 ' +
    'CS2103 CS2103T CS2106 CS2109S CS2309 CS3216 CS3217 CS3227 CS3233 CS3263 CS3264 CS3281 CS3282 ' +
    'CS4225 CS4238 CS4350 IFS2200 IFS4102 IFS4103',
  'Information Systems and Analytics':
    'BT2102 BT3103 BT4012 BT4013 BT4101 BT4103 BT4106 BT4221 BT4301 CP4286 CP4287 IFS4101 IS2108 ' +
    'IS2109 IS3103 IS3108 IS3109 IS4010 IS4108 IS4151 IS4226 IS4243 IS4250 IS4301',
  'Architecture':
    'AR1101A AR1102 AR1328A AR1329 AR2228 AR5423 AR5807 AR5808 AR5806 AR5121 LA5742 LA5742A ' +
    'LAD1001 LAD1003 LAD1005 LAD2003 LAD3005 LAD4005 LAD4010 UD5221 UD5521 UD5622 UD5628 DEP5104 ' +
    'DEP5102 DEP5105',
  'Biomedical Engineering': 'BN1111 BN2001 BN2111 BN3101 BN4109 BN4101 BN4101R',
  'Built Environment':
    'PF1101 PF1103 IPM1103 PF1107 IPM1102 PF1108 IPM2101 PF2103 IPM2103 PF2107 IPM2102 PF2108 ' +
    'IPM2104 PF2109 IPM3101 PF2110 IPM3102 PF2205 PF3104 PF4101 IPM4101 PF4102 IPM4103 PF4502',
  'Chemical and Biomolecular Engineering': 'CN3101 CN3101A CN3102 CN4102 CN4118 CN4119 CN4123R',
  'Electrical and Computer Engineering': 'EE2033 EE2211 EE3031 EE4002D EE4002R',
  'Industrial Systems Engineering and Management':
    'IE1111R IE2111 IE2141 IE3100R IE3102 IE3102A IE3105 IE3110R IE4100R',
  'Materials Science and Engineering':
    'GEH1057 MLE1001 MLE1001A MLE1001B MLE1002 MLE1010 MLE1101 MLE1111 MLE1112 MLE2001 MLE2001A ' +
    'MLE2106 MLE2107 MLE2111 MLE3101 MLE3103 MLE3111 MLE3111A MLE3112 MLE4101 MLE4101A MLE4101B ' +
    'MLE4102 MLE4102A MLE4204 MLE4209 MLE4213',
  'Mechanical Engineering':
    'ME3000 ME3001 ME4101A ME3163 ME3101 ME3102 ME3243 ME4242 ME2114 ME2143 ME3123 ME3252 RB4101A RB4107',
  'Division of Industrial Design': 'ID4106',
  'Law':
    'LL4011V LL4033V LL4044V LL4045V LL4094AV LL4094BV LL4094CV LL4094DV LL4094EV LL4094FV ' +
    'LL4094GV LL4203 LL4261V LL4367V LL4434V LL4356V LL4359Z LL4361Z LL4377V LL4463V',
  "Dean's Office (Faculty of Science) (I2)":
    'FMS1201D SP2171 SP3173 UIS3921 UIS3922 UIS3923 UIS3924 UIS4921 UIS4922 UIS4923 UIS4924 ZB4199',
  'Biological Sciences': 'LSM2301 LSM3201 LSM4199 LSM4299 SP3203',
  'Chemistry (I2)': 'CM3181 CM4199A CM4199B',
  'Food Science and Technology':
    'FST2288 FST2288R FST2289 FST2289R FST3181 FST3201 FST3287 FST3288 FST3288R FST3289 FST3289R ' +
    'FST4199 FST4277 FST4278 FST4288 FST4299',
  'Mathematics':
    'DSE4211 QF4211 DSE4212 QF4212 HS1501 MA4198 MA4199 MA4288P MA4288O MA4291 QF4204 QF4199 ' +
    'QF4288 DSE4101 DSE4201',
  'Pharmacy':
    'PHS1101 PHS2101 PHS2102 PHS2103 PHS2104 PHS2105 PHS2191 PHS3116 PHS3123 PHS3122 PHS3191 ' +
    'PHS3220 PHS4121 PR1150 PR1151 PR1152 PR1153 PR2156 PR2150 PR2151 PR2152 PR2153 PR2154 PR2155 ' +
    'PR3116 PR3117 PR3122 PR3123 PR3124 PR3136 PR3137 PR3144 PR3145 PR3146 PR3150 PR3151 PR3152 ' +
    'PR3153 PR3154 PR4138 PR4196 PR4197 PR4197A PR4198 PR4198A',
  'Physics':
    'PC2239 PC4288 PC4288A PC4288Q PC4288N PC5101 PC5102 PC5189 PC5203 PC5204 PC5205 PC5207 ' +
    'PC5212 PC5213 PC5214 PC5215 PC5216 PC5218 PC5221 PC5228 PC5233 PC5236 PC5239B PC5252 PC5253 ' +
    'PC5267 PC5271 PC5274 PC5286 PC5287',
  'Statistics and Data Science':
    'DSA1101 DSA2101 DSA3101 DSA3361 DSA3362 DSA4213 DSA4261 DSA4261A DSA4261B DSA4262 DSA4262A ' +
    'DSA4262B DSA4263 DSA4263A DSA4263B DSA4264 DSA4264A DSA4264B DSA4265 DSA4265A DSA4265B ' +
    'DSA4266 DSA4266A DSA4266B DSE1101 DSE3101 DSE4101',
};
const CLOSED_BY_CODE = new Map();
for (const [section, codes] of Object.entries(CLOSED_TABLES)) {
  for (const c of codes.split(/\s+/)) if (!CLOSED_BY_CODE.has(c)) CLOSED_BY_CODE.set(c, section);
}

// Pattern closures (D2). Each: [regex on code, label]. Level 5/6 ones are redundant with R4 but kept.
const CLOSED_PATTERNS = [
  [/^PL328\d/, 'Psychology PL328x (lab courses)'],
  [/^FMA120\dH$/, 'History FMA120XH freshmen seminars'],
  [/^SEA\d/, "Southeast Asian Studies SEA5XXX (I6)"],
  [/^LSM33\d\d/, 'Biological Sciences LSM33xx'],
  [/^FSC\d/, 'Biological Sciences FSCXXXX'],
  [/^FMS12\d\dM$/, 'Mathematics FMS12XXM'],
  [/^MA15\d\d/, 'Mathematics MA15XX'],
  [/^PC33\d\d/, 'Physics PC33xx'],
  [/^AIS5/, 'Physics AIS5xxx'],
  [/^BPS5/, 'Built Environment BPS5XXX'],
  [/^CN5/, 'Chemical Engineering CN5XXX'],
  [/^(CE|ESE)[56]/, 'Civil Engineering CE/ESE 5000/6000'],
  [/^EE[56]/, 'ECE EE5xxx/EE6xxx'],
  [/^CEG5/, 'ECE CEG5xxxx'],
  [/^EEK5/, 'ECE EEK5xxxx'],
  [/^(IE|MT|SDM)[56]/, 'ISEM IE/MT/SDM 5000/6000'],
  [/^(FT|IT|BT|CS|IS|CP)[56]/, 'Computing FT/IT/BT/CS/IS/CP 5000/6000'],
  [/^QF5/, 'Mathematics QF 5000'],
  [/^MA[56]/, 'Mathematics MA 5000/6000'],
  [/^(ST|DSS)[56]/, 'Statistics ST/DSS 5000/6000'],
  [/^FST5/, 'FST level 5000'],
];

// C2: blanket prefix rules, closed within their section's department, a note elsewhere.
const BLANKET = [
  ['CG', "SoC Dean's Office", "All CG coded courses are NOT open (School of Computing Dean's Office)"],
  ['DSA', 'Mathematics', 'Course codes DSAXXXX are NOT open (Mathematics)'],
  ['GEH', 'Mathematics', 'Course codes GEHXXXX are NOT open (Mathematics)'],
];

// ---- Note tables (by code) ------------------------------------------------------------------------
const QUOTA = set(
  // Geography
  'GE2101 GE3216 GE3238 GE3252 ' +
  // History (cross-listed with HY)
  'AS2236 AS2237 AS3230 AS3238 AS3239 AS3240 ' +
  // Built Environment, Semester 1 and Semester 2 tables (I15: every semester)
  'PF2102 PF2305 PF3105 PF3205 PF3208 PF3209 PF3210 PF3211 PF3307 PF3504 PF4209 PF4213 PF4309 ' +
  'IPM4201 GESS1014 PF2203 PF2306 PF2504 PF2505 PF3207 PF3301 PF3305 PF3306 PF3502 PF4203 PF4208 PF4306');

const ARCH_LETTER = set('AR2101 AR2102 AR3101 AR3102 LA4701 LA4702 LA5701 LA5702 LAD2006 LAD2007 LAD3001 LAD3002 LAD4008');
const ARCH_MAJOR = set('AR2225 AR2227 AR2328A AR3722 AR4101 AR4601 AR4321 AR4220');
const LA_MAJOR = set('LAD2004 LAD2005 LAD4006 LAD4012 LAD4003');
const ID_MAJOR = set('ID1121 ID1223 ID2105 ID2106 ID2114 ID2115 ID2116 ID2122 ID3105 ID3106 ID4105 ID2323 ID3122 ID3124 ID2112');
// C4: NG-listed 5000 twins of Architecture-majors-only 4000 courses.
const DUAL_CODED = { AR5221: 'AR4220', AR5321: 'AR4321', AR5601: 'AR4601' };
const NO_AUDIT_CODES = set('AR4321 AR5321 DEP5102');

const MUSIC_AUDITION = set('MUA1192 MUA3224 MUA3205 MUT3113 MUT3213 MUT3214 MUT3215 MUT3216 MUT3222 MUT3223');

// YST "Courses for NUS Non-Music Majors" headings (D14). Sem 2 is AY2025/26's page (I9).
const YST_PAGE = {
  1: set('GEC1014 GEC1023 GESS1015 GES1020 MUH2204 MUT1201 MUT3222 MUT3211 MUA1223 MUA1192 MUA1193 ' +
    'MUA2192 MUA2193 MUA1240 MUA2203 MUA3205 MUA3206 MUA3219 MUA3220 MUA3224 MUA3225 MUA3228 MUA3230 ' +
    'MUL1105 MUL2107 MUL2109 CFA3160 CFA1101A CFA2101A CFA3101A CFA3102A CFA2210 CFA2211 CFA3210 ' +
    'CFA3211 CFA3105 CFA1101B CFA2101B CFA3101B CFA3102B CFA3220 CFA1112'),
  2: set('GEC1014 GEC1023 GESS1015 MUH3203 MUH3205 MUT1201 MUT3113 MUA1165 MUA1223 MUA1192 MUA1193 ' +
    'MUA2192 MUA2193 MUA1240 MUA2204 MUA2230 MUA3205 MUA3206 MUA3208 MUA3217 MUA3219 MUA3220 MUA3224 ' +
    'MUA3225 MUL1106 MUL2108 MUL2110 CFA3160 CFA2210 CFA2211 CFA3210 CFA3105 CFA1101B CFA2101B ' +
    'CFA3101B CFA3220 CFA1220'),
};

// Compulsory LLB courses (law-compulsory-llb-courses.png): 48 codes.
const LLB_COMPULSORY = set(
  'LC1001A LC1001B LC1001C LC1001D LC1001E LC1001F LC1001H ' +
  'LC1002A LC1002B LC1002C LC1002D LC1002E LC1002F LC1002G LC1002H ' +
  'LC1003 LC1004 LC1016 LC2009 LC1025 ' +
  'LC2018 LC2008A LC2008C LC2008D LC2008E LC2008F LC2008G LC2008H LC2007 LC2013 ' +
  'LC2006A LC2006B LC2006C LC2006D LC2006E LC2006F LC2006G LC2006H ' +
  'LC2010A LC2010B LC2010C LC2010E LC2010F LC2010H LC2004 LC2012 ' +
  'LC3001A LC2017');

// ---- Evaluation -----------------------------------------------------------------------------------

/** m: { code, title, department, faculty, level, semesters: number[], ng: boolean, ngSemesters: number[] }
 *  ctx: { sem: 1 | 2 | 'any', study: 'ug1'|'ug2'|'ug3'|'ug4'|'grad' }
 *  returns 'open' | 'note' | 'closed' */
export function oracle(m, ctx) {
  return explain(m, ctx).result;
}

export function explain(m, ctx) {
  if (!m.ng) return { result: 'closed', closed: ['R1: not on the NG list'], notes: [] };
  const ngSems = [...new Set((m.ngSemesters || []).filter((s) => s === 1 || s === 2))];
  if (ctx.sem === 'any') {
    let best = null;
    for (const s of ngSems) {
      const r = evalSemester(m, s, ctx.study);
      if (!best || RANK[r.result] < RANK[best.result] ||
          (r.result === best.result && r.notes.length < best.notes.length)) best = r;
    }
    return best || { result: 'closed', closed: ['R3: no NG semester'], notes: [] };
  }
  return evalSemester(m, ctx.sem, ctx.study);
}

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

/** explain() plus R3's and R6-2's notes: what a card shows. */
export function explainShown(m, ctx) {
  const e = explain(m, ctx);
  if (e.result === 'closed') return e;
  const added = [yearNoteOf(m, ctx.study), levelNoteOf(m, ctx.study)].filter(Boolean);
  return added.length ? { result: 'note', closed: [], notes: [...e.notes, ...added] } : e;
}

/** oracle() plus R3's and R6-2's notes. */
export function oracleShown(m, ctx) {
  return explainShown(m, ctx).result;
}

function evalSemester(m, sem, study) {
  const closed = [];
  const notes = [];
  if (!(m.ngSemesters || []).includes(sem)) closed.push(`NG list does not offer it in Sem ${sem}`);
  if (!(m.semesters || []).includes(sem)) notes.push("R2: the NUSMods timetable doesn't list it in this semester");
  applyRules(m, sem, study, closed, notes);
  const result = closed.length ? 'closed' : notes.length ? 'note' : 'open';
  return { result, closed, notes };
}

function applyRules(m, sem, study, closed, notes) {
  const code = String(m.code).toUpperCase().trim();
  const prefix = (code.match(/^[A-Z]+/) || [''])[0];
  const lvl = m.level ?? (code.match(/\d/) ? Number(code.match(/\d/)[0]) : null);
  const dept = m.department || '';
  const fac = m.faculty || '';
  const title = m.title || '';
  const grad = study === 'grad';
  const ug = !grad;
  const isGradLevel = lvl === 5 || lvl === 6;
  const close = (why) => closed.push(why);
  const note = (why) => notes.push(why);
  let opened = false; // R4: a rule "specifies" this graduate-level course for this study level

  // Rule A
  if (fac === 'Dentistry') close('A: Faculty of Dentistry');
  if (fac === 'Yong Loo Lin Sch of Medicine' && !code.startsWith('LSM')) close('A: Medicine, non-LSM code');
  if (fac === 'SSH School of Public Health' && lvl !== null && lvl >= 5) close('A: Public Health graduate course');
  if (dept === 'Alice Lee Center for Nursing Studies') close('A: Nursing');
  if (fac === 'NUS-ISS') close('A: Institute of Systems Science');
  if (SELF_FUNDED.has(code)) close('A: self-funded programme course');
  if (fac === 'Cont and Lifelong Education') close('§11: SCALE');
  if (fac === 'Logistics Inst-Asia Pac') close('§12: Logistics Institute');

  // Rule B
  if (RULE_B.has(code)) close('B: X-suffix course');

  // Rule C
  if ((fac === 'Arts and Social Science' || fac === 'College of Design and Engineering') &&
      (/\bUROPS?\b/.test(title) || /Undergraduate Research Opportunit/i.test(title))) close('C: UROP');

  // Code tables and patterns
  if (CLOSED_BY_CODE.has(code)) close(`table: ${CLOSED_BY_CODE.get(code)}`);
  for (const [re, label] of CLOSED_PATTERNS) if (re.test(code)) close(`pattern: ${label}`);
  for (const [p, home, text] of BLANKET) {
    if (prefix !== p) continue;
    if (dept === home) close(`C2: ${text}`);
    else note(`C2 restricted elsewhere: ${text}`);
  }

  // ---- 1. Arts & Social Sciences (by department) ----
  switch (dept) {
    case 'Centre for Language Studies':
      note('Language courses: graded basis only, no audit');
      break;
    case 'Chinese Studies':
      if (ug && lvl >= 4 && lvl <= 6) close('Chinese Studies: level 4000-6000 closed to undergraduates');
      break;
    case 'Communications and New Media':
      if (lvl === 4) close('CNM: level 4000 closed');
      if (code.endsWith('Y')) close("CNM: suffix 'Y'");
      break;
    case 'Economics':
      if (lvl >= 4 && lvl <= 6) close('Economics: level 4000-6000 closed');
      if (grad && lvl >= 1 && lvl <= 3) close('Economics: level 1000-3000 closed to graduates');
      break;
    case 'English,Ling.andTheatre Studies':
      if (ug && lvl >= 4 && lvl <= 6) close('ELTS: level 4000-6000 closed to undergraduates');
      if (grad && isGradLevel) { opened = true; note('ELTS graduate course: approval case-by-case'); }
      break;
    case 'Geography':
      if (grad && lvl >= 1 && lvl <= 4) close('Geography: level 1000-4000 closed to graduates');
      if (ug && lvl >= 4 && lvl <= 6) close('Geography: level 4000-6000 closed to undergraduates');
      break;
    case 'History':
      if (lvl === 4) close('History: Honours level 4000 closed');
      break;
    case 'Japanese Studies':
      if (lvl === 4) note('Japanese Studies level 4000: approval case-by-case');
      break;
    case 'Malay Studies':
    case 'South Asian Studies':
      note(`${dept}: cannot be audited`);
      if (lvl === 4 && (study === 'ug1' || study === 'ug2')) close(`${dept}: level 4000 only for 3rd/4th-years and graduates`);
      if (isGradLevel) {
        if (ug) close(`${dept}: graduate courses closed to undergraduates`);
        else { opened = true; note(`${dept} graduate course: approval case-by-case`); }
      }
      break;
    case 'Political Science':
      if (ug && lvl >= 4 && lvl <= 6) close('Political Science: level 4000-6000 closed to undergraduates');
      break;
    case 'Psychology':
      if (lvl >= 4 && lvl <= 6) close('Psychology: level 4000-6000 closed (I3)');
      break;
    case 'Social Work':
      if (ug && lvl >= 4 && lvl <= 6) close('Social Work: level 4000-6000 closed to undergraduates');
      break;
    case 'Sociology and Anthropology':
      if (ug && lvl >= 4 && lvl <= 6) close('Sociology: level 4000-6000 closed to undergraduates');
      if (grad && isGradLevel) { opened = true; note('Sociology graduate course: approval required'); }
      break;
    case 'Southeast Asian Studies':
      note('Southeast Asian Studies: cannot be audited');
      if (code === 'SE3234') note('SE3234: department application form, not online selection');
      if (lvl === 4 && (study === 'ug1' || study === 'ug2')) close('SEA Studies: level 4000 only for 3rd/4th-years and graduates');
      if (lvl === 5) {
        if (study === 'ug4' || grad) opened = true; // I7
        else close('SEA Studies: level 5000 only for 4th-years and graduates');
      }
      if (lvl === 6) {
        if (grad) opened = true;
        else close('SEA Studies: level 6000 only for graduates');
      }
      break;
  }

  // ---- 2. Business (by faculty) ----
  if (fac === 'NUS Business School') {
    note('Business: must be majoring in business at home university (I8)');
    if (lvl === 5 && (prefix === 'BMA' || prefix === 'BMS')) {
      if (ug) close(`Business ${prefix}: not open to undergraduates`);
      else {
        opened = true;
        note(prefix === 'BMA'
          ? 'BMA (MBA): graduate students from Business School partner universities with 1.5 years work experience'
          : 'BMS: CEMS MIM nominees only');
      }
    }
  }

  // ---- 4. Design & Engineering ----
  if (ARCH_LETTER.has(code)) note('Architecture design studio: letter of confirmation from home university');
  if (ARCH_MAJOR.has(code)) note('Architecture majors (or related disciplines) only');
  if (LA_MAJOR.has(code)) note('Landscape Architecture majors (or related disciplines) only');
  if (NO_AUDIT_CODES.has(code)) note('Cannot be read on audit basis');
  if (DUAL_CODED[code]) { opened = true; note(`C4: twin of ${DUAL_CODED[code]}, Architecture majors (or related disciplines) only`); }
  if (dept === 'Built Environment') {
    if (grad && lvl >= 1 && lvl <= 4) close('Built Environment: level 1000-4000 closed to graduates');
    if (lvl >= 1 && lvl <= 4) note('Built Environment undergraduate courses: graded basis only');
  }
  if (QUOTA.has(code)) note('Limited quota');
  if (ID_MAJOR.has(code)) note('Industrial Design students only (I13)');
  if (prefix === 'ID') note('Industrial Design courses: graded basis only (I13)');

  // ---- 5. Law (by faculty) ----
  if (fac === 'Law') {
    note('Law: must be majoring in Law at home university (I10)');
    if (!code.startsWith('LL4')) close('Law: only LL4XXXX electives (I10)');
  }
  if (LLB_COMPULSORY.has(code)) close('Law: compulsory LLB course');

  // ---- 6. Music ----
  if (fac === 'YST Conservatory of Music' && !YST_PAGE[sem].has(code)) {
    note("Music: not on YST's non-music-majors list this semester; YST partner institutions only (I9)");
  }
  if (MUSIC_AUDITION.has(code)) note('Music: audition or placement test required');

  // ---- 7. Public Policy ----
  if (prefix === 'PP') {
    if (ug) close('LKYSPP (PP): not open to undergraduates');
    else {
      if (isGradLevel) opened = true;
      note("LKYSPP (PP): graduate students from LKYSPP's partner universities only");
      note('LKYSPP (PP): graded basis only');
    }
  }

  // ---- 10. RMI ----
  if (dept === 'Risk Management Institute') {
    note('RMI: limited, approval case-by-case');
    note('RMI: per-course tuition fee');
  }

  // ---- Rule D / R4 ----
  if (isGradLevel && !opened) close('D/R4: level 5000/6000 not specified as open for this student');
}

// ---- Rule A: "Courses in the NUS Self-funded Programmes" (self-funded-graduate-courses.txt), every code in
// its code column (D21). Generated by extracting /[A-Z]{2,5}[0-9]{4}[A-Z]{0,4}/ (one code per row).
const SELF_FUNDED = new Set(`
  ABM5001 ABM5002 ABM5003 ABM5004 ABM5101 ABM5102 ABM5103 ABM5104 ABM5105 ABM5106 ABM5107 AC5001
  AC5002 AC5004 AC5007 AC5008 AC5009 AC5010 AC5011 AC5012 AC5014 AC5015 AC5016 ACE5401
  ACE5402 ACE5403 ACE5404 ACE5405 ACE5406 ACE5407 ACE5408 ACE5409 ACE5410 ACE5411 ACE5412 ACE5413
  ACE5414 ACE5480 AI5201 AI5202 AI5203 AI5204 AI5205 AI5206 AI5207 AI5208 AI5209 AI5210
  AI5211 AI5212 AII5003 AR5001 AR5323 ARD5001 ARD5002 ARD5003 ARD5004 ARD5005 ARD5006 ARD5007
  ARD5008 ARD5009 ARD5010 ARD5011 ARD5012 ARD5013 ARD5014 ARD5015 AUD5101 AUD5102 AUD5103 AUD5104
  AUD5105 AUD5106 AUD5107 AUD5108 AUD5109 AUD5110 AUD5111 AUD5112 AUD5113 AUD5114 AUD5115 AUD5216
  AUD5217 AUD5218 AUD5219 AUD5221 AUD5222 AUD5223 BIH5001 BIH5002 BIH5003 BIH5004 BIH5005 BIH5101
  BIH5102 BIH5103 BIH5104 BIH5105 BIH5106 BIS5001 BIS5002 BIS5003 BIS5004 BIS5005 BIS5101 BIS5102
  BIS5103 BIS5104 BIS5105 BIS5106 BL5204 BL5215 BL5216 BL5217 BL5228 BL5232 BL5232A BL5232B
  BL5232C BL5233 BL5234 BL5238 BL5301 BL5302 BL5311 BL5312 BL5313 BL5314 BL5324 BL5331
  BL5611 BL5612 BL5631 BL5632 BL5641 BL5642 BL5643 BL5661 BL5662 BL5690 BL5699R BMA5001
  BMA5002 BMA5002A BMA5003 BMA5004A BMA5005 BMA5008 BMA5009 BMA5010A BMA5011 BMA5011A BMA5013 BMA5014
  BMA5016 BMA5016A BMA5017 BMA5102 BMA5102A BMA5104 BMA5104A BMA5108 BMA5112 BMA5112A BMA5115 BMA5115A
  BMA5118 BMA5118A BMA5118B BMA5119 BMA5120 BMA5121 BMA5122 BMA5122A BMA5123 BMA5124 BMA5125 BMA5126
  BMA5127 BMA5128 BMA5128A BMA5129 BMA5129A BMA5130 BMA5131 BMA5132 BMA5132A BMA5133 BMA5134 BMA5134A
  BMA5135A BMA5136 BMA5137 BMA5138 BMA5138EE BMA5232A BMA5236 BMA5237 BMA5237A BMA5255 BMA5271 BMA5271A
  BMA5274 BMA5277 BMA5278 BMA5300AE BMA5301 BMA5302 BMA5302A BMA5303 BMA5307 BMA5307A BMA5308 BMA5309
  BMA5309A BMA5310 BMA5312 BMA5312A BMA5313 BMA5313A BMA5313C BMA5313D BMA5313E BMA5314 BMA5314A BMA5315A
  BMA5316A BMA5318 BMA5318A BMA5319 BMA5319A BMA5321 BMA5321A BMA5322 BMA5323 BMA5324 BMA5325 BMA5326
  BMA5327 BMA5328 BMA5330 BMA5331 BMA5332 BMA5333 BMA5334 BMA5334A BMA5335 BMA5336 BMA5337 BMA5337A
  BMA5337AE BMA5338 BMA5339 BMA5404 BMA5405 BMA5405A BMA5406 BMA5406EE BMA5409A BMA5411 BMA5411A BMA5412
  BMA5422 BMA5423 BMA5424 BMA5425 BMA5428 BMA5429 BMA5430 BMA5431EE BMA5432 BMA5432A BMA5433 BMA5501
  BMA5502 BMA5502A BMA5503 BMA5503A BMA5504 BMA5504A BMA5505 BMA5506 BMA5509 BMA5511 BMA5511A BMA5515
  BMA5517 BMA5523 BMA5523A BMA5524 BMA5524A BMA5525 BMA5526 BMA5527 BMA5527A BMA5528 BMA5528A BMA5529
  BMA5529A BMA5530 BMA5530A BMA5531 BMA5531A BMA5532 BMA5532A BMA5533 BMA5533A BMA5533AE BMA5534 BMA5535
  BMA5536 BMA5537 BMA5537A BMA5537B BMA5539 BMA5801 BMA5802 BMA5802C BMA5802D BMA5803 BMA5804 BMA5805
  BMA5901 BMA5903 BMA5904A BMA5905 BMC5021 BMC5022 BMC5023 BMC5024 BMC5025 BMC5026 BMC5027 BMC5028
  BMC5029 BMC5030 BMC5031 BMC5032 BMC5033 BMC5034 BMC5035 BMC5035A BMC5035B BMC5035C BMC5035D BMC5035F
  BMC5035G BMC5035H BMC5035N BMC5036 BMC5037 BMC5038 BMC5040 BMC5116 BMC5117 BMC5118 BMC5125 BMC5130
  BMC5203 BMC5231 BMC5305 BMC5306 BMC5337 BMC5411 BMC5415 BMC5501 BMC5502 BMC5601 BMC5707 BMC5808
  BMC5813 BMC5814 BMC5815 BMC5834 BMC5836 BMC5837 BMC5838 BMD5301 BMD5302 BME5014 BME5016 BME5020
  BME5021 BME5022 BME5040 BME5041 BME5042 BME5043 BME5044 BME5045 BME5046 BME5047 BME5049 BME5050
  BME5051 BME5052 BME5053 BME5054 BME5055 BME5056A BME5056B BME5057A BME5057B BME5058 BME5101 BME5102
  BME5103 BME5104 BME5105 BME5106 BME5107 BME5201 BME5201EE BME5202 BME5301 BME5302 BME5401 BME5402
  BME5403 BME5404 BME5405 BME5406 BME5501 BMF5321 BMF5322 BMF5323 BMF5324 BMF5331 BMF5332 BMF5333
  BMF5334 BMF5341A BMF5341B BMF5342 BMF5343 BMF5344 BMF5345 BMF5346 BMF5346A BMF5346B BMF5351 BMF5352
  BMF5353 BMF5354 BMF5355 BMF5356 BMF5357 BMF5358 BMF5359 BMF5360 BMF5361 BMF5362 BMF5363 BMF5391A
  BMF5391B BMF5392 BMF5393A BMG5101 BMG5102 BMG5103 BMG5104 BMG5201 BMG5202 BMG5203 BMG5204 BMG5205
  BMG5206 BMG5301 BMG5302 BMG5303 BMH5101 BMH5102 BMH5103 BMH5104 BMH5105 BMH5106 BMH5107 BMH5108
  BMH5109 BMH5110 BMH5111 BMH5112 BMH5113 BMH5304 BMH5401 BMI1101 BMI1101A BMI1101C BMI1102 BMI2106
  BMI2109 BMI2207 BMI2207C BMI3101 BMI3102 BMI3102C BMI3201 BMI3201C BMI3306 BMI3308 BMI5101 BMI5101B
  BMI5102 BMI5106 BMI5107 BMI5108 BMI5109 BMI5110 BMI5111 BMI5201 BMI5206 BMI5207 BMI5306 BMK5002
  BMK5100 BMK5101 BMK5102 BMK5103 BMK5104 BMK5200 BMK5201 BMK5202 BMK5203 BMK5204 BMK5205 BMK5206
  BMK5206B BMK5206C BMK5206D BMK5206E BMK5206F BMK5206G BMK5206H BMK5207 BMK5208 BMK5209 BMK5210 BMK5300A
  BMO6023A BMO6026A BMP5000 BMP5100 BMP5101 BMP5102 BMP5103 BMP5104 BMP5105 BMP5106 BMP5107 BMP5201
  BMP5202 BMP5300 BMS5103 BMS5104 BMS5105 BMS5106 BMS5107 BMS5108 BMS5109 BMS5110 BMS5111 BMS5112
  BMS5113 BMS5114 BMS5115 BMS5116 BMS5116A BMS5117 BMS5118 BMS5119 BMS5120 BMS5121 BMS5122 BMS5127
  BMS5128 BMS5129 BMS5202 BMS5203 BMS5203S BMS5204 BMS5205 BMS5206 BMS5207 BMS5208 BMS5209 BMS5211
  BMS5302 BMS5303 BMS5304 BMS5305 BMS5306 BMS5307 BMS5308 BMS5309 BMS5310 BMS5311 BMS5312 BMS5313
  BMS5402 BMS5403 BMS5404 BMS5405 BMS5405S BMS5406 BMS5407 BMS5408 BMS5409 BMS5410 BMS5411 BMS5412
  BMS5414 BMS5415 BMS5416 BMS5417 BMS5418 BMS5419 BMS5502 BMS5502A BMS5503 BMS5504 BMS5505 BMS5506
  BMS5507 BMS5508 BMS5509 BMS5510 BMS5511 BMS5512 BMS5513 BMS5514 BMS5515 BMS5516 BMS5517 BMS5518
  BMS5518A BMS5518B BMS5518C BMS5518D BMS5518E BMS5519 BMS5520 BMS5521 BMS5522 BMS5602 BMS5702 BMS5702A
  BMS5702B BMS5801 BMS5802 BMS5900 BMS5900A BMS5902 BMS5903A BMS5903B BMT5100 BMT5101 BMT5102 BMT5103
  BMT5104 BMT5200 BMT5201 BMT5202 BMT5203 BMT5204 BMT5205 BMT5206 BMT5301A BMT5301B BMT5301C BMT5400
  BMT5401A BMT5401B BMT5401C BMU5001 BMU5003 BMU5004 BMU5006 BMU5007 BMU5008 BMU5013 BMU5015 BMX5100
  BMX5101 BN5001 BN5101 BN5102 BN5211 BN5212 BN5501 BN5511 BN5511A BN5512 BN5513 BN5513A
  BN5514 BN5515 BN5516 BN5517 BN5517A BN5518 BPS5000 BPS5111 BPS5112 BPS5221 BPS5222 BPS5223
  BPS5224 BPS5225 BPS5226 BPS5227 BPS5228 BPS5230 BPS5300 BT5110 BT5126 BT5127 BT5151 BT5152
  BT5153 BT5154 BT5155 CAH5101 CAH5102 CAH5103 CAH5104 CAH5105 CAH5106 CCS5101 CCS5102 CCS5103
  CCS5104 CCS5201 CCS5202 CCS5203 CCS5204 CCS5205 CCS5206 CCS5207 CCS5301 CDE5000 CDE5301 CDE5302
  CDE5303 CDE5304 CDE5311 CDE5312 CDE5399D CDE5399E CDE5399T CE5010A CE5010B CE5010QA CE5010QB CE5101
  CE5104A CE5104B CE5104QA CE5104QB CE5106A CE5106B CE5106QA CE5106QB CE5107A CE5107B CE5108A CE5108B
  CE5112 CE5113A CE5113B CE5203 CE5204 CE5205 CE5210 CE5211 CE5214QA CE5214QB CE5307AQA CE5307BQB
  CE5308 CE5308A CE5308B CE5308QA CE5308QB CE5310AB CE5312 CE5312AB CE5313 CE5315AB CE5317A CE5317B
  CE5317QA CE5317QB CE5318AB CE5320 CE5509A CE5509B CE5510A CE5510B CE5510QA CE5510QB CE5516A CE5516B
  CE5516QA CE5516QB CE5610A CE5610B CE5610QA CE5610QB CE5611A CE5611B CE5716 CE5716A CE5716QA CE5717
  CE5717B CE5717QB CE5718A CE5718B CE5718QA CE5718QB CE5719A CE5719B CE5719QA CE5719QB CE5720A CE5720B
  CE5720QA CE5720QB CE5721A CE5721B CE5721QA CE5721QB CE5805A CE5805B CE5805QA CE5805QB CE5806A CE5806B
  CE5806QA CE5806QB CE5807A CE5807B CE5808A CE5808B CE5808QA CE5808QB CE5880 CE5886 CE6001 CE6002
  CE6006 CE6077QA CE6101 CE6102 CE6601 CEG5101 CEG5102 CEG5103 CEG5104 CEG5105 CEG5201 CEG5202
  CEG5203 CEG5204 CEG5205 CEG5301 CEG5302 CEG5303 CEG5304 CEG5305 CH1101S CH2121S CH2221S CH3243S
  CHC5101 CHC5102 CHC5301 CHC5302 CHC5303 CHC5304 CHC5305 CHC5306 CHC5307 CHC5308 CHC5309 CHC5310
  CHC5311 CHC5312 CHC5313 CHC5314 CHC5315 CHC5316 CHC5317 CHC5318 CHC5319 CHC5320 CHC5321 CHC5322
  CHC5323 CHC5324 CHC5325 CHC5326 CHC5327 CHC5328 CHC5330 CHC5331 CHC5332 CHC5333 CHC5334 CHC5335
  CHC5336 CHC5337 CHC5338 CHC5339 CHC5340 CHC5341 CHC5342 CHC5343 CHC5344 CHC5345 CHC5346 CHC5347
  CHC5348 CHC5349 CIT5001 CIT5002 CIT5003 CIT5004 CIT5005 CIT5010 CIT5011 CL1101S CL2101S CL2103S
  CL3104S CM5103 CM5192 CM5212 CM5224 CM5231 CM5244 CM5251 CM5299 CM5311 CM5321 CM5331
  CM5351 CM5731 CMH5101 CMH5102 CMH5103 CMH5104 CMH5105 CMH5201 CMH5202 CMH5203 CMH5301 CMH5302
  CMH5303 CMH5304 CMH5305 CMH5306 CMH5307 CMH5401 CMH5402 CN5010 CN5020 CN5030 CN5040 CN5050
  CN5111B CN5112 CN5124 CN5131 CN5150 CN5160 CN5161 CN5162 CN5181 CN5190 CN5192 CN5192X
  CN5193 CN5194 CN5195 CN5202 CN5204 CN5215 CN5216 CN5219 CN5220 CN5222 CN5252 CN5277
  CN5366 CN5371 CN5391 CN5392 CN5401 CN5432 CN5550 CN5555 CN5555X CN5566 CN5611X CN6020
  CN6162 CN6163 CN6163X CN6222 CN6251 CP5101 CP5102 CP5103 CP5104 CP5105 CS5421 CS5422
  CS5424 CS5425 CS5430 CS5439 CS5446 CS5461 CS5469 CS5476 CS5477 CS5478 DBA5101 DBA5103
  DBA5104 DBA5105 DBA5106 DBA5107 DBA5108 DBA5109 DBA5110 DBA5111 DBA5112 DBA5113 DBA5121 DEP5114
  DEP5116 DEP5117 DEP5118 DEP5119 DEP5120 DI5100 DI5200 DL5101 DL5101P DL5102 DL5102G DL5102P
  DL5103 DL5103P DL5201 DL5201P DL5202 DL5202P DL5203 DL5203P DL5301 DL5301P DL5302 DL5302P
  DL5303 DL5303P DOS5021 DOS5022 DOS5024 DOS5025 DOS5101 DOS5101A DOS5101B DOS5102 DOS5102A DOS5102B
  DOS5103 DOS5104 DOS5105 DOS5106 DOS5107 DOS5109 DSA5102 DSA5103 DSA5104 DSA5105 DSA5106 DSA5201
  DSA5202 DSA5203 DSA5204 DSA5205 DSA5206 DSA5207 DSA5208 DSA5209 DSA5231 DSA5731 DSA5811 DSA5812
  DSA5821 DSA5822 DSA5831 DSA5841 DSA5842 DSA5843 DSC5101 DSC5103 DSC5106 DSC5221A DSS5101 DSS5102
  DSS5103 DSS5104 DSS5105 DSS5201 DSS5202 DSS5203 DSS5210 DSS5211 DTS2701 DTS5001 DTS5002 DTS5003
  DTS5111 DTS5121 DTS5131 DTS5201 DTS5202 DTS5203 DTS5204 DTS5205 DTS5311 DTS5312 DTS5321 DTS5322
  DTS5331 DTS5332 DTS5401 DTS5402 DTS5403 DTS5404 DTS5405 DTS5701 DTS5702 DTS5703 DTS5704 DTS5707
  DTS5708 DTS5710 DTS5713 DTS5720 DTS5721 DTS5722 DTS5723 DTS5724 DTS5725 DTS5726 DTS5727 DTS5731
  DTS5732 DTS5733 DTS5733EC DTS5734 DTS5735 DY5190 EBA5001 EBA5001A EBA5001G EBA5002 EBA5002G EBA5003
  EBA5003G EBA5004 EBA5004G EBA5005 EBA5005G EBA5006 EBA5006G EBA5007 EBA5008 EBA5008G ECA5101 ECA5102
  ECA5103 ECA5304 ECA5305 ECA5307 ECA5308 ECA5313 ECA5315 ECA5325 ECA5333 ECA5334 ECA5335 ECA5337
  ECA5341 ECA5342 ECA5343 ECA5351 ECA5371 ECA5372 ECA5373 ECA5373R ECA5374 ECA5375 ECA5376 ECA5377
  ECA5381 ECA5383 ECA5394 ECA5395 ECA5396 ECA5401 ECA5660 ECA5880 ECA5881 ECA5882 ECA5884 EE5020
  EE5021 EE5022 EE5023 EE5024 EE5025 EE5026 EE5027 EE5028 EE5040 EE5041 EE5042 EE5043
  EE5044 EE5045 EE5046 EE5047 EE5060 EE5061 EE5062 EE5063 EE5064 EE5065 EE5080 EE5101
  EE5103 EE5104 EE5106 EE5110 EE5111 EE5112 EE5113 EE5114 EE5115 EE5131 EE5132 EE5133
  EE5134 EE5135 EE5137 EE5138 EE5139 EE5303 EE5308 EE5311 EE5434 EE5439 EE5441 EE5442
  EE5443 EE5502 EE5507 EE5508 EE5517 EE5518 EE5531 EE5701 EE5702 EE5703 EE5711 EE5713
  EE5731 EE5801 EE5831 EE5902 EE5903 EE5904 EE5907 EE5934 EEK5001 EEK5003 EEK5101 EEK5102
  EEK5103 EEK5104 EEK5105 EEK5106 EEK5107 EEK5301 EEK5302 EEK5888 EG5301 EG5302 EG5303 EHB5101
  EHB5102 EHB5103 EHB5104 ELC5202 ELC5203 ELC5204 ELC5205 ELC5206 ELC5207 ELC5211 ELC5212 ELC5216
  ELC5221 ELC5251 ELC5252 ELC5253 ELC5254 ELC5255 ELC5270 ENC5149 ENC5150 ENC5151 ENC5232 ENC5235
  ENC5238 ENC5239 ENC5241 ENC5242 ENC5244 ENC5247 ENC5248 ENC5252 ENC5253 ENC5261 ENC5262 ENC5263
  ENC5660 ENC5880A ENC5883 ESE5001 ESE5001AB ESE5002 ESE5003 ESE5202 ESE5202A ESE5202AB ESE5202B ESE5203
  ESE5204 ESE5204A ESE5204AB ESE5204B ESE5205 ESE5301 ESE5401 ESE5402 ESE5402A ESE5402AB ESE5402B ESE5403
  ESE5403A ESE5403B ESE5404 ESE5405 ESE5406 ESE5407 ESE5601 ESE5607 ESE5608 ESE5666 ESE5701 ESE5880C
  ESE5901A ESE5901B ESE6001 ESE6002 ESE6003 ESE6301 ETP5311 ETP5322 ETP5331 ETP5332 ETP5341 ETP5381
  EU4660 EU4660HM FE5101 FE5101D FE5103 FE5105 FE5107 FE5107D FE5108 FE5112 FE5112D FE5116
  FE5116D FE5208 FE5209 FE5209D FE5210 FE5212 FE5213 FE5214 FE5218 FE5219 FE5221 FE5222
  FE5223 FE5224 FE5225 FE5226 FE5227 FE5901 FE5902 FE5903 FE5904 FE5905 FE5906 FE5907
  FE5908 FE5909 FE5910 FE5911 FE5912 FE5913 FE5914 FE5915 FSC5201 FSC5202 FSC5203 FSC5204
  FSC5205 FSC5206 FSC5207 FST5198 FST5199 FST5199A FST5199B FST5201 FST5202 FST5202A FST5203 FST5203A
  FST5205 FST5205A FST5206 FST5207 FST5225 FST5226 FST5227 FST5228 FST5301 FST5301A FST5302 FST5303
  FST5303A FT5001 FT5002 FT5003 FT5004 FT5005 FT5007 FT5010 FT5011 FT5012 FT5013 GE5225
  GE5226 GE5227 GE5228 GE5230 GE5231 GMS5151 GMS5152 GMS5153 GMS5154 GMS5155 GMS5156 GMS5191
  GMS5221 GMS5222 GMS5223 GMS5224 GMS5241 GMS5242 GMS5243 GMS5244 GMS5261 GMS5262 GMS5263 GMS5264
  GMS5501 GMS5502 GMS5503 GMS5671 GMS5672 GMS5673 GMS5674 GMS5675 GMS5676 GMS5677 GMS5678 GMS5701
  GMS5702 GMS5703 GMS5704 GMS5711 GMS5712 GMS5721 GMS5722 GMS5749 GMS5806 GMS5807 GMS5808 GMS5848
  GMS5849 GMS6904 GMS6961 HE5001 HE5002 HE5003 HE5004 HE5005 HE5006 HE5101 HE5102 HE5103
  HI5101 HI5102 HI5103 HI5104 HLE5101 HLE5102 HM5102 HM5103 HM5104 HM5105 HM5106 HM5107
  HY5405 HY5406 HY5407 HY5408 HY5408R HY5409 HY5410 HY5411 HY5412 HY5413 HY5415 HY5416
  HY5417 HY5418 HY5419 HY5420 ID5001 ID5002 ID5352 ID5353 ID5354 ID5355 ID5356 ID5357
  ID5358 ID5359 ID5360 ID5361 ID5951 IDE5001 IDE5002 IDE5003 IDE5004 IDE5005 IDE5006 IDE5007
  IDE5008 IDE5009 IDE5010 IDE5011 IE5001 IE5001A IE5001B IE5002 IE5003 IE5004 IE5005 IE5006
  IE5105 IE5105A IE5105B IE5107 IE5121 IE5122 IE5123 IE5125 IE5203 IE5205 IE5206 IE5207
  IE5208 IE5209 IE5268 IE5291 IE5301 IE5307 IE5401 IE5402 IE5405 IE5504 IE5506 IE5708
  IE5866 IE5901 IE5902 IE5903 IE5904 IND5001 IND5002 IND5003 IND5004 IND5005A IND5021 IND5022
  IND5024 IS5010 IS5451 IS5452 ISD5103 ISD5104 ISD5105 ISD5106 ISY5001 ISY5001G ISY5002 ISY5002G
  ISY5003 ISY5003G ISY5004 ISY5004G ISY5005 ISY5005G ISY5007 IT5001 IT5002 IT5003 IT5004 IT5005
  IT5006 IT5007 IT5008 IT5100A IT5100B JSC5101 JSC5102 JSC5103 JSC5201 JSC5202 JSC5203 JSC5204
  JSC5205 JSC5206 JSC5207 JSC5208 JSC5209 JSC5210 JSC5301 JSC5302 JSC5303 JSC5304 JSC5305 JSC5401
  JSC5660 JSC5880 LA5500 LA5742A LA5901 LC5001 LC5010A LC5204A LC5204AV LC5204B LC5204BV LC5225
  LC5262AV LC5262BV LC5262V LC5285V LC5336 LCC5365 LCC5366 LCC5390 LCC5391 LCC5392 LCC5466 LCC5467
  LCC5468 LCC5469 LCC5470 LCD5204A LCD5204AV LCD5204B LCD5204BV LCJ5015 LI5003 LI5101 LI5101A LI5101B
  LI5201 LI5202 LI5203 LI5204 LI5204A LI5204B LL5459X LL5484X LL5485X LL5512S LL5513S LL5532X
  LL5533X LLJ5453 LLJ5482 LLJ5482V LLJ5483 LLJ5483V LLJ5485X MA5248 MA5266 MA5268 MA5270 MA5271
  MA5272 MB5104 MB5105 MCI5001 MCI5002 MCI5003 MCI5004 MCI5005 MCI5006 MCI5007 MCI5009 MDG5252
  MDG5253 MDG5254 MDG5600 ME5209 ME5306 ME5311 ME5400A ME5401 ME5402 ME5404 ME5405A ME5408
  ME5409 ME5410 ME5411 ME5412 ME5413 ME5414 ME5415 ME5416 ME5417 ME5418 ME5419 ME5420
  ME5421 ME5422 ME5423 ME5424 ME5425 ME5513A ME5516 ME5517 ME5518 ME5607 ME5608A ME5608B
  ME5612 ME5614A ME5615A ME5615B ME5616 ME5701 ME5888M ME5888R ME6108 ME6509 ME6601 MEM5101
  MEM5102 MEM5103 MEM5104 MLE5001 MLE5002 MLE5101 MLE5102 MLE5208 MLE5210 MLE5211 MLE5212 MLE5213
  MLE5214 MLE5215 MLE5216 MLE5217 MLE5218 MLE5219 MLE5220 MLE5221 MLE5222 MLE5223 MLE5224 MLE5225
  MLE5226 MLE5228 MLE5229 MLE5230 MLE5231 MLE5232 MLE5233 MLE5234 MLE5235 MLE5236 MLE5238 MLE5239
  MLE5240 MLE5241 MLE5243 MLE5244 MLE5245 MLE5247 MLE5301 MLE5302 MLE5303 MLE5304 MSI5001 MSI5002
  MSI5003 MSI5004 MSI5005 MSI5006 MSI5102 MST5001 MST5002 MST5666 MT5001 MT5001G MT5002 MT5003
  MT5006 MT5006A MT5006B MT5007 MT5007A MT5007B MT5007G MT5007H MT5008 MT5008A MT5008B MT5010
  MT5010A MT5010B MT5011 MT5012 MT5013 MT5014 MT5015 MT5016 MT5017 MT5020 MT5020A MT5021
  MT5022 MT5023 MT5024 MT5025 MT5026 MT5027 MT5766 MT5866 MT5880 MT5880A MT5880B MT5880C
  MT5900 MT5903 MT5911 MT5921 MTM5001 MTM5002 MTM5004 MTM5005 MTM5101 MUA5121 MUA5122 MUA5123
  MUA5124 MUA5160 MUA5163 MUA5170 MUA5171 MUA5172 MUA5173 MUA5174 MUA5175 MUA5176 MUA5177 MUA5178
  MUA5264 MUA5770 MUA6178 MUH5201 MUH5202 MUT5201 MW5201 NHS3911N NHS3911PL NHS4911PS NLM5001 NLM5002
  NLM5003 NLM5004A NLM5004B NLM5005 NLM5006 NLM5007 NLM5008 NLM5009 NMC5301 NMC5302 NMC5303 NMC5306
  NMC5308 NMC5322 NMC5323 NMC5324 NMC5325 NMC5326 NMC5341 NMC5342 NMC5343 NMC5344 NMC5346 NMC5362
  NMC5364 NMC5367 NMC5368 NMC5369 NUR5502 NUR5504 NUR5505 NUR5506 NUR5507 NUR5508 NUR5609 NUR5610
  NUR5613 NUR5701 NUR5702 NUR5703 NUR5704 NUR5711 NUR5712 NUR5721 NUR5722 NUR5723 NUR5731 NUR5732
  NUR5733 NUR5801G NUR5802G NUR5803G NUR5804G NUR5805G NUR5806G NUR5807 NUR5808 NUR5811A NUR5811B NUR5811C
  NUR6101 NUR6102 NUR6103 NUR6104 NUR6110A NUR6110B OPT5101 OPT5102 OPT5103 OPT5104 OPT5105 OPT5106
  OT5202A OT5202B OT5203A OT5203B OT5204A OT5204B OT5206A OT5206B OT5401A OT5401B OT5402A OT5402B
  OT5403A OT5403B OT5405A OT5405B OT5406A OT5406B OT5901 OT5902 OT5903 OT5904 OT5905 OT5906
  OT5907 OT5908 OT5909 OT5910 OT5911 OT5912 PC5101 PC5102 PC5102D PC5189 PC5201 PC5202
  PC5203 PC5204 PC5204B PC5205 PC5206 PC5207 PC5209 PC5210 PC5211 PC5212 PC5213 PC5214
  PC5215 PC5216 PC5218 PC5221 PC5228 PC5233 PC5236 PC5239B PC5247 PC5251 PC5252 PC5253
  PC5267 PC5271 PC5274 PC5286 PC5287 PC5287D PC5731 PHC5001 PHC5002 PHC5003 PHC5004 PHC5005
  PHC5006 PHC5007 PHC5101 PHC5102 PHC5103 PHC5104 PHC5105 PHC5106 PHC5107 PHC5108 PHC5201 PHC5202
  PHC5211 PHC5212 PHM5001 PHM5002 PHM5003 PHM5004 PHM5005 PHM5006 PHM5007 PHM5008 PHM5009 PHM5010
  PHM5011 PHM5012 PHM5013 PHM5014 PHM5015 PHM5016 PHM5017 PHM5018 PLC5001 PLC5002 PLC5003 PLC5004
  PLC5005 PLC5006 PLC5007 PLC5008 PLC5009 PM5000 PM5101 PM5103 PM5105 PM5106 PM5107 PM5112
  PM5113 PM5114 PM5115 PM5116 PM5117 PM5118 PM5119 PM5120 PP5269M PP5701 PP5702 PP5703
  PP5704 PP5705 PP5706 PP5707 PP5711 PP5712 PP5713 PP5714 PP5715 PP5716 PP5717 PP5718
  PP5721 PP5722 PP5723 PP5724 PP5725 PP5727 PP5728 PP5729 PP5730 PP5731 PP5732 PP5901
  PP5903 PP5904 PP5908 PP5910 PP5911 PP5912 PP5916 PR5134 PR5135 PR5137 PR5198 PR5203
  PR5210 PR5213 PR5215 PR5218 PR5219 PR5220 PR5225 PR5227 PR5237 PR5238 PR5304 PR5399
  QF5201 QF5201A QF5202 QF5202A QF5203 QF5203A QF5204 QF5205 QF5205A QF5206 QF5206A QF5207
  QF5207A QF5209 QF5209A QF5210 QF5211 QF5211A QF5212 QF5212A QF5213 QF5214 QF5215 RE5001
  RE5003 RE5004 RE5005 RE5006 RE5009 RE5011 RE5013 RE5014 RE5015 RE5016 RE5017 RE5018
  RE5019 RE5020 RE5021 RE5022 SEA5101 SEA5102 SEA5201 SEA5202 SEA5203 SEA5211 SEA5212 SEA5213
  SEA5214 SEA5221 SEA5222 SEA5223 SEA5224 SEA5231 SEA5232 SEA5233 SEA5234 SEA5235 SEA5236 SEA5237
  SEA5238 SEA5880 SH5001 SH5001C SH5002 SH5002C SH5003 SH5003C SH5004 SH5004C SH5005 SH5005C
  SH5101 SH5101C SH5102 SH5102C SH5103 SH5103C SH5104 SH5104C SH5105 SH5105C SH5106 SH5106C
  SH5107 SH5107C SH5108 SH5108C SH5109 SH5109C SH5110 SH5110C SH5201 SH5201C SH5202 SH5202C
  SH5203 SH5203C SH5204 SH5204C SH5205 SH5205C SH5206 SH5206C SH5207 SH5207C SH5208 SH5208C
  SH5209 SH5209C SH5401 SH5401C SH5402 SH5402C SH5403 SH5403C SH5404 SH5404C SH5405 SH5405C
  SH5406 SH5406C SH5407 SH5407C SH5408 SH5408C SH5409 SH5409C SH5666 SH5880 SH5880C SH5881
  SH5881C SH5882 SH5882C SLP5101 SLP5102 SLP5104 SLP5105 SLP5106 SLP5107 SLP5108 SLP5110 SLP5111
  SLP5114 SLP5115 SLP5117 SM5001 SM5002 SM5003 SM5004 SM5101 SM5102 SPH6901 SPH6902 SPH6903
  SPH6904 SPH6905 ST5188 ST5201 ST5201X ST5202 ST5202X ST5203 ST5206 ST5207 ST5208 ST5209
  ST5209X ST5210 ST5211 ST5211X ST5212 ST5213 ST5215 ST5218 ST5221 ST5223 ST5225 ST5226
  ST5227 ST5228 ST5229 ST5230 ST5290 ST6101 ST6104 SW5115 SWD5104 SWE5001 SWE5001G SWE5002
  SWE5002G SWE5003 SWE5003G SWE5004 SWE5004G SWE5005 SWE5005G SWE5006 SWE5006G SWE5007 SWK5070 SWK5071
  SWK5074 SWK5075 SWK5076 SWM5104 SWM5106 SWM5107 SWM5117A SWM5117B SWM5205 SWM5206 SWM5207 SWM5208
  SWM5209 SWM5210 SWM5211 SWM5213 SWM5215 SWM5215R SWM5216 SWM5217 SWM5218 SWM5219 SWM5220 SWM5245
  SWM5252 SWM5253 SWM5254 SWM5881 SWM5883 SWM5884 TIC2401 TIC3302 TPS5101 TPS5201 TPS5202 TPS5203
  TPS5212 TPS5213 TPS5214 TPS5215 TPS5216 TPS5232 TPS5241 TPS5242 TPS5243 TR5049 TR5101 TR5102
  UD5221 UD5521 UD5624 UD5625 UD5626 UD5628 UD5641 VM5101 VM5102 VM5103 VM5104 VM5105
  VM5106 XFA4408 XFA4417EC
`.trim().split(/\s+/));
