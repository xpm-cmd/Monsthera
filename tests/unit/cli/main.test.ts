import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { main } from "../../../src/cli/main.js";
import { VERSION } from "../../../src/core/constants.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function captureStdout(fn: () => void | Promise<void>): Promise<string> {
  return new Promise(async (resolve) => {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    resolve(chunks.join(""));
  });
}

function withTempRepo(args: string[]): string[] {
  return [...args, "--repo", `/tmp/monsthera-cli-test-${randomUUID()}`];
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("CLI main()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Prevent process.exit from actually exiting
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as () => never);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("--version prints VERSION to stdout", async () => {
    const output = await captureStdout(() => main(["--version"]));
    expect(output.trim()).toBe(VERSION);
  });

  it("-v prints VERSION to stdout", async () => {
    const output = await captureStdout(() => main(["-v"]));
    expect(output.trim()).toBe(VERSION);
  });

  it("--help prints usage summary to stdout", async () => {
    const output = await captureStdout(() => main(["--help"]));
    expect(output).toContain("monsthera");
    expect(output).toContain("serve");
    expect(output).toContain("dashboard");
    expect(output).toContain("status");
  });

  it("-h prints usage summary to stdout", async () => {
    const output = await captureStdout(() => main(["-h"]));
    expect(output).toContain("USAGE");
    expect(output).toContain("COMMANDS");
  });

  it("no args prints help to stdout", async () => {
    const output = await captureStdout(() => main([]));
    expect(output).toContain("monsthera");
  });

  it("unknown command prints error and exits with code 1", async () => {
    await main(["unknownxyz"]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown command: unknownxyz"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("unknown command suggests --help", async () => {
    await main(["badcommand"]);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--help"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("status command prints JSON status to stdout", async () => {
    const output = await captureStdout(() => main(withTempRepo(["status"])));
    // Should be parseable JSON
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("version");
    expect(parsed).toHaveProperty("uptime");
    expect(parsed).toHaveProperty("subsystems");
    expect(parsed.version).toBe(VERSION);
  });

  // ─── Help text includes Phase 6 commands ─────────────────────────────────

  it("--help includes knowledge, work, search, reindex", async () => {
    const output = await captureStdout(() => main(["--help"]));
    expect(output).toContain("knowledge");
    expect(output).toContain("work");
    expect(output).toContain("ingest");
    expect(output).toContain("search");
    expect(output).toContain("reindex");
  });

  // ─── Knowledge subcommand ────────────────────────────────────────────────

  describe("knowledge subcommand", () => {
    it("knowledge create prints the created article", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["knowledge", "create", "--title", "Test Article", "--category", "engineering", "--content", "body text"])),
      );
      expect(output).toContain("Test Article");
      expect(output).toContain("engineering");
      expect(output).toContain("body text");
      expect(output).toContain("ID:");
    });

    it("knowledge list prints a table or empty message", async () => {
      const output = await captureStdout(() => main(withTempRepo(["knowledge", "list"])));
      // Either "No knowledge articles found." or a table with headers
      expect(output.length).toBeGreaterThan(0);
    });

    it("knowledge get prints error for non-existent ID", async () => {
      // Each CLI invocation creates a fresh in-memory container, so no
      // previously-created article persists. Verify the error path works.
      await main(withTempRepo(["knowledge", "get", "no-such-id"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("NOT_FOUND"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("knowledge delete prints success message", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["knowledge", "delete", "non-existent-id"])),
      );
      expect(output).toContain("Deleted knowledge article");
    });

    it("knowledge with no subcommand prints error", async () => {
      await main(["knowledge"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── Work subcommand ─────────────────────────────────────────────────────

  describe("work subcommand", () => {
    it("work create prints the created work article", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["work", "create", "--title", "Task", "--template", "feature", "--author", "agent-1"])),
      );
      expect(output).toContain("Task");
      expect(output).toContain("feature");
      expect(output).toContain("ID:");
    });

    it("work list prints articles or empty message", async () => {
      const output = await captureStdout(() => main(withTempRepo(["work", "list"])));
      expect(output.length).toBeGreaterThan(0);
    });

    it("work get prints error for non-existent ID", async () => {
      await main(withTempRepo(["work", "get", "no-such-id"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("NOT_FOUND"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work with no subcommand prints error", async () => {
      await main(["work"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── Search subcommand ───────────────────────────────────────────────────

  describe("search subcommand", () => {
    it("search with no query prints error", async () => {
      await main(withTempRepo(["search"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("search someterms does not crash", async () => {
      const output = await captureStdout(() => main(withTempRepo(["search", "someterms"])));
      // May return "No results found." or actual results — either is fine
      expect(output).toBeDefined();
    });
  });

  describe("ingest subcommand", () => {
    it("ingest local imports a markdown file and prints a summary", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await fs.mkdir(path.join(repoPath, "docs"), { recursive: true });
      await fs.writeFile(
        path.join(repoPath, "docs", "cli-import.md"),
        "# CLI Import\n\nImported from CLI.\n",
        "utf-8",
      );

      const output = await captureStdout(() =>
        main(["ingest", "local", "--path", "docs/cli-import.md", "--summary", "--repo", repoPath]),
      );
      expect(output).toContain("Mode:         summary");
      expect(output).toContain("Imported:");
      expect(output).toContain("CLI Import");
      expect(output).toContain("docs/cli-import.md");
    });

    it("ingest with no subcommand prints error", async () => {
      await main(["ingest"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("(none)"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  // ─── Reindex subcommand ──────────────────────────────────────────────────

  describe("reindex subcommand", () => {
    it("reindex runs without error and prints counts", async () => {
      const output = await captureStdout(() => main(withTempRepo(["reindex"])));
      expect(output).toContain("Reindex complete");
      expect(output).toMatch(/\d+ knowledge article/);
      expect(output).toMatch(/\d+ work article/);
    });
  });
});
