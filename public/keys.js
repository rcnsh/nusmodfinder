// @ts-check

/** @param {{ key: string, isComposing: boolean, keyCode: number }} e */
export function isSubmitEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}

/** @param {{ key: string, isComposing: boolean, keyCode: number }} e */
export function isCloseEscape(e) {
  return e.key === 'Escape' && !e.isComposing && e.keyCode !== 229;
}
