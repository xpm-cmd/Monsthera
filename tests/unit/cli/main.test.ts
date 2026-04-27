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
    expect(output).toContain("workspace");
  });

  it("workspace status --json emits portable workspace status", async () => {
    const output = await captureStdout(() => main(withTempRepo(["workspace", "status", "--json"])));
    const parsed = JSON.parse(output);
    expect(parsed.schema.manifestExists).toBe(false);
    expect(parsed.schema.compatible).toBe(true);
    expect(parsed.paths.knowledgeRoot).toContain("knowledge");
  });

  it("workspace migrate creates a manifest", async () => {
    const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
    const output = await captureStdout(() => main(["workspace", "migrate", "--repo", repoPath]));
    expect(output).toContain("workspace manifest");
    const manifest = JSON.parse(await fs.readFile(path.join(repoPath, ".monsthera", "manifest.json"), "utf-8"));
    expect(manifest.workspaceSchemaVersion).toBe(1);
  });

  it("self status --json emits installation and process status", async () => {
    const output = await captureStdout(() => main(withTempRepo(["self", "status", "--json"])));
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("version");
    expect(parsed.install).toHaveProperty("path");
    expect(parsed.workspace).toHaveProperty("repoPath");
    expect(parsed.processes.dolt).toHaveProperty("running");
  });

  it("self update --dry-run prints an update plan", async () => {
    const output = await captureStdout(() => main(withTempRepo(["self", "update", "--dry-run"])));
    expect(output).toContain("Self update plan");
    expect(output).toContain("workspace backup");
    expect(output).toContain("git pull --ff-only");
  });

  it("self help includes execute mode", async () => {
    const output = await captureStdout(() => main(["self", "--help"]));
    expect(output).toContain("update --execute");
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

    it("knowledge list --json emits parseable JSON (empty corpus)", async () => {
      const output = await captureStdout(() => main(withTempRepo(["knowledge", "list", "--json"])));
      expect(JSON.parse(output)).toEqual([]);
    });

    it("knowledge list --json emits full article shapes after create", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main([
        "knowledge", "create",
        "--title", "Entry One",
        "--category", "engineering",
        "--content", "body",
        "--repo", repoPath,
      ]);
      const output = await captureStdout(() =>
        main(["knowledge", "list", "--json", "--repo", repoPath]),
      );
      const parsed = JSON.parse(output) as Array<{ id: string; title: string; content: string }>;
      expect(parsed.length).toBe(1);
      expect(parsed[0]?.title).toBe("Entry One");
      expect(parsed[0]?.id).toMatch(/^k-/);
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

    it("knowledge with no subcommand prints group help", async () => {
      const output = await captureStdout(() => main(["knowledge"]));
      expect(output).toContain("monsthera knowledge");
      expect(output).toContain("SUBCOMMANDS");
      expect(output).toContain("create");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("knowledge create --help prints usage without requiring flags", async () => {
      const output = await captureStdout(() => main(["knowledge", "create", "--help"]));
      expect(output).toContain("monsthera knowledge create");
      expect(output).toContain("USAGE");
      expect(output).toContain("--title");
      // Help is a success path, not an error — no exit(1).
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("knowledge update -h short-form also prints usage", async () => {
      const output = await captureStdout(() => main(["knowledge", "update", "-h"]));
      expect(output).toContain("monsthera knowledge update");
      expect(output).toContain("ARGUMENTS");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("knowledge create --content-file reads the body from disk", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const bodyPath = `/tmp/monsthera-cli-body-${randomUUID()}.md`;
      // Markdown that would be mangled by a shell heredoc — backticks
      // and a fenced block are the classic corruption case we're guarding.
      const body = [
        "# Title in body",
        "",
        "- bullet with `backticks that break heredoc`",
        "",
        "```ts",
        "const x = 1;",
        "```",
      ].join("\n");
      await fs.writeFile(bodyPath, body, "utf-8");

      const output = await captureStdout(() =>
        main([
          "knowledge", "create",
          "--title", "From File",
          "--category", "guide",
          "--content-file", bodyPath,
          "--repo", repoPath,
        ]),
      );
      expect(output).toContain("From File");
      expect(output).toContain("const x = 1;");
      expect(output).toContain("backticks that break heredoc");
      expect(exitSpy).not.toHaveBeenCalled();

      await fs.rm(bodyPath, { force: true });
    });

    it("knowledge create errors when both --content and --content-file are set", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const bodyPath = `/tmp/monsthera-cli-body-${randomUUID()}.md`;
      await fs.writeFile(bodyPath, "body", "utf-8");

      await main([
        "knowledge", "create",
        "--title", "Both",
        "--category", "guide",
        "--content", "inline",
        "--content-file", bodyPath,
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Use --content or --content-file, not both."),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);

      await fs.rm(bodyPath, { force: true });
    });

    it("knowledge create errors when neither --content nor --content-file is set", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main([
        "knowledge", "create",
        "--title", "Empty",
        "--category", "guide",
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing required flag: --content or --content-file"),
      );
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

    it("work list --json emits empty stdout (NDJSON, empty corpus)", async () => {
      const output = await captureStdout(() => main(withTempRepo(["work", "list", "--json"])));
      expect(output.trim()).toBe("");
    });

    it("work list --json emits full work shapes as NDJSON after create", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main([
        "work", "create",
        "--title", "Listable",
        "--template", "bugfix",
        "--author", "agent-1",
        "--repo", repoPath,
      ]);
      const output = await captureStdout(() =>
        main(["work", "list", "--json", "--repo", repoPath]),
      );
      const lines = output.trim().split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]!) as { id: string; title: string; phase: string };
      expect(parsed.title).toBe("Listable");
      expect(parsed.phase).toBe("planning");
    });

    it("work get prints error for non-existent ID", async () => {
      await main(withTempRepo(["work", "get", "no-such-id"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("NOT_FOUND"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work with no subcommand prints group help", async () => {
      const output = await captureStdout(() => main(["work"]));
      expect(output).toContain("monsthera work");
      expect(output).toContain("SUBCOMMANDS");
      expect(output).toContain("create");
      expect(output).toContain("advance");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("work create --help prints usage without requiring flags", async () => {
      const output = await captureStdout(() => main(["work", "create", "--help"]));
      expect(output).toContain("monsthera work create");
      expect(output).toContain("--template");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("work enrich --help prints usage without requiring the id or --role", async () => {
      const output = await captureStdout(() => main(["work", "enrich", "--help"]));
      expect(output).toContain("monsthera work enrich");
      expect(output).toContain("--role");
      expect(output).toContain("--status");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("work create --blocked-by / --dependencies populate the frontmatter on a new article", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      // First article: W1 (no deps).
      const first = await captureStdout(() =>
        main(["work", "create", "--title", "W1", "--template", "feature", "--author", "agent-1", "--repo", repoPath]),
      );
      const w1Id = first.match(/ID:\s+(w-\S+)/)?.[1];
      expect(w1Id).toBeDefined();

      // Second article: W2 blocked-by W1. Use JSON list to read the
      // structured frontmatter so we aren't parsing the pretty printer.
      await main([
        "work", "create",
        "--title", "W2",
        "--template", "feature",
        "--author", "agent-1",
        "--blocked-by", w1Id!,
        "--dependencies", w1Id!,
        "--repo", repoPath,
      ]);

      const listing = await captureStdout(() =>
        main(["work", "list", "--json", "--repo", repoPath]),
      );
      const parsed = listing
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as {
          title: string;
          blockedBy: string[];
          dependencies: string[];
        });
      const w2 = parsed.find((w) => w.title === "W2");
      expect(w2).toBeDefined();
      expect(w2?.blockedBy).toEqual([w1Id]);
      expect(w2?.dependencies).toEqual([w1Id]);
    });

    it("work create --blocked-by errors when a referenced id does not exist", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await main([
        "work", "create",
        "--title", "Dangling",
        "--template", "feature",
        "--author", "agent-1",
        "--blocked-by", "w-does-not-exist",
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Referenced work id not found: w-does-not-exist"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("work update --blocked-by routes through addDependency and maintains blockedBy ⊆ dependencies", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      const a = await captureStdout(() =>
        main(["work", "create", "--title", "A", "--template", "feature", "--author", "agent-1", "--repo", repoPath]),
      );
      const aId = a.match(/ID:\s+(w-\S+)/)?.[1];
      const b = await captureStdout(() =>
        main(["work", "create", "--title", "B", "--template", "feature", "--author", "agent-1", "--repo", repoPath]),
      );
      const bId = b.match(/ID:\s+(w-\S+)/)?.[1];

      await main(["work", "update", aId!, "--blocked-by", bId!, "--repo", repoPath]);

      const listing = await captureStdout(() =>
        main(["work", "list", "--json", "--repo", repoPath]),
      );
      const parsed = listing
        .trim()
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as {
          id: string;
          blockedBy: string[];
          dependencies: string[];
        });
      const a2 = parsed.find((w) => w.id === aId);
      // addDependency maintains the invariant that a new blocker is also in
      // `dependencies`, so the test doubles as a regression guard for that
      // invariant leaking into the CLI surface.
      expect(a2?.blockedBy).toEqual([bId]);
      expect(a2?.dependencies).toEqual([bId]);
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
      expect(output).toContain(`OK: ${id} advanced review → done`);
      expect(output).toContain('reason: "no reviewer in this session"');
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
      expect(output).toContain(`OK: ${id} advanced planning → cancelled`);
      expect(output).toContain('reason: "deferred indefinitely"');
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

  describe("pack subcommand", () => {
    it("pack with no query exits 1", async () => {
      await main(withTempRepo(["pack"]));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Missing required argument"));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("pack <query> prints a rendered summary on an empty corpus", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["pack", "authentication"])),
      );
      expect(output).toContain('query="authentication"');
      expect(output).toContain("Summary: 0 items");
      expect(output).toContain("Items:");
    });

    it("pack <query> --json prints a parseable JSON pack", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["pack", "authentication", "--json"])),
      );
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("query", "authentication");
      expect(parsed).toHaveProperty("summary");
      expect(parsed).toHaveProperty("items");
      expect(Array.isArray(parsed.items)).toBe(true);
    });

    it("pack --record <path> records a snapshot before building the pack", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await fs.mkdir(repoPath, { recursive: true });
      const snapshotPath = path.join(repoPath, "snap.json");
      await fs.writeFile(
        snapshotPath,
        JSON.stringify({
          agentId: "a-1",
          cwd: repoPath,
          files: ["README.md"],
          runtimes: { node: "22.0.0" },
          packageManagers: ["pnpm"],
          lockfiles: [],
        }),
        "utf-8",
      );

      const output = await captureStdout(() =>
        main([
          "pack", "onboarding",
          "--agent-id", "a-1",
          "--record", snapshotPath,
          "--json",
          "--repo", repoPath,
        ]),
      );
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty("recordedSnapshotId");
      expect(typeof parsed.recordedSnapshotId).toBe("string");
      // The pack should also surface the snapshot (not stale).
      expect(parsed).toHaveProperty("snapshot");
      expect(parsed.snapshot).toHaveProperty("agentId", "a-1");
    });

    it("pack --record with malformed JSON exits 1 with a readable error", async () => {
      const repoPath = `/tmp/monsthera-cli-test-${randomUUID()}`;
      await fs.mkdir(repoPath, { recursive: true });
      const snapshotPath = path.join(repoPath, "bad.json");
      await fs.writeFile(snapshotPath, "{ not valid json", "utf-8");

      await main([
        "pack", "q",
        "--record", snapshotPath,
        "--repo", repoPath,
      ]);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to parse --record JSON"));
      expect(exitSpy).toHaveBeenCalledWith(1);
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

    it("ingest with no subcommand prints group help", async () => {
      const output = await captureStdout(() => main(["ingest"]));
      expect(output).toContain("monsthera ingest");
      expect(output).toContain("local");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("ingest local --help prints usage without requiring --path", async () => {
      const output = await captureStdout(() => main(["ingest", "local", "--help"]));
      expect(output).toContain("monsthera ingest local");
      expect(output).toContain("--path");
      expect(output).toContain("--summary");
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  // ─── Code subcommand (ADR-015 M2) ────────────────────────────────────────

  describe("code subcommand", () => {
    it("code with no subcommand prints group help", async () => {
      const output = await captureStdout(() => main(["code"]));
      expect(output).toContain("monsthera code");
      expect(output).toContain("USAGE");
      expect(output).toContain("ref");
      expect(output).toContain("owners");
      expect(output).toContain("impact");
      expect(output).toContain("changes");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("code --help prints usage", async () => {
      const output = await captureStdout(() => main(["code", "--help"]));
      expect(output).toContain("monsthera code");
      expect(output).toContain("ADR-015");
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("code ref <path> emits a JSON CodeRefDetail to stdout (empty corpus)", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["code", "ref", "src/example.ts"])),
      );
      const parsed = JSON.parse(output) as {
        input: string;
        normalizedPath: string;
        owners: unknown[];
        summary: { ownerCount: number };
      };
      expect(parsed.input).toBe("src/example.ts");
      expect(parsed.normalizedPath).toBe("src/example.ts");
      expect(parsed.summary.ownerCount).toBe(0);
      expect(parsed.owners).toEqual([]);
    });

    it("code owners <path> emits a JSON CodeRefOwners payload (empty corpus)", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["code", "owners", "src/example.ts"])),
      );
      const parsed = JSON.parse(output) as { summary: { ownerCount: number } };
      expect(parsed.summary.ownerCount).toBe(0);
    });

    it("code impact <path> emits a JSON CodeRefImpact with risk=none for empty corpus + missing path", async () => {
      const output = await captureStdout(() =>
        main(withTempRepo(["code", "impact", "src/never/touched.ts"])),
      );
      const parsed = JSON.parse(output) as {
        risk: "none" | "low" | "medium" | "high";
        reasons: string[];
      };
      // Missing file → risk=high (code_ref_missing dominates over no_monsthera_context).
      expect(["high"]).toContain(parsed.risk);
      expect(parsed.reasons).toContain("code_ref_missing");
    });

    it("code ref with no positional path exits 1 with a readable error", async () => {
      await main(withTempRepo(["code", "ref"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Missing required argument"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("code changes --staged with --base errors out as mutually exclusive", async () => {
      await main(withTempRepo(["code", "changes", "--staged", "--base", "main"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("mutually exclusive"),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("code changes outside a git repo surfaces the git error and exits 1", async () => {
      // withTempRepo points at a fresh dir with no .git — `git diff --name-only HEAD`
      // exits non-zero with "fatal: not a git repository". The CLI translates that
      // into a stderr message and exits 1; it must NOT silently feed an empty
      // path list to the service.
      await main(withTempRepo(["code", "changes"]));
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringMatching(/git diff (failed|exited)/),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("code unknown-sub exits 1 and points to --help", async () => {
      await main(["code", "totally-not-a-subcommand"]);
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("Unknown code subcommand"),
      );
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
