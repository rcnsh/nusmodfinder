// @ts-check

export class EvalError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = new.target.name;
  }
}

export class DecryptionError extends EvalError {}
export class KeyFileError extends EvalError {}
export class LookLimitError extends EvalError {}
export class LedgerTamperError extends EvalError {}
export class LedgerLockError extends EvalError {}
export class CorpusMismatchError extends EvalError {}
export class QrelsError extends EvalError {}
export class EmbeddingError extends EvalError {}
export class RunFailedError extends EvalError {}
export class RunFileError extends EvalError {}
export class ManifestError extends EvalError {}
export class BaselineError extends EvalError {}
export class CutoffError extends EvalError {}
export class GateRuleError extends EvalError {}
export class ReferenceParseError extends EvalError {}
export class ParseMismatchError extends EvalError {}
export class ConstraintFieldsError extends EvalError {}

/** @param {unknown} err */
export function errorClass(err) {
  if (err instanceof Error) return err.name || err.constructor.name || 'Error';
  return typeof err;
}
