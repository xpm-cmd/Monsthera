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

/** Serialize frontmatter and body back to a markdown string */
export function serializeMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(", ")}]`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  lines.push("---");
  lines.push(""); // blank line after frontmatter
  lines.push(body);

  return lines.join("\n");
}
