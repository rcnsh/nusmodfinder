// @ts-check
import { inflateSync } from 'node:zlib';

/**
 * @typedef {{ dict: string, stream: Buffer | null }} PdfObject
 */

/**
 * @param {Buffer} buf
 * @returns {Map<number, PdfObject>}
 */
function objects(buf) {
  const text = buf.toString('latin1');
  /** @type {Map<number, PdfObject>} */
  const out = new Map();
  const re = /(\d+) 0 obj\b/g;
  /** @type {RegExpExecArray | null} */
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const endObj = text.indexOf('endobj', start);
    const streamAt = text.indexOf('stream', start);
    if (streamAt !== -1 && streamAt < endObj) {
      const dict = text.slice(start, streamAt);
      let dataStart = streamAt + 'stream'.length;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      const direct = /\/Length (\d+)(?!\s+\d+\s+R)/.exec(dict);
      const endStream = direct ? dataStart + Number(direct[1]) : text.indexOf('endstream', dataStart);
      let data = buf.subarray(dataStart, endStream);
      if (/\/FlateDecode/.test(dict)) data = inflateSync(data);
      out.set(Number(m[1]), { dict, stream: data });
      re.lastIndex = text.indexOf('endobj', endStream);
    } else {
      out.set(Number(m[1]), { dict: text.slice(start, endObj), stream: null });
      re.lastIndex = endObj;
    }
  }
  return out;
}

/** @param {string} s */
const refOf = (s) => Number(/(\d+) 0 R/.exec(s)?.[1] ?? NaN);

/** @param {string} cmap */
function toUnicode(cmap) {
  /** @type {Map<string, string>} */
  const map = new Map();
  const hexText = (/** @type {string} */ h) => {
    const units = [];
    for (let i = 0; i < h.length; i += 4) units.push(parseInt(h.slice(i, i + 4), 16));
    return String.fromCharCode(...units);
  };
  const width = /<([0-9A-Fa-f]+)>\s*<[0-9A-Fa-f]+>/.exec(/begincodespacerange([\s\S]*?)endcodespacerange/.exec(cmap)?.[1] ?? '')?.[1].length ?? 4;
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(p[1].toUpperCase(), hexText(p[2]));
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(p[1], 16);
      const hi = parseInt(p[2], 16);
      const dsts = p[3].startsWith('[') ? [...p[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((x) => x[1]) : null;
      const base = dsts ? 0 : parseInt(p[3].slice(1, -1), 16);
      for (let c = lo; c <= hi; c += 1) {
        const key = c.toString(16).toUpperCase().padStart(p[1].length, '0');
        map.set(key, dsts ? hexText(dsts[c - lo] ?? '') : String.fromCodePoint(base + (c - lo)));
      }
    }
  }
  return { map, bytes: width / 2 };
}

/** @param {string} s */
function literalBytes(s) {
  const out = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch !== '\\') { out.push(ch.charCodeAt(0)); continue; }
    i += 1;
    const e = s[i];
    const simple = /** @type {Record<string, number>} */ ({ n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 });
    if (e in simple) out.push(simple[e]);
    else if (/[0-7]/.test(e)) {
      const oct = /^[0-7]{1,3}/.exec(s.slice(i))?.[0] ?? e;
      out.push(parseInt(oct, 8));
      i += oct.length - 1;
    }
  }
  return out;
}

/** @param {Map<number, PdfObject>} objs */
function pageOrder(objs) {
  const root = [...objs.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const pagesRef = refOf(/\/Pages\s+(\d+ 0 R)/.exec(root?.dict ?? '')?.[1] ?? '');
  /** @type {PdfObject[]} */
  const out = [];
  /** @param {number} n */
  const walk = (n) => {
    const o = objs.get(n);
    if (!o) return;
    if (/\/Type\s*\/Page\b/.test(o.dict)) { out.push(o); return; }
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(o.dict)?.[1] ?? '';
    for (const k of kids.matchAll(/(\d+) 0 R/g)) walk(Number(k[1]));
  };
  walk(pagesRef);
  return out;
}

/**
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function pdfPages(buf) {
  const objs = objects(buf);
  /** @type {Map<number, { map: Map<string, string>, bytes: number }>} */
  const fonts = new Map();
  /** @param {number} ref */
  const fontOf = (ref) => {
    if (!fonts.has(ref)) {
      const f = objs.get(ref);
      const cmapRef = refOf(/\/ToUnicode\s+(\d+ 0 R)/.exec(f?.dict ?? '')?.[1] ?? '');
      const cmap = objs.get(cmapRef)?.stream?.toString('latin1') ?? '';
      fonts.set(ref, cmap ? toUnicode(cmap) : { map: new Map(), bytes: /\/Type0/.test(f?.dict ?? '') ? 2 : 1 });
    }
    return /** @type {{ map: Map<string, string>, bytes: number }} */ (fonts.get(ref));
  };
  return pageOrder(objs).map((page) => {
    const fontDict = /\/Font\s*<<([^>]*)>>/.exec(page.dict)?.[1] ?? '';
    /** @type {Map<string, number>} */
    const names = new Map([...fontDict.matchAll(/\/(\w+)\s+(\d+) 0 R/g)].map((x) => [x[1], Number(x[2])]));
    const contents = /\/Contents\s*(\[[^\]]*\]|\d+ 0 R)/.exec(page.dict)?.[1] ?? '';
    const streams = [...contents.matchAll(/(\d+) 0 R/g)].map((x) => objs.get(Number(x[1]))?.stream?.toString('latin1') ?? '');
    let text = '';
    /** @type {{ map: Map<string, string>, bytes: number } | null} */
    let font = null;
    /** @param {number[]} bytes */
    const show = (bytes) => {
      if (!font) return;
      for (let i = 0; i + font.bytes <= bytes.length; i += font.bytes) {
        const key = bytes.slice(i, i + font.bytes).map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
        text += font.map.get(key) ?? '';
      }
    };
    /** @param {string} hex */
    const hexBytes = (hex) => {
      const clean = hex.replace(/\s+/g, '');
      const out = [];
      for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2).padEnd(2, '0'), 16));
      return out;
    };
    for (const s of streams) {
      const tokens = /\/(\w+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]*)>\s*Tj|\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
      for (const t of s.matchAll(tokens)) {
        if (t[1]) { font = fontOf(names.get(t[1]) ?? NaN); continue; }
        if (t[2] !== undefined) { show(hexBytes(t[2])); continue; }
        if (t[3] !== undefined) { show(literalBytes(t[3])); continue; }
        for (const part of (t[4] ?? '').matchAll(/<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\)/g)) {
          show(part[1] !== undefined ? hexBytes(part[1]) : literalBytes(part[2]));
        }
      }
    }
    return text;
  });
}

/** @param {Buffer} buf */
export const hasStructTree = (buf) => /\/StructTreeRoot\s+\d+ 0 R/.test(buf.toString('latin1'));

/** @param {Buffer} buf */
export const pdfFonts = (buf) => [...new Set([...buf.toString('latin1').matchAll(/\/BaseFont\s*\/(?:[A-Z]{6}\+)?([^\s/>]+)/g)].map((m) => m[1]))].sort();

/** @param {string} s */
export const squash = (s) => s.normalize('NFKC').replace(/\s+/g, '');
