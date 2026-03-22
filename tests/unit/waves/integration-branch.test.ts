import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockGit } = vi.hoisted(() => ({
  mockGit: vi.fn<any>(),
}));

// Mock the entire module's internal git() by mocking child_process + util
// so that promisify(execFile) returns our mock
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:util", () => ({
  promisify: () => async (...args: unknown[]) => {
    // args = [cmd, gitArgs, opts] from execFileAsync("git", [...], {...})
    const gitArgs = args[1] as string[];
    const opts = args[2] as { cwd: string };
    const result = await (mockGit as any)(gitArgs, opts);
    return { stdout: result + "\n", stderr: "" };
  },
}));

import {
  createIntegrationBranch,
  createConvoyWorktree,
  mergeTicketToIntegration,
  rebaseOnBranch,
  mergeIntegrationToMain,
  cleanupIntegrationBranch,
} from "../../../src/waves/integration-branch.js";

beforeEach(() => {
  mockGit.mockReset();
  mockGit.mockResolvedValue("");
});

describe("integration-branch", () => {
  describe("createIntegrationBranch", () => {
    it("creates a branch named monsthera/convoy/{groupId}", async () => {
      const result = await createIntegrationBranch("/repo", "WG-abc123");
      expect(result.branchName).toBe("monsthera/convoy/WG-abc123");
      expect(mockGit).toHaveBeenCalledWith(
        ["branch", "monsthera/convoy/WG-abc123"],
        expect.objectContaining({ cwd: "/repo" }),
      );
    });
  });

  describe("createConvoyWorktree", () => {
    it("creates worktree with correct path and branch", async () => {
      const result = await createConvoyWorktree("/repo", "session-abc", "monsthera/convoy/WG-1");
      expect(result.worktreePath).toBe("/repo/.monsthera/worktrees/session-abc");
      expect(result.branchName).toBe("monsthera/agent/session-abc");
    });
  });

  describe("mergeTicketToIntegration", () => {
    it("returns merged=true with commitSha on success", async () => {
      mockGit
        .mockResolvedValueOnce("main")       // rev-parse --abbrev-ref HEAD
        .mockResolvedValueOnce("")            // checkout integration
        .mockResolvedValueOnce("")            // merge --no-ff
        .mockResolvedValueOnce("abc1234def")  // rev-parse HEAD
        .mockResolvedValueOnce("");           // checkout original

      const result = await mergeTicketToIntegration("/repo", "integration", "agent-branch", "merge msg");
      expect(result.merged).toBe(true);
      expect(result.commitSha).toBe("abc1234def");
      expect(result.conflicts).toEqual([]);
    });

    it("returns conflicts on merge failure", async () => {
      mockGit
        .mockResolvedValueOnce("main")                            // rev-parse
        .mockResolvedValueOnce("")                                 // checkout
        .mockRejectedValueOnce(new Error("merge conflict"))       // merge fails
        .mockResolvedValueOnce("file1.ts\nfile2.ts")              // diff
        .mockResolvedValueOnce("")                                 // merge --abort
        .mockResolvedValueOnce("");                                // checkout original

      const result = await mergeTicketToIntegration("/repo", "integration", "agent-branch", "merge msg");
      expect(result.merged).toBe(false);
      expect(result.commitSha).toBeNull();
      expect(result.conflicts).toEqual(["file1.ts", "file2.ts"]);
    });

    it("returns unknown conflict when conflict extraction also fails", async () => {
      mockGit
        .mockResolvedValueOnce("main")                            // rev-parse
        .mockResolvedValueOnce("")                                 // checkout
        .mockRejectedValueOnce(new Error("merge conflict"))       // merge fails
        .mockRejectedValueOnce(new Error("diff failed"))          // diff also fails
        .mockResolvedValueOnce("")                                 // merge --abort
        .mockResolvedValueOnce("");                                // checkout original

      const result = await mergeTicketToIntegration("/repo", "integration", "agent-branch", "merge msg");
      expect(result.merged).toBe(false);
      expect(result.conflicts).toEqual(["unknown conflict"]);
    });
  });

  describe("rebaseOnBranch", () => {
    it("returns rebased=true on success", async () => {
      const result = await rebaseOnBranch("/worktree", "target-branch");
      expect(result.rebased).toBe(true);
      expect(result.conflicts).toEqual([]);
    });

    it("returns conflicts on rebase failure", async () => {
      mockGit
        .mockRejectedValueOnce(new Error("rebase conflict"))    // rebase fails
        .mockResolvedValueOnce("conflicted.ts")                  // diff
        .mockResolvedValueOnce("");                               // rebase --abort

      const result = await rebaseOnBranch("/worktree", "target-branch");
      expect(result.rebased).toBe(false);
      expect(result.conflicts).toEqual(["conflicted.ts"]);
    });
  });

  describe("mergeIntegrationToMain", () => {
    it("returns merged=true with sha on success", async () => {
      mockGit
        .mockResolvedValueOnce("")         // merge --no-ff
        .mockResolvedValueOnce("sha456");  // rev-parse HEAD

      const result = await mergeIntegrationToMain("/repo", "integration", "final merge");
      expect(result.merged).toBe(true);
      expect(result.commitSha).toBe("sha456");
    });

    it("returns conflicts on failure", async () => {
      mockGit
        .mockRejectedValueOnce(new Error("conflict"))    // merge fails
        .mockResolvedValueOnce("a.ts\nb.ts")             // diff
        .mockResolvedValueOnce("");                        // abort

      const result = await mergeIntegrationToMain("/repo", "integration", "merge");
      expect(result.merged).toBe(false);
      expect(result.conflicts).toEqual(["a.ts", "b.ts"]);
    });
  });

  describe("cleanupIntegrationBranch", () => {
    it("does not throw when branch exists", async () => {
      await expect(cleanupIntegrationBranch("/repo", "monsthera/convoy/WG-1")).resolves.toBeUndefined();
    });

    it("does not throw when branch does not exist", async () => {
      mockGit.mockRejectedValueOnce(new Error("not found"));
      await expect(cleanupIntegrationBranch("/repo", "monsthera/convoy/WG-1")).resolves.toBeUndefined();
    });
  });
});
