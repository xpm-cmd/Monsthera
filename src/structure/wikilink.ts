/** A wikilink extracted from markdown content. */
export interface ExtractedWikilink {
  readonly slug: string;
  readonly display: string | null;
  readonly anchor: string | null;
}

/**
 * Parse the inner text of a single `[[...]]` wikilink.
 * Handles Obsidian pipe-syntax (`slug|display`) and anchor suffixes (`slug#anchor`).
 * Input is the content between `[[` and `]]`, already without the brackets.
 */
export function parseWikilink(raw: string): ExtractedWikilink {
  const trimmed = raw.trim();
  const pipeIdx = trimmed.indexOf("|");
  const slugPart = pipeIdx >= 0 ? trimmed.slice(0, pipeIdx) : trimmed;
  const display = pipeIdx >= 0 ? trimmed.slice(pipeIdx + 1).trim() : null;

  const hashIdx = slugPart.indexOf("#");
  const slug = hashIdx >= 0 ? slugPart.slice(0, hashIdx).trim() : slugPart.trim();
  const anchor = hashIdx >= 0 ? slugPart.slice(hashIdx + 1).trim() : null;

  return { slug, display: display === "" ? null : display, anchor: anchor === "" ? null : anchor };
}

/**
 * Remove code regions from markdown before wikilink extraction.
 * Strips (in order): HTML comments, fenced code blocks, inline code.
 * Replaces removed regions with an empty string — offsets are not preserved.
 *
 * Processing order matters: triple-backtick fences must be handled before
 * inline code, otherwise the inline-code regex would chew through the fence
 * openers and leave the content exposed. HTML comments come first because
 * they can legitimately contain fence-looking content that should stay opaque.
 *
 * Caveats:
 * - Fenced blocks require a matching close fence on its own line. Unclosed
 *   fences leak their content through to the wikilink extractor; that's
 *   acceptable — authors should close their fences.
 * - The inline-code regex uses a backref so an open run of N backticks only
 *   closes on a run of exactly N backticks, matching CommonMark semantics
 *   closely enough for wikilink-stripping purposes.
 */
export function stripCodeRegions(content: string): string {
  let result = content;

  // 1. HTML comments (multiline, first --> closes, per HTML spec — no nesting).
  result = result.replace(/<!--[\s\S]*?-->/g, "");

  // 2. Fenced code blocks: 3+ backticks or tildes, line-anchored, same-fence close.
  //    The closing fence must be the same character and at least as long as the
  //    opener. We require matching length via backref (\2) which is slightly
  //    stricter than CommonMark but good enough for stripping purposes.
  result = result.replace(/^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*$/gm, "");

  // 3. Inline code: 1-3 backticks, non-greedy, does not cross newlines.
  //    The (?!\1) lookahead ensures a run opened with N backticks won't
  //    be closed by a shorter run.
  result = result.replace(/(`{1,3})(?:(?!\1)[^\n])+?\1/g, "");

  return result;
}

/**
 * Extract every `[[...]]` wikilink from markdown content, in document order.
 * Duplicates are preserved — callers dedupe by slug if they only want distinct edges.
 *
 * Content inside fenced code blocks, inline code, and HTML comments is excluded
 * before extraction (see stripCodeRegions) so template placeholders and example
 * snippets don't leak into the graph as missing references.
 */
export function extractWikilinks(content: string): ExtractedWikilink[] {
  const stripped = stripCodeRegions(content);
  const matches = stripped.matchAll(/\[\[([^\]]+)\]\]/g);
  return [...matches].map((m) => parseWikilink(m[1]!));
}
