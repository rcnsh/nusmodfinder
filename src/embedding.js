// @ts-check

// Overridable so the embedding model can be swapped without a code change, and
// so the upstream-failure path (R7) can be exercised against a bogus model id.
export const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';
/** Dimensions of DEFAULT_MODEL's vectors, and of the Vectorize index. */
export const EMBEDDING_DIMS = 384;
