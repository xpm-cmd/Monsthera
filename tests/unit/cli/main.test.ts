import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    const output = await captureStdout(() => main(["status"]));
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
    expect(output).toContain("search");
    expect(output).toContain("reindex");
  });

  // ─── Knowledge subcommand ────────────────────────────────────────────────

  describe("knowledge subcommand", () => {
    it("knowledge create prints the created article", async () => {
      const output = await captureStdout(() =>
        main(["knowledge", "create", "--title", "Test Article", "--category", "engineering", "--content", "body text"]),
      );
      expect(output).toContain("Test Article");
      expect(output).toContain("engineering");
      expect(output).toContain("body text");
      expect(output).toContain("ID:");
    });

    it("knowledge list prints a table or empty message", async () => {
      const output = await captureStdout(() => main(["knowledge", "list"]));
      // Either "No knowledge articles found." or a table with headers
      expect(output.length).toBeGreaterThan(0);
    });

    it("knowledge get prints error for non-existent ID", async () => {
      // Each CLI invocation creates a fresh in-memory container, so no
      // previously-created article persists. Verify the error path works.
      await main(["knowledge", "get", "no-such-id"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("NOT_FOUND"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("knowledge delete prints success message", async () => {
      const output = await captureStdout(() =>
        main(["knowledge", "delete", "non-existent-id"]),
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
        main(["work", "create", "--title", "Task", "--template", "feature", "--author", "agent-1"]),
      );
      expect(output).toContain("Task");
      expect(output).toContain("feature");
      expect(output).toContain("ID:");
    });

    it("work list prints articles or empty message", async () => {
      const output = await captureStdout(() => main(["work", "list"]));
      expect(output.length).toBeGreaterThan(0);
    });

    it("work get prints error for non-existent ID", async () => {
      await main(["work", "get", "no-such-id"]);
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
      await main(["search"]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("search someterms does not crash", async () => {
      const output = await captureStdout(() => main(["search", "someterms"]));
      // May return "No results found." or actual results — either is fine
      expect(output).toBeDefined();
    });
  });

  // ─── Reindex subcommand ──────────────────────────────────────────────────

  describe("reindex subcommand", () => {
    it("reindex runs without error and prints counts", async () => {
      const output = await captureStdout(() => main(["reindex"]));
      expect(output).toContain("Reindex complete");
      expect(output).toMatch(/\d+ knowledge article/);
      expect(output).toMatch(/\d+ work article/);
    });
  });
});
