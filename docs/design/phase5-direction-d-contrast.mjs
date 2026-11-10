// Direction D ("Annotated catalogue"): WCAG contrast for every token pair d.html uses.
// Run: node d-contrast.mjs   (exit code 1 if any pair fails)
const t = {
  // design tokens (must match :root in d.html)
  ground: '#F7F8F6',     // page
  surface: '#FFFFFF',    // inputs, open entry sheet, hidden-codes box
  panel: '#F0F2EF',      // notes asides, sources box, quotes
  ink: '#1E2723',        // text
  ink2: '#4B5651',       // secondary text
  edge: '#7A8580',       // control boundaries
  accent: '#6A2E56',     // links, Search, selection, focus
  accentTint: '#F4EAF0', // chosen option / opened variant background
  onAccent: '#FFFFFF',
  open: '#2F6343', openTint: '#EDF4EF',
  note: '#7D4E12', noteTint: '#FAF3E6',
  hide: '#973B30', hideTint: '#FBEEEC',
  // framing bar and gallery chrome (neutral, not part of the design)
  fBg: '#F2F2F2', fInk: '#1A1A1A', fMuted: '#565656', fPage: '#FFFFFF',
};

const pairs = [
  // [foreground, background, use, minimum]
  ['ink', 'ground', 'body text, titles, codes, exam times', 4.5],
  ['ink', 'surface', 'text in inputs, tiles, the open sheet', 4.5],
  ['ink', 'panel', 'note text, sources, quotes', 4.5],
  ['ink', 'accentTint', 'opened variant code, chosen option title', 4.5],
  ['ink2', 'ground', 'secondary text (department, units, labels)', 4.5],
  ['ink2', 'surface', 'secondary text on the sheet and tiles', 4.5],
  ['ink2', 'panel', 'note sources and scope lines', 4.5],
  ['ink2', 'accentTint', 'chosen tile months', 4.5],
  ['accent', 'ground', 'links, chosen segment, "your semester"', 4.5],
  ['accent', 'surface', 'links on the sheet and hidden box', 4.5],
  ['accent', 'panel', 'links inside asides', 4.5],
  ['accent', 'accentTint', 'chosen semester segment label, tick', 4.5],
  ['onAccent', 'accent', 'Search button label', 4.5],
  ['open', 'openTint', 'Open stamp text', 4.5],
  ['note', 'noteTint', 'Open-with-notes stamp text', 4.5],
  ['hide', 'hideTint', 'Not-shown stamp text', 4.5],
  ['open', 'ground', 'Open mark in the key', 3],
  ['note', 'ground', 'notes mark in the key', 3],
  ['hide', 'ground', 'not-shown mark in the key', 3],
  ['note', 'panel', 'notes aside left rule', 3],
  ['hide', 'surface', 'hidden-box left rule', 3],
  ['edge', 'ground', 'UI boundary: inputs, chips, buttons', 3],
  ['edge', 'surface', 'UI boundary: inputs on white, sheet edge', 3],
  ['accent', 'ground', 'UI boundary: focus ring, chosen option border', 3],
  ['accent', 'surface', 'UI boundary: focus ring on white', 3],
  ['fInk', 'fBg', 'framing bar text', 4.5],
  ['fMuted', 'fBg', 'framing bar sentence', 4.5],
  ['fMuted', 'fPage', 'state captions', 4.5],
];

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

let fails = 0;
for (const [fg, bg, use, min] of pairs) {
  const r = ratio(t[fg], t[bg]);
  const ok = r >= min;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2).padStart(5)}:1  (≥${min})  ${fg} ${t[fg]} on ${bg} ${t[bg]}  — ${use}`);
}
console.log(fails ? `\n${fails} pair(s) fail` : `\nAll ${pairs.length} pairs pass`);
process.exit(fails ? 1 : 0);
