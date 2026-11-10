// @ts-check
// Named error classes. For encrypted sets the CLI prints only the class name
// ("eval: holdout run failed (LookLimitError); details withheld"), so each
// class must say on its own what went wrong.

export class EvalError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

/** Wrong key, a ciphertext from another set or slot, or tampering. */
export class DecryptionError extends EvalError {}
/** The holdout key file is missing or malformed. */
export class KeyFileError extends EvalError {}
/** Another look would exceed the set's look limit. */
export class LookLimitError extends EvalError {}
/** The ledger has fewer rows than git's copy, or is missing while git has it. */
export class LedgerTamperError extends EvalError {}
/** Another eval holds the ledger lock. */
export class LedgerLockError extends EvalError {}
/** The qrels were judged on a different corpus than the runs used. */
export class CorpusMismatchError extends EvalError {}
/** A qrels file is malformed (a grade outside 0..2). */
export class QrelsError extends EvalError {}
/** Embedding the missing texts (`--embed-missing`) failed. */
export class EmbeddingError extends EvalError {}
/** The retrieval run did not complete (a query failed, a result is missing, the runner crashed). */
export class RunFailedError extends EvalError {}
/** A run file is missing a result or does not match the query set. */
export class RunFileError extends EvalError {}
/** A ciphertext a verdict reads is missing from MANIFEST.json, differs from it, or the set has no manifest. */
export class ManifestError extends EvalError {}
/** A holdout or SC5 baseline is not the pinned eval-v0 ranker (ref, sha, treeHash or the tag's resolution). */
export class BaselineError extends EvalError {}
/** A `--change-kind cutoff` candidate is not a truncation of its baseline. */
export class CutoffError extends EvalError {}
/** A gate rule asked of a set it does not apply to (a dev-only kind on an encrypted set, `--gate sc5` against the recorded SC5 reading). */
export class GateRuleError extends EvalError {}
/** The compliance rule's frozen reference parse is unavailable (tag `3h` gone or moved) or parses no query of the set. */
export class ReferenceParseError extends EvalError {}
/** The candidate's parse differs from the frozen reference parse on at least one query (no look is spent). */
export class ParseMismatchError extends EvalError {}
/** A judged or returned code has no constraint fields in the compliance rule's source (the pinned snapshot). */
export class ConstraintFieldsError extends EvalError {}

/**
 * The class name to print for an error whose message must stay hidden.
 * @param {unknown} err
 */
export function errorClass(err) {
  if (err instanceof Error) return err.name || err.constructor.name || 'Error';
  return typeof err;
}
