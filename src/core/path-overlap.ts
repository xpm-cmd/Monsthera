/**
 * Shared path overlap utilities for claim enforcement.
 * Extracted from src/tools/agent-tools.ts to be reused by the patch validator.
 */

export function normalizeClaimPath(path: string): string {
  return path.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = normalizeClaimPath(left);
  const b = normalizeClaimPath(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
