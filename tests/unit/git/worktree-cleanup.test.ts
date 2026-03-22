import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

// Mock child_process before importing worktree module
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile) as unknown as ReturnType<typeof vi.fn>;

// Dynamic import to ensure mocks are in place
let cleanupOrphanedWorktrees: typeof import("../../../src/git/worktree.js").cleanupOrphanedWorktrees;

beforeEach(async () => {
  vi.clearAllMocks();
  const mod = await import("../../../src/git/worktree.js");
  cleanupOrphanedWorktrees = mod.cleanupOrphanedWorktrees;
});

function mockGitWorktreeList(output: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb?: (...a: any[]) => void) => {
    // If called with promisify pattern (no callback), handle accordingly
    if (typeof _opts === "function") {
      // promisify pattern: execFile(cmd, args, callback)
      const callback = _opts as (...a: unknown[]) => void;
      if (args.includes("list")) {
        callback(null, { stdout: output, stderr: "" });
      } else if (args.includes("remove") || args.includes("-D")) {
        callback(null, { stdout: "", stderr: "" });
      }
      return;
    }
    if (cb) {
      if (args.includes("list")) {
        cb(null, { stdout: output, stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return;
    }
    // promisify calls without explicit callback
    return undefined;
  });
}

const WORKTREE_OUTPUT_ORPHAN = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.monsthera/worktrees/sess-orphan
HEAD def456
branch refs/heads/monsthera/agent/sess-orphan

`;

const WORKTREE_OUTPUT_TWO = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo/.monsthera/worktrees/sess-a
HEAD def456
branch refs/heads/monsthera/agent/sess-a

worktree /repo/.monsthera/worktrees/sess-b
HEAD ghi789
branch refs/heads/monsthera/agent/sess-b

`;

describe("cleanupOrphanedWorktrees", () => {
  it("removes worktree when sessionId not in active set", async () => {
    mockGitWorktreeList(WORKTREE_OUTPUT_ORPHAN);

    const result = await cleanupOrphanedWorktrees("/repo", new Set(["other-session"]));

    expect(result.removed).toEqual(["sess-orphan"]);
    expect(result.errors).toHaveLength(0);
  });

  it("keeps worktree when sessionId is in active set", async () => {
    mockGitWorktreeList(WORKTREE_OUTPUT_ORPHAN);

    const result = await cleanupOrphanedWorktrees("/repo", new Set(["sess-orphan"]));

    expect(result.removed).toHaveLength(0);
  });

  it("dry run: reports what would be removed but does not remove", async () => {
    mockGitWorktreeList(WORKTREE_OUTPUT_ORPHAN);

    const result = await cleanupOrphanedWorktrees("/repo", new Set(), { dryRun: true });

    expect(result.removed).toEqual(["sess-orphan"]);
    // Only the list call should happen, not remove/branch-delete
    const removeCalls = mockExecFile.mock.calls.filter(
      (c: unknown[]) => Array.isArray(c[1]) && (c[1] as string[]).includes("remove"),
    );
    expect(removeCalls).toHaveLength(0);
  });

  it("empty worktree list (no agent worktrees): returns empty results", async () => {
    mockGitWorktreeList(`worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n`);

    const result = await cleanupOrphanedWorktrees("/repo", new Set());

    expect(result.removed).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("all worktrees active: nothing removed", async () => {
    mockGitWorktreeList(WORKTREE_OUTPUT_TWO);

    const result = await cleanupOrphanedWorktrees("/repo", new Set(["sess-a", "sess-b"]));

    expect(result.removed).toHaveLength(0);
  });

  it("mixed: removes orphan, keeps active", async () => {
    mockGitWorktreeList(WORKTREE_OUTPUT_TWO);

    const result = await cleanupOrphanedWorktrees("/repo", new Set(["sess-a"]));

    expect(result.removed).toEqual(["sess-b"]);
  });
});
