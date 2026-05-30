import * as readline from "node:readline";

/**
 * True iff `answer` is an affirmative response (`y` / `yes`, case-insensitive,
 * surrounding whitespace ignored). Everything else — including the empty
 * string — is treated as "no", so the safe default is always decline.
 */
export function isAffirmative(answer: string): boolean {
  return /^(y|yes)$/i.test(answer.trim());
}

/**
 * Ask a yes/no question on stdin and resolve to the user's choice. Reads a
 * single line; any non-affirmative answer (including empty) resolves false.
 *
 * Callers MUST gate this behind `process.stdin.isTTY`: in a non-interactive
 * context (pipes, CI, the test runner) there is no one to answer, so the
 * caller should pick a safe default instead of blocking on stdin.
 */
export function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(isAffirmative(answer));
    });
  });
}
