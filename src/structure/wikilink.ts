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
 * Extract every `[[...]]` wikilink from markdown content, in document order.
 * Duplicates are preserved — callers dedupe by slug if they only want distinct edges.
 */
export function extractWikilinks(content: string): ExtractedWikilink[] {
  const matches = content.matchAll(/\[\[([^\]]+)\]\]/g);
  return [...matches].map((m) => parseWikilink(m[1]!));
}
