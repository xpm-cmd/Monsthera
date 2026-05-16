import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  resolveWorkspaceLocation,
  buildFallbackMarkdownRoot,
} from "../../../src/sessions/workspace-resolver.js";
import type { CommandRunner } from "../../../src/ops/command-runner.js";
import { ok, err } from "../../../src/core/result.js";
import { StorageError } from "../../../src/core/errors.js";

function fakeRunner(stdout: string): CommandRunner {
  return async () => ok({ stdout, stderr: "" });
}

function failingRunner(message: string): CommandRunner {
  return async () => err(new StorageError(message));
}

describe("resolveWorkspaceLocation", () => {
  it("recognises the main worktree when commonDir resolves back to workspace/.git", async () => {
    const workspace = "/Users/me/Projects/Monsthera";
    // git rev-parse --git-common-dir returns ".git" (relative) from inside main.
    const runner = fakeRunner(".git\n");
    const result = await resolveWorkspaceLocation(workspace, runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.isWorktree).toBe(false);
    expect(result.value!.commonRoot).toBe(workspace);
  });

  it("recognises a feature worktree when commonDir is an absolute path elsewhere", async () => {
    const workspace = "/Users/me/Projects/Monsthera/.claude/worktrees/feature-x";
    const runner = fakeRunner("/Users/me/Projects/Monsthera/.git\n");
    const result = await resolveWorkspaceLocation(workspace, runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.isWorktree).toBe(true);
    expect(result.value!.commonRoot).toBe("/Users/me/Projects/Monsthera");
  });

  it("normalises both absolute and trailing-slash variants of the commonDir output", async () => {
    const workspace = "/Users/me/Projects/Monsthera/.claude/worktrees/feature-y";
    // Some git versions emit a trailing slash; resolution should be stable.
    const runner = fakeRunner("/Users/me/Projects/Monsthera/.git/\n");
    const result = await resolveWorkspaceLocation(workspace, runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.commonRoot).toBe("/Users/me/Projects/Monsthera");
    expect(result.value!.isWorktree).toBe(true);
  });

  it("returns null when git is unavailable or the path is not a repo", async () => {
    const runner = failingRunner("fatal: not a git repository");
    const result = await resolveWorkspaceLocation("/tmp/not-a-repo", runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("returns null when git emits empty stdout", async () => {
    const runner = fakeRunner("");
    const result = await resolveWorkspaceLocation("/tmp/empty-output", runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("does not classify as worktree when commonDir parent matches workspace via different lexical form", async () => {
    // git emits a relative ".git" — the parent is the workspace itself,
    // regardless of how the workspace path is normalised on input.
    const workspace = "/Users/me/Projects/Monsthera/";  // trailing slash
    const runner = fakeRunner(".git");
    const result = await resolveWorkspaceLocation(workspace, runner);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.isWorktree).toBe(false);
    // path.resolve strips trailing slash for canonical comparison
    expect(result.value!.commonRoot).toBe(path.resolve(workspace));
  });
});

describe("buildFallbackMarkdownRoot", () => {
  it("returns null for the main worktree (no fallback needed)", () => {
    const main = { commonRoot: "/repo", isWorktree: false };
    expect(buildFallbackMarkdownRoot(main, "knowledge")).toBeNull();
  });

  it("returns null when no location was resolved", () => {
    expect(buildFallbackMarkdownRoot(null, "knowledge")).toBeNull();
  });

  it("joins the commonRoot with the markdownRoot segment for a worktree", () => {
    const wt = { commonRoot: "/repo", isWorktree: true };
    expect(buildFallbackMarkdownRoot(wt, "knowledge")).toBe("/repo/knowledge");
  });

  it("respects nested markdownRoot segments", () => {
    const wt = { commonRoot: "/repo", isWorktree: true };
    expect(buildFallbackMarkdownRoot(wt, "docs/knowledge")).toBe("/repo/docs/knowledge");
  });
});
