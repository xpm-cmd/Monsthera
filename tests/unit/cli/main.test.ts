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

    it("work advance --skip-guard-reason bypasses a failing guard at review→done", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const create = await captureStdout(() =>
        main([
          "work", "create",
          "--title", "Skip-guard close-out",
          "--template", "bugfix",
          "--author", "agent-1",
          "--content", "## Objective\n\nX\n\n## Steps to Reproduce\n\nY\n\n## Acceptance Criteria\n\n- [ ] Z\n\n## Implementation\n\nlanded\n",
          "--repo", repoPath,
        ]),
      );
      const match = create.match(/ID:\s+(w-\S+)/);
      expect(match).not.toBeNull();
      const id = match![1]!;

      // Walk through planning → enrichment → implementation → review normally.
      await main(["work", "advance", id, "--phase", "enrichment", "--repo", repoPath]);
      await main(["work", "enrich", id, "--role", "testing", "--status", "contributed", "--repo", repoPath]);
      await main(["work", "advance", id, "--phase", "implementation", "--repo", repoPath]);
      await main(["work", "advance", id, "--phase", "review", "--repo", repoPath]);

      // review → done is blocked by all_reviewers_approved (no reviewers assigned);
      // --skip-guard-reason must bypass it and record the reason on phase history.
      const output = await captureStdout(() =>
        main(["work", "advance", id, "--phase", "done", "--skip-guard-reason", "no reviewer in this session", "--repo", repoPath]),
      );
      expect(output).toContain("Phase:     done");
    });

    it("work advance --phase cancelled requires --reason", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const create = await captureStdout(() =>
        main(withTempRepo(["work", "create", "--title", "To cancel", "--template", "bugfix", "--author", "agent-1"])),
      );
      const match = create.match(/ID:\s+(w-\S+)/);
      if (!match) return;
      const id = match[1]!;

      await main(["work", "advance", id, "--phase", "cancelled", "--repo", repoPath]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("reason"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work advance --phase cancelled --reason succeeds and records the reason", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const create = await captureStdout(() =>
        main(["work", "create", "--title", "Cancel with reason", "--template", "bugfix", "--author", "agent-1", "--repo", repoPath]),
      );
      const match = create.match(/ID:\s+(w-\S+)/);
      expect(match).not.toBeNull();
      const id = match![1]!;

      const output = await captureStdout(() =>
        main(["work", "advance", id, "--phase", "cancelled", "--reason", "deferred indefinitely", "--repo", repoPath]),
      );
      expect(output).toContain("Phase:     cancelled");
    });

    it("work create --content-file reads body from disk verbatim (backticks survive)", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await fs.mkdir(repoPath, { recursive: true });
      const body = "## Objective\n\nUse `foo()` and `bar()` everywhere.\n\n## Context\n\nn/a\n\n## Acceptance Criteria\n\n- [ ] x\n\n## Scope\n\n- y\n";
      const bodyPath = path.join(repoPath, "body.md");
      await fs.writeFile(bodyPath, body, "utf-8");

      const create = await captureStdout(() =>
        main([
          "work", "create",
          "--title", "Backtick literal",
          "--template", "feature",
          "--author", "agent-1",
          "--content-file", bodyPath,
          "--repo", repoPath,
        ]),
      );
      const match = create.match(/ID:\s+(w-\S+)/);
      expect(match).not.toBeNull();
      const id = match![1]!;

      const get = await captureStdout(() =>
        main(["work", "get", id, "--repo", repoPath]),
      );
      expect(get).toContain("`foo()`");
      expect(get).toContain("`bar()`");
      // And no accidental backslash-escaped backticks leaked through.
      expect(get).not.toContain("\\`foo()\\`");
    });

    it("work create with both --content and --content-file fails", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await fs.mkdir(repoPath, { recursive: true });
      const bodyPath = path.join(repoPath, "body.md");
      await fs.writeFile(bodyPath, "## Objective\n\nfoo\n", "utf-8");

      await main([
        "work", "create",
        "--title", "Conflict",
        "--template", "feature",
        "--author", "agent-1",
        "--content", "inline",
        "--content-file", bodyPath,
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("mutually exclusive"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work create --content-file with a missing path fails with a readable error", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main([
        "work", "create",
        "--title", "Missing file",
        "--template", "bugfix",
        "--author", "agent-1",
        "--content-file", "/tmp/no-such-file-xyz-abc.md",
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to read --content-file"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work update --content-file replaces body from disk", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const create = await captureStdout(() =>
        main(["work", "create", "--title", "Update me", "--template", "bugfix", "--author", "agent-1", "--repo", repoPath]),
      );
      const id = create.match(/ID:\s+(w-\S+)/)![1]!;

      const bodyPath = path.join("/tmp", `body-${randomUUID()}.md`);
      await fs.writeFile(bodyPath, "## Updated\n\nnew `code` here.\n", "utf-8");

      const output = await captureStdout(() =>
        main(["work", "update", id, "--content-file", bodyPath, "--repo", repoPath]),
      );
      expect(output).toContain("new `code` here.");
    });

    it("work update with no fields lists --content-file and --edit in the error", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const c = await captureStdout(() =>
        main(["work", "create", "--title", "x", "--template", "bugfix", "--author", "agent-1", "--repo", repoPath]),
      );
      const id = c.match(/ID:\s+(w-\S+)/)![1]!;
      await main(["work", "update", id, "--repo", repoPath]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--content-file"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    async function walkToReview(repoPath: string, title: string): Promise<string> {
      const create = await captureStdout(() =>
        main([
          "work", "create",
          "--title", title,
          "--template", "bugfix",
          "--author", "agent-1",
          "--content", "## Objective\n\nX\n\n## Steps to Reproduce\n\nY\n\n## Acceptance Criteria\n\n- [ ] Z\n\n## Implementation\n\nlanded\n",
          "--repo", repoPath,
        ]),
      );
      const id = create.match(/ID:\s+(w-\S+)/)![1]!;
      await main(["work", "advance", id, "--phase", "enrichment", "--repo", repoPath]);
      await main(["work", "enrich", id, "--role", "testing", "--status", "contributed", "--repo", repoPath]);
      await main(["work", "advance", id, "--phase", "implementation", "--repo", repoPath]);
      await main(["work", "advance", id, "--phase", "review", "--repo", repoPath]);
      return id;
    }

    async function readWorkMarkdown(repoPath: string, id: string): Promise<string> {
      return fs.readFile(path.join(repoPath, "knowledge", "work-articles", `${id}.md`), "utf-8");
    }

    it("work close --pr closes a review-phase article with the canonical reason", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const id = await walkToReview(repoPath, "Close via PR");

      const output = await captureStdout(() =>
        main(["work", "close", id, "--pr", "42", "--repo", repoPath]),
      );
      expect(output).toContain("Phase:     done");

      const raw = await readWorkMarkdown(repoPath, id);
      expect(raw).toContain("merged via PR #42");
      expect(raw).toContain("bypass recorded on phase history");
    });

    it("work close --pr accepts a #-prefixed number", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const id = await walkToReview(repoPath, "Close via #-prefixed PR");

      const output = await captureStdout(() =>
        main(["work", "close", id, "--pr", "#7", "--repo", repoPath]),
      );
      expect(output).toContain("Phase:     done");
      const raw = await readWorkMarkdown(repoPath, id);
      expect(raw).toContain("merged via PR #7");
    });

    it("work close --reason uses the custom reason verbatim", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const id = await walkToReview(repoPath, "Close with custom reason");

      const reason = "abandoned mid-review, keeping audit trail";
      await main(["work", "close", id, "--reason", reason, "--repo", repoPath]);
      const raw = await readWorkMarkdown(repoPath, id);
      expect(raw).toContain(reason);
      // Custom reason should replace, not append to, the canonical text.
      expect(raw).not.toContain("merged via PR");
    });

    it("work close with no flags exits 1 with a readable error", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const id = await walkToReview(repoPath, "No flags");
      await main(["work", "close", id, "--repo", repoPath]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--reason"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work close with no positional id exits 1", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main(["work", "close", "--pr", "1", "--repo", repoPath]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"));
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
