import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SearchBackend, SearchResult } from "./interface.js";

const execFileAsync = promisify(execFile);

/**
 * Zoekt search backend — optional, requires zoekt to be installed.
 * Provides higher-quality code search via trigram indexing.
 */
export class ZoektBackend implements SearchBackend {
  readonly name = "zoekt" as const;

  constructor(
    private repoPath: string,
    private indexDir: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("zoekt", ["--help"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  async indexRepo(): Promise<void> {
    await execFileAsync(
      "zoekt-git-index",
      ["-index", this.indexDir, "-branches", "HEAD", this.repoPath],
      { timeout: 60_000, cwd: this.repoPath },
    );
  }

  async search(query: string, _repoId: number, limit = 20): Promise<SearchResult[]> {
    try {
      const { stdout } = await execFileAsync(
        "zoekt",
        ["-index_dir", this.indexDir, "-json", `-num`, String(limit), query],
        { timeout: 10_000 },
      );

      const parsed = JSON.parse(stdout) as ZoektResponse;
      if (!parsed.Result?.FileMatches) return [];

      return parsed.Result.FileMatches.map((fm) => ({
        path: fm.FileName,
        score: fm.Score ?? 0,
        matchLines: fm.LineMatches?.map((lm) => lm.LineNumber) ?? [],
      }));
    } catch {
      return [];
    }
  }
}

// Zoekt JSON response types (minimal)
interface ZoektResponse {
  Result?: {
    FileMatches?: Array<{
      FileName: string;
      Score?: number;
      LineMatches?: Array<{
        LineNumber: number;
        Line: string;
      }>;
    }>;
  };
}
