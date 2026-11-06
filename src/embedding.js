// @ts-check

// Overridable so the embedding model can be swapped without a code change, and
// so the upstream-failure path (R7) can be exercised against a bogus model id.
export const DEFAULT_MODEL = '@cf/baai/bge-small-en-v1.5';
/** Dimensions of DEFAULT_MODEL's vectors, and of the Vectorize index. */
export const EMBEDDING_DIMS = 384;

/**
 * bge-small-en-v1.5's retrieval instruction (Phase 3 3A-1). It goes in front
 * of the query text only, the canonical query /search embeds; module texts
 * are embedded without it, as the model card prescribes for short queries
 * against passages. The eval reads this export to know which query vectors a
 * ranker needs (eval/lib/embeddings.mjs rankerQueryInstruction).
 */
export const QUERY_INSTRUCTION = 'Represent this sentence for searching relevant passages: ';
