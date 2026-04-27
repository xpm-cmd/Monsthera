import * as path from "node:path";

/** Strip line/column anchors from a code reference while preserving the original display value elsewhere. */
export function normalizeCodeRef(ref: string): string {
  return ref
    .replace(/#L\d+(?:C\d+)?$/i, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

/** Resolve a code reference to the filesystem path it points to. */
export function resolveCodeRef(repoPath: string, ref: string): string {
  const normalized = normalizeCodeRef(ref);
  return path.isAbsolute(normalized) ? normalized : path.resolve(repoPath, normalized);
}

/**
 * Normalize a code-ref to the comparable path form used for owner indexing
 * and matching. Strips line/column anchors, converts backslashes to forward
 * slashes, removes leading `./` and trailing slashes, and trims whitespace.
 * Returns the normalized string; callers are responsible for filtering empty
 * results.
 */
export function normalizeCodeRefPath(ref: string): string {
  return normalizeCodeRef(ref)
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * Extract the line/column anchor (e.g. `#L42`, `#L42C5`, `:42`, `:42:5`) from
 * a code-ref string. Returns the anchor including its leading delimiter, or
 * undefined if the ref has no anchor.
 */
export function extractLineAnchor(ref: string): string | undefined {
  const match = ref.match(/(#L\d+(?:C\d+)?|:\d+(?::\d+)?)$/i);
  return match ? match[1] : undefined;
}
