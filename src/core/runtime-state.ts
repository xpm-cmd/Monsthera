import * as fs from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_CONFIG_DIR } from "./constants.js";

export interface RuntimeStateSnapshot {
  readonly knowledgeArticleCount?: number;
  readonly workArticleCount?: number;
  readonly searchIndexSize?: number;
  readonly lastReindexAt?: string;
  readonly lastMigrationAt?: string;
}

export interface RuntimeStateStore {
  read(): Promise<RuntimeStateSnapshot>;
  write(patch: Partial<RuntimeStateSnapshot>): Promise<RuntimeStateSnapshot>;
}

const CACHE_SUBDIR = "cache";
const STATE_FILENAME = "runtime-state.json";

class FileSystemRuntimeStateStore implements RuntimeStateStore {
  private readonly filePath: string;
  private readonly legacyFilePath: string;

  constructor(repoPath: string) {
    this.filePath = path.join(repoPath, DEFAULT_CONFIG_DIR, CACHE_SUBDIR, STATE_FILENAME);
    this.legacyFilePath = path.join(repoPath, DEFAULT_CONFIG_DIR, STATE_FILENAME);
  }

  async read(): Promise<RuntimeStateSnapshot> {
    const fromNew = await this.tryRead(this.filePath);
    if (fromNew !== undefined) return fromNew;
    const fromLegacy = await this.tryRead(this.legacyFilePath);
    return fromLegacy ?? {};
  }

  private async tryRead(filePath: string): Promise<RuntimeStateSnapshot | undefined> {
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as RuntimeStateSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      return {};
    }
  }

  async write(patch: Partial<RuntimeStateSnapshot>): Promise<RuntimeStateSnapshot> {
    const current = await this.read();
    const next = { ...current, ...patch };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2) + "\n", "utf-8");
    // One-time cleanup: if a legacy file still exists at the old path, remove it
    // so it stops appearing in `git status`. The new path is under .monsthera/cache/
    // which is conventionally ephemeral.
    await fs.rm(this.legacyFilePath, { force: true });
    return next;
  }
}

export function createRuntimeStateStore(repoPath: string): RuntimeStateStore {
  return new FileSystemRuntimeStateStore(repoPath);
}
