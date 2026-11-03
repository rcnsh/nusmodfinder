// @ts-check
// Fake Workers AI for the eval runner: returns real bge-small-en-v1.5
// vectors precomputed by scripts/embed.mjs, looked up by
// sha256(model + "\n" + text). Any text without one is a loud failure, never
// a made-up vector, so the eval can only ever measure real embeddings.

/**
 * @typedef {{ model: string, dims: number, keys: string[], b64: string }} Lookup
 */

/** @param {string} b64 */
function decodeFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/** @param {string} s */
async function sha256Hex(s) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class LookupAI {
  /** Every call, in order (the shape test/fakes.js uses). */
  /** @type {{ method: string, args: unknown[] }[]} */
  calls = [];
  /** Texts asked for that had no precomputed vector, since the last reset. */
  /** @type {string[]} */
  missing = [];

  /** @param {Lookup} lookup */
  constructor(lookup) {
    this.model = lookup.model;
    this.dims = lookup.dims;
    this.vectors = decodeFloat32(lookup.b64);
    if (this.vectors.length !== lookup.keys.length * lookup.dims) {
      throw new Error(`eval fake AI: ${this.vectors.length} floats for ${lookup.keys.length} keys x ${lookup.dims} dims`);
    }
    /** @type {Map<string, number>} */
    this.rows = new Map(lookup.keys.map((k, i) => [k, i]));
  }

  /**
   * @param {string} model
   * @param {{ text: string | string[] }} input
   */
  async run(model, input) {
    this.calls.push({ method: 'run', args: [model, input] });
    const texts = Array.isArray(input?.text) ? input.text : [input?.text ?? ''];
    if (model !== this.model) {
      throw new Error(`eval fake AI: no precomputed embeddings for model ${model} (have ${this.model})`);
    }
    /** @type {number[][]} */
    const data = [];
    /** @type {string[]} */
    const missingKeys = [];
    for (const text of texts) {
      const key = await sha256Hex(`${model}\n${text}`);
      const row = this.rows.get(key);
      if (row === undefined) {
        this.missing.push(text);
        missingKeys.push(key.slice(0, 12));
        continue;
      }
      data.push(Array.from(this.vectors.subarray(row * this.dims, (row + 1) * this.dims)));
    }
    if (missingKeys.length) {
      // Names the key prefix, never the text: holdout query text must not
      // reach logs or error output.
      throw new Error(
        `eval fake AI: no precomputed embedding for ${missingKeys.length} text(s) (sha256 ${missingKeys.join(', ')}); `
          + 'run `npm run eval:embed` locally to add them',
      );
    }
    return { shape: [texts.length, this.dims], data, pooling: 'mean' };
  }
}
