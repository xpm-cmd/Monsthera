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

/**
 * Walk `content` and produce a list of segments tagged as either "code"
 * (inside HTML comments, fenced code blocks, or inline code) or "text"
 * (everything else). Callers can safely mutate only the "text" segments
 * and re-concatenate — offsets and content of "code" segments are
 * preserved verbatim.
 *
 * Exported for use by rewriteWikilinkSlug; mirrors the strip rules of
 * stripCodeRegions but keeps the code content instead of deleting it.
 */
function segmentByCodeRegions(content: string): { kind: "text" | "code"; value: string }[] {
  // Match any code-like region: HTML comment, fenced code block, or inline code.
  //
  // We compose this from a string so we can use backreferences that span the
  // whole pattern: group 1 is the fenced-opener (3+ backticks/tildes),
  // group 2 is the inline-opener (1-3 backticks). Each alternative references
  // its own opener to enforce matching-length close, which is important so
  // a longer run of backticks doesn't prematurely close a shorter inline span
  // (and vice versa).
  const CODE_REGION = new RegExp(
    "<!--[\\s\\S]*?-->" +
      "|" +
      "(?:^|\\n)[ \\t]{0,3}(`{3,}|~{3,})[^\\n]*\\n[\\s\\S]*?\\n[ \\t]{0,3}\\1[ \\t]*(?=\\n|$)" +
      "|" +
      "(`{1,3})(?:(?!\\2)[^\\n])+?\\2",
    "g",
  );

  const segments: { kind: "text" | "code"; value: string }[] = [];
  let lastIdx = 0;
  for (const match of content.matchAll(CODE_REGION)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > lastIdx) {
      segments.push({ kind: "text", value: content.slice(lastIdx, start) });
    }
    segments.push({ kind: "code", value: match[0] });
    lastIdx = end;
  }
  if (lastIdx < content.length) {
    segments.push({ kind: "text", value: content.slice(lastIdx) });
  }
  return segments;
}

/**
 * Rewrite all `[[old-slug]]` / `[[old-slug|display]]` / `[[old-slug#anchor]]`
 * wikilinks in `content` to use `new-slug`, preserving display text and anchor
 * exactly. Wikilinks inside HTML comments, fenced code blocks, and inline code
 * are left alone — the rewrite is inline-text only.
 *
 * Matching is exact-slug only: `[[foo-bar]]` is NOT rewritten when `oldSlug`
 * is `foo`. Returns the rewritten content and the number of replacements made.
 *
 * Implementation approach: segment the content into alternating text/code
 * regions (segmentByCodeRegions), rewrite wikilinks only inside text
 * segments, and re-concatenate. This preserves exact byte content of code
 * regions including example wikilinks used as templates.
 */
export function rewriteWikilinkSlug(
  content: string,
  oldSlug: string,
  newSlug: string,
): { content: string; replacementCount: number } {
  if (oldSlug === newSlug) {
    return { content, replacementCount: 0 };
  }

  const segments = segmentByCodeRegions(content);
  let replacementCount = 0;
  const rewritten = segments.map((seg) => {
    if (seg.kind === "code") return seg.value;
    return seg.value.replace(/\[\[([^\]]+)\]\]/g, (whole, inner: string) => {
      const parsed = parseWikilink(inner);
      if (parsed.slug !== oldSlug) return whole;
      replacementCount += 1;
      const anchorPart = parsed.anchor ? `#${parsed.anchor}` : "";
      const displayPart = parsed.display ? `|${parsed.display}` : "";
      return `[[${newSlug}${anchorPart}${displayPart}]]`;
    });
  });
  return { content: rewritten.join(""), replacementCount };
}
