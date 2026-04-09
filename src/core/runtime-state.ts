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

class FileSystemRuntimeStateStore implements RuntimeStateStore {
  private readonly filePath: string;

  constructor(repoPath: string) {
    this.filePath = path.join(repoPath, DEFAULT_CONFIG_DIR, "runtime-state.json");
  }

  async read(): Promise<RuntimeStateSnapshot> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return {};
      }
      return parsed as RuntimeStateSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      return {};
    }
  }

  async write(patch: Partial<RuntimeStateSnapshot>): Promise<RuntimeStateSnapshot> {
    const current = await this.read();
    const next = { ...current, ...patch };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(next, null, 2) + "\n", "utf-8");
    return next;
  }
}

export function createRuntimeStateStore(repoPath: string): RuntimeStateStore {
  return new FileSystemRuntimeStateStore(repoPath);
}
