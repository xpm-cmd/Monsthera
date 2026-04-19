import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

/**
 * Well-known lockfile filenames. When the caller does not pass an explicit
 * allowlist, `readHeadLockfileHashes` walks this set and hashes the ones that
 * exist on disk. Intentionally a small, predictable set — we never rely on
 * shell / subprocess to discover paths.
 */
export const DEFAULT_LOCKFILE_PATHS: readonly string[] = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "uv.lock",
  "poetry.lock",
  "Cargo.lock",
  "go.sum",
];

/**
 * Read and sha256-hash every lockfile under `repoPath` that appears in
 * `candidates` (defaults to the well-known list). Returns a `{ path: sha256 }`
 * map keyed by the path relative to `repoPath` — matches how the capture
 * helper stores `lockfiles[].path` so the two sides compare byte-for-byte.
 *
 * Files that do not exist are silently skipped. Unreadable files (permissions,
 * etc.) are also skipped — an IO error here must never block a phase advance
 * because the sandbox is allowed to have a subset of lockfiles.
 */
export async function readHeadLockfileHashes(
  repoPath: string,
  candidates: readonly string[] = DEFAULT_LOCKFILE_PATHS,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    candidates.map(async (rel) => {
      const abs = path.join(repoPath, rel);
      try {
        const bytes = await fs.readFile(abs);
        const hash = createHash("sha256").update(bytes).digest("hex");
        out[rel] = hash;
      } catch {
        // Missing / unreadable lockfiles are expected — skip without failing.
      }
    }),
  );
  return out;
}
