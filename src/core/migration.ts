import { existsSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Transparently migrates a legacy .agora/ directory to .monsthera/.
 * Safe to call multiple times — skips if .monsthera/ already exists.
 */
export function migrateFromAgora(repoRoot: string, log?: (msg: string) => void): void {
  const oldDir = join(repoRoot, ".agora");
  const newDir = join(repoRoot, ".monsthera");

  if (existsSync(newDir) || !existsSync(oldDir)) return;

  renameSync(oldDir, newDir);
  log?.(`Migrated .agora/ → .monsthera/`);

  // Rename the database file if it still has the old name
  const oldDb = join(newDir, "agora.db");
  const newDb = join(newDir, "monsthera.db");
  if (existsSync(oldDb) && !existsSync(newDb)) {
    renameSync(oldDb, newDb);
    // Also rename WAL/SHM files if present
    for (const suffix of ["-wal", "-shm"]) {
      const oldWal = oldDb + suffix;
      const newWal = newDb + suffix;
      if (existsSync(oldWal)) renameSync(oldWal, newWal);
    }
    log?.(`Renamed agora.db → monsthera.db`);
  }

  // Update .gitignore if needed
  const gitignorePath = join(repoRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    let content = readFileSync(gitignorePath, "utf-8");
    if (content.includes(".agora/") && !content.includes(".monsthera/")) {
      content = content.replace(".agora/", ".monsthera/");
      writeFileSync(gitignorePath, content);
      log?.(`Updated .gitignore: .agora/ → .monsthera/`);
    }
  }
}

/**
 * Migrates the global ~/.agora/ directory to ~/.monsthera/.
 */
export function migrateGlobalFromAgora(log?: (msg: string) => void): void {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (!home) return;

  const oldDir = join(home, ".agora");
  const newDir = join(home, ".monsthera");

  if (existsSync(newDir) || !existsSync(oldDir)) return;

  renameSync(oldDir, newDir);
  log?.(`Migrated ~/.agora/ → ~/.monsthera/`);
}
