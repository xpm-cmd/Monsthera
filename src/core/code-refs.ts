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
