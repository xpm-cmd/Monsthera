// Helpers genuinely shared by more than one rule family. Single-family
// helpers stay inside their family's module — only cross-family code lives
// here. Bodies are moved verbatim from the original src/work/lint.ts.

/**
 * Extract the (trimmed) full line containing `index`, used to build the
 * `lineHint` carried by findings. Shared by the anti-example token-drift
 * rule and the verify-density rule.
 */
export function extractLineForIndex(text: string, index: number): string {
  const lineStart = text.lastIndexOf("\n", index) + 1;
  const lineEnd = text.indexOf("\n", index);
  return text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
}
