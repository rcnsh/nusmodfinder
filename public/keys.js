// @ts-check
// Keyboard handling shared by the page's inputs (Phase 5 5B, F9).

/**
 * Whether a keydown is an Enter that should submit. While an IME is composing
 * (Chinese, Japanese, Korean input), Enter confirms the candidate, so it must
 * not submit a half-typed query: `isComposing` covers current browsers, and
 * keyCode 229 covers Safari, which reports the confirming keydown after
 * composition ends.
 * @param {{ key: string, isComposing: boolean, keyCode: number }} e a KeyboardEvent
 */
export function isSubmitEnter(e) {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}
