export function prereqYears(prerequisite) {
  if (!prerequisite || !/\byear\b/i.test(prerequisite)) return null;
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

  const tokens = [];
  const re = /\(|\)|must be (?:in )?year (\d(?: ?, ?\d)*(?: or \d)?)(?![\d,])|\bor (?:greater|higher|better|above|more)\b|\b(and|or)\b|[^()\s]+/gi;
  for (const t of body.matchAll(re)) {
    if (t[0] === '(' || t[0] === ')') tokens.push({ k: t[0] });
    else if (t[1] !== undefined) tokens.push({ k: 'year', years: t[1].split(/ ?, ?| or /).map(Number).sort((a, b) => a - b) });
    else if (t[2] !== undefined) tokens.push({ k: t[2].toLowerCase() });
    else tokens.push({ k: 'word' });
  }
  if (!tokens.some((t) => t.k === 'year')) return null;

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
    if (at !== tokens.length) return null;
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

export function yearNoteOf(m, study) {
  const home = { ug1: 1, ug2: 2, ug3: 3, ug4: 4 }[study];
  if (!home) return null;
  const years = prereqYears(m.prerequisite);
  if (!years || home >= years[0]) return null;
  return `year-of-study: NUS's prerequisite lists it for Year ${years.join('/')}`;
}

export function levelNoteOf(m, study) {
  if (!['ug1', 'ug2', 'ug3', 'ug4'].includes(study)) return null;
  const firstDigit = (String(m.code).match(/\d/) || [''])[0];
  if (firstDigit !== '4' || m.faculty === 'Law') return null;
  return 'level-4000: GRO, level 4000 undergraduate courses have very limited supply';
}
