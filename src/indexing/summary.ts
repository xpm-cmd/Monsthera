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

/**
 * Generate a rich summary for Markdown files.
 * Extracts headings (for use as "symbols" in FTS5) and body text
 * so that documentation files become searchable by content, not just path.
 */
export function generateMarkdownSummary(
  filePath: string,
  content: string,
): { summary: string; headings: string[] } {
  const lines = content.split("\n");

  // Extract headings (# lines) — these become FTS5 "symbols" (weight 2.0)
  const headings: string[] = [];
  for (const line of lines) {
    const match = line.match(/^#{1,6}\s+(.+)/);
    if (match) {
      headings.push(match[1]!.trim());
    }
  }

  // Strip markdown syntax from body text for FTS5 indexing
  const bodyText = lines
    .filter((l) => !l.startsWith("#") && !l.startsWith("```"))
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")     // images FIRST (![alt](url) contains [alt](url))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → text
    .replace(/[*_~`]+/g, "")                   // bold, italic, strikethrough, code
    .replace(/\n{2,}/g, "\n")
    .trim();
  const bodySnippet = bodyText.slice(0, 500);

  const parts: string[] = [];
  if (headings.length > 0) {
    parts.push(`Headings: ${headings.join(", ")}`);
  }
  parts.push(`${lines.length} lines`);
  if (bodySnippet) {
    parts.push(bodySnippet);
  }

  return { summary: parts.join(" | "), headings };
}
