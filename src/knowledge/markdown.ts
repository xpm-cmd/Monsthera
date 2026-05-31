import { ok, err } from "../core/result.js";
import type { Result } from "../core/result.js";
import { ValidationError } from "../core/errors.js";

/** Parsed markdown structure (raw frontmatter + body) */
export interface ParsedMarkdown {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/** Parse a YAML value string into a typed value */
function parseValue(raw: string): unknown {
  const trimmed = raw.trim();

  // Inline array: [a, b, c]
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner.split(",").map((s) => s.trim());
  }

  // Quoted string (double or single)
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Number
  if (trimmed !== "" && !isNaN(Number(trimmed))) return Number(trimmed);

  // Plain string (including empty)
  return trimmed;
}

/** Parse a markdown string with YAML frontmatter delimited by --- */
export function parseMarkdown(raw: string): Result<ParsedMarkdown, ValidationError> {
  // 1. Normalize line endings (CRLF → LF)
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 2. Check for opening ---
  if (!normalized.startsWith("---\n") && normalized !== "---") {
    return err(new ValidationError("Missing frontmatter delimiters"));
  }

  // 3. Find the closing --- (must be on its own line AFTER the opening ---)
  //    Search from position 4 (after "---\n")
  const afterOpen = 4;
  const closingWithNewline = normalized.indexOf("\n---\n", afterOpen - 1);
  const closingAtEnd = normalized.endsWith("\n---")
    ? normalized.length - 4
    : -1;

  let closingPos: number;
  let bodyStart: number;

  if (closingWithNewline !== -1) {
    closingPos = closingWithNewline;
    bodyStart = closingWithNewline + 5; // skip "\n---\n"
  } else if (closingAtEnd !== -1) {
    closingPos = closingAtEnd;
    bodyStart = normalized.length; // no body
  } else {
    return err(new ValidationError("Missing frontmatter delimiters"));
  }

  // 4. Extract YAML block between delimiters
  const yamlBlock = normalized.slice(afterOpen, closingPos);

  // 5. Extract body after second delimiter, stripping the conventional blank separator line
  const rawBody = normalized.slice(bodyStart);
  const body = rawBody.startsWith("\n") ? rawBody.slice(1) : rawBody;

  // 6. Parse YAML lines into Record<string, unknown>
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;

  for (const line of yamlBlock.split("\n")) {
    // Skip empty lines
    if (line.trim() === "") continue;

    // List item under current key
    const listMatch = line.match(/^[ \t]+-[ \t]+(.*)$/);
    if (listMatch !== null && currentKey !== null) {
      const item = listMatch[1]?.trim() ?? "";
      const existing = frontmatter[currentKey];
      if (Array.isArray(existing)) {
        existing.push(item);
      } else {
        frontmatter[currentKey] = [item];
      }
      continue;
    }

    // Key: value line
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1);
    const valueRaw = rest.trimEnd();

    currentKey = key;

    // If value part is empty (just whitespace or nothing) → start of list or empty string
    if (valueRaw.trim() === "") {
      // Don't set a value yet — a list may follow, or it's genuinely empty
      frontmatter[key] = "";
    } else {
      frontmatter[key] = parseValue(valueRaw);
    }
  }

  return ok({ frontmatter, body });
}

/**
 * Serialize a single frontmatter value to its inline YAML string form:
 * arrays become `[a, b, c]`, everything else is stringified bare. Shared by
 * `serializeMarkdown` (full write) and `patchFrontmatter` (minimal-diff write)
 * so the two paths produce byte-identical values for a given input.
 */
export function serializeFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.join(", ")}]`;
  }
  return String(value);
}

/** Serialize frontmatter and body back to a markdown string */
export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    lines.push(`${key}: ${serializeFrontmatterValue(value)}`);
  }

  lines.push("---");
  lines.push(""); // blank line after frontmatter
  lines.push(body);

  return lines.join("\n");
}

/**
 * Patch only the named frontmatter keys in a raw markdown string, preserving
 * every other byte — other frontmatter lines (and their original quoting and
 * spacing) and the entire body — exactly. This is the minimal-diff write path
 * used by `update`, so a single-field edit no longer canonicalizes the whole
 * file (collapsing block-style lists to flow, stripping quotes, reordering).
 *
 * `changes` maps a frontmatter key to its already-serialized replacement value
 * (use `serializeFrontmatterValue`). Returns `null` — the signal for the caller
 * to fall back to a full `serializeMarkdown` — unless the document is safe to
 * line-patch:
 *   - it opens with `---\n` and has a `\n---\n` closing delimiter,
 *   - every frontmatter line is a single-line `key:` entry (no block-style
 *     list items, no indented continuations, no blank lines), and
 *   - every changed key is present on its own line.
 * That guard is what keeps block-style / external corpora safe: they take the
 * unchanged full-serialize path rather than being half-patched.
 */
export function patchFrontmatter(raw: string, changes: Record<string, string>): string | null {
  const OPEN = "---\n";
  if (!raw.startsWith(OPEN)) return null;

  // The first `\n---\n` after the opening delimiter closes the frontmatter.
  // Frontmatter lines are all `key: value`, so this can't false-match a value.
  const closeIdx = raw.indexOf("\n---\n", OPEN.length);
  if (closeIdx === -1) return null;

  const frontmatterText = raw.slice(OPEN.length, closeIdx);
  const rest = raw.slice(closeIdx); // closing delimiter + body, kept verbatim

  const unseenKeys = new Set(Object.keys(changes));
  const patchedLines: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    const keyMatch = line.match(/^([A-Za-z0-9_]+):/);
    if (keyMatch === null) return null; // block-style / non-simple line → unsafe
    const key = keyMatch[1]!;
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      unseenKeys.delete(key);
      patchedLines.push(`${key}: ${changes[key]}`);
    } else {
      patchedLines.push(line);
    }
  }

  if (unseenKeys.size > 0) return null; // a changed key had no line to patch

  return OPEN + patchedLines.join("\n") + rest;
}
