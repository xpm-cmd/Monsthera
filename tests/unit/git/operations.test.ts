import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  getCommitMessage,
  getHead,
  getChangedFiles,
  getAllTrackedFiles,
  getFileContent,
  isGitRepo,
  getRecentCommits,
  getRepoRoot,
  getMainRepoRoot,
} from "../../../src/git/operations.js";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/** Normalize path separators for cross-platform comparison (Windows backslash → forward slash) */
const normalizePath = (p: string) => p.replace(/\\/g, "/");

describe("git operations", () => {
  let repoDir: string;

  beforeEach(() => {
    const tmpBase = mkdtempSync(join(tmpdir(), "monsthera-test-"));
    git(["init", "-b", "main"], tmpBase);
    git(["config", "user.email", "test@test.com"], tmpBase);
    git(["config", "user.name", "Test"], tmpBase);

    writeFileSync(join(tmpBase, "hello.ts"), 'export const hello = "world";');
    git(["add", "."], tmpBase);
    git(["commit", "-m", "init"], tmpBase);

    // Resolve canonical path via git (avoids Windows 8.3 short names like RUNNER~1)
    repoDir = git(["rev-parse", "--show-toplevel"], tmpBase);
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("getHead returns current HEAD SHA", async () => {
    const head = await getHead({ cwd: repoDir });
    expect(head).toMatch(/^[a-f0-9]{40}$/);
  });

  it("isGitRepo returns true for git repos", async () => {
    expect(await isGitRepo({ cwd: repoDir })).toBe(true);
  });

  it("isGitRepo returns false for non-git dirs", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "monsthera-no-git-"));
    expect(await isGitRepo({ cwd: tmpDir })).toBe(false);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("getAllTrackedFiles lists all files at a commit", async () => {
    const head = await getHead({ cwd: repoDir });
    const files = await getAllTrackedFiles(head, { cwd: repoDir });
    expect(files).toContain("hello.ts");
  });

  it("getChangedFiles detects added files", async () => {
    const beforeHead = await getHead({ cwd: repoDir });

    writeFileSync(join(repoDir, "new.ts"), "export const x = 1;");
    git(["add", "."], repoDir);
    git(["commit", "-m", "add new"], repoDir);

    const afterHead = await getHead({ cwd: repoDir });
    const changes = await getChangedFiles(beforeHead, afterHead, { cwd: repoDir });
    expect(changes.length).toBe(1);
    expect(changes[0]!.status).toBe("A");
    expect(changes[0]!.path).toBe("new.ts");
  });

  it("getChangedFiles detects modified files", async () => {
    const beforeHead = await getHead({ cwd: repoDir });

    writeFileSync(join(repoDir, "hello.ts"), 'export const hello = "updated";');
    git(["add", "."], repoDir);
    git(["commit", "-m", "modify"], repoDir);

    const afterHead = await getHead({ cwd: repoDir });
    const changes = await getChangedFiles(beforeHead, afterHead, { cwd: repoDir });
    expect(changes.some((c) => c.status === "M" && c.path === "hello.ts")).toBe(true);
  });

  it("getFileContent reads file at specific commit", async () => {
    const head = await getHead({ cwd: repoDir });
    const content = await getFileContent("hello.ts", head, { cwd: repoDir });
    expect(content).toBe('export const hello = "world";');
  });

  it("getFileContent returns null for nonexistent file", async () => {
    const head = await getHead({ cwd: repoDir });
    const content = await getFileContent("nope.ts", head, { cwd: repoDir });
    expect(content).toBeNull();
  });

  it("getRecentCommits returns commit history", async () => {
    const commits = await getRecentCommits(5, { cwd: repoDir });
    expect(commits.length).toBe(1);
    expect(commits[0]!.message).toBe("init");
    expect(commits[0]!.sha).toMatch(/^[a-f0-9]{40}$/);
  });

  it("getCommitMessage returns the full commit message body", async () => {
    const head = await getHead({ cwd: repoDir });
    const message = await getCommitMessage(head, { cwd: repoDir });
    expect(message).toBe("init");
  });

  describe("getMainRepoRoot", () => {
    it("returns same as getRepoRoot in a normal repo", async () => {
      const repoRoot = await getRepoRoot({ cwd: repoDir });
      const mainRoot = await getMainRepoRoot({ cwd: repoDir });
      expect(normalizePath(mainRoot)).toBe(normalizePath(repoRoot));
    });

    it("returns main repo root from a worktree", async () => {
      const mainRoot = await getRepoRoot({ cwd: repoDir });
      const worktreeDir = join(repoDir, ".worktrees", "test-wt");
      mkdirSync(join(repoDir, ".worktrees"), { recursive: true });
      git(["worktree", "add", "-b", "test-wt-branch", worktreeDir], repoDir);

      const wtRepoRoot = await getRepoRoot({ cwd: worktreeDir });
      const wtMainRoot = await getMainRepoRoot({ cwd: worktreeDir });

      // Worktree root differs from main repo root (normalize for Windows path separators)
      expect(normalizePath(wtRepoRoot)).toBe(normalizePath(worktreeDir));
      // But getMainRepoRoot always returns the main repo
      expect(normalizePath(wtMainRoot)).toBe(normalizePath(mainRoot));

      // Cleanup
      git(["worktree", "remove", worktreeDir], repoDir);
    });
  });
});
