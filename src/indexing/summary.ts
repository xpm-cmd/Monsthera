import type { ExtractedSymbol, ParseResult } from "./parser.js";

/**
 * Generate a structural summary of a file based on its parsed symbols.
 * Summaries are concise one-line-per-symbol descriptions used in Evidence Bundles.
 */
export function generateSummary(filePath: string, parseResult: ParseResult): string {
  const parts: string[] = [];

  const classes = parseResult.symbols.filter((s) => s.kind === "class");
  const functions = parseResult.symbols.filter((s) => s.kind === "function");
  const methods = parseResult.symbols.filter((s) => s.kind === "method");
  const types = parseResult.symbols.filter((s) => s.kind === "type");
  const variables = parseResult.symbols.filter((s) => s.kind === "variable");

  if (classes.length > 0) {
    parts.push(`Classes: ${classes.map((s) => s.name).join(", ")}`);
  }
  if (functions.length > 0) {
    parts.push(`Functions: ${functions.map((s) => s.name).join(", ")}`);
  }
  if (methods.length > 0) {
    parts.push(`Methods: ${methods.map((s) => s.name).join(", ")}`);
  }
  if (types.length > 0) {
    parts.push(`Types: ${types.map((s) => s.name).join(", ")}`);
  }
  if (variables.length > 0) {
    const topVars = variables.slice(0, 10);
    const suffix = variables.length > 10 ? ` (+${variables.length - 10} more)` : "";
    parts.push(`Variables: ${topVars.map((s) => s.name).join(", ")}${suffix}`);
  }

  parts.push(`${parseResult.lineCount} lines`);

  if (parseResult.imports.length > 0) {
    parts.push(`${parseResult.imports.length} imports`);
  }

  return parts.join(" | ");
}

/**
 * Generate a raw summary for files that couldn't be parsed by tree-sitter
 * (unsupported language, parse error, etc.)
 */
export function generateRawSummary(filePath: string, content: string): string {
  const lines = content.split("\n");
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return `${lines.length} lines | extension: ${ext}`;
}
