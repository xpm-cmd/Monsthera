import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { detectWorktree } from "../../../src/core/worktree.js";

async function tmpDir(): Promise<string> {
  const p = path.join("/tmp", `monsthera-worktree-test-${randomUUID()}`);
  await fs.mkdir(p, { recursive: true });
  return p;
}

describe("detectWorktree", () => {
  it("returns isWorktree=false when .git is missing", async () => {
    const dir = await tmpDir();
    const status = await detectWorktree(dir);
    expect(status.isWorktree).toBe(false);
  });

  it("returns isWorktree=false when .git is a directory (main repo)", async () => {
    const dir = await tmpDir();
    await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    const status = await detectWorktree(dir);
    expect(status.isWorktree).toBe(false);
    expect(status.mainRepoPath).toBe(dir);
  });

  it("returns isWorktree=true when .git is a gitdir-pointer file", async () => {
    const main = await tmpDir();
    const worktree = await tmpDir();
    const wtGitDir = path.join(main, ".git", "worktrees", "wt1");
    await fs.mkdir(wtGitDir, { recursive: true });
    await fs.mkdir(path.join(main, ".git"), { recursive: true });
    await fs.writeFile(path.join(wtGitDir, "commondir"), "../..\n", "utf8");
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${wtGitDir}\n`, "utf8");

    const status = await detectWorktree(worktree);
    expect(status.isWorktree).toBe(true);
    expect(status.worktreePath).toBe(worktree);
    expect(status.mainRepoPath).toBe(main);
  });

  it("falls back to gitDir parent when commondir is absent", async () => {
    const stub = await tmpDir();
    const stubGitDir = path.join(stub, ".bare-git");
    await fs.mkdir(stubGitDir, { recursive: true });
    const wt = await tmpDir();
    await fs.writeFile(path.join(wt, ".git"), `gitdir: ${stubGitDir}\n`, "utf8");

    const status = await detectWorktree(wt);
    expect(status.isWorktree).toBe(true);
    expect(status.mainRepoPath).toBe(stub);
  });
});
