// @ts-check
// A yes/no question on the terminal, for the steps that change production by hand (rollback,
// d1:restore). Without a terminal (CI, a pipe) the answer is no: pass --yes instead.

/**
 * @param {string} question
 * @returns {Promise<boolean>}
 */
export async function askYes(question) {
  if (!process.stdin.isTTY) return false;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}
