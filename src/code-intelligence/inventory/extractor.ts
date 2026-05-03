/**
 * `SymbolExtractor` — the seam introduced in ADR-017 D2 so M4 (provider
 * bridge) can swap TextMate for tree-sitter behind the same interface.
 *
 * M3 ships a single implementation backed by `vscode-textmate` +
 * `vscode-oniguruma` + per-language `@shikijs/langs`. The implementation
 * itself is intentionally absent from this scaffold; only the contract is
 * pinned here so the MCP/CLI surfaces and tests can be drafted against a
 * stable API.
 */

import type { CodeArtifact } from "./types.js";

export interface SymbolExtractor {
  /**
   * Identifier for diagnostics and telemetry. Examples: `"textmate-shiki"`,
   * `"tree-sitter-curated"`, `"regex-fallback"`.
   */
  readonly name: string;

  /**
   * Languages this extractor supports. Each entry is a Shiki-style
   * language name (`"typescript"`, `"python"`, ...). Used by the
   * dispatch layer to select an extractor for a file.
   */
  readonly languages: readonly string[];

  /**
   * Returns true when this extractor can handle a file with the given
   * extension. Lazy-loading hint: callers should resolve a language for
   * the extension first; this fallback is for extensions that map to
   * multiple languages or to no language at all.
   */
  supports(extension: string): boolean;

  /**
   * Extract declared symbols from a single file's content. Should never
   * throw on malformed input — return an empty array and log at debug if
   * the parse fails.
   *
   * `path` is relative to the repository root. `content` is UTF-8 text.
   */
  extract(input: { readonly path: string; readonly content: string }): Promise<readonly CodeArtifact[]>;
}
