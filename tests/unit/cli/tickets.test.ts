import { describe, expect, it, vi } from "vitest";
import type { InsightStream } from "../../../src/core/insight-stream.js";
import { extractTicketIdsFromText, reconcileCommitTickets } from "../../../src/cli/tickets.js";
import { pathOverlaps, computePathOverlapScore } from "../../../src/db/queries.js";

function createInsight(): InsightStream {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as InsightStream;
}

describe("ticket CLI commit reconciliation", () => {
  const config = {
    repoPath: "/repo",
    agoraDir: ".agora",
    dbName: "agora.db",
  } as const;

  const ctx = {
    repoRoot: "/repo",
    repoId: 7,
    db: {},
    sqlite: {},
  } as unknown as Parameters<typeof reconcileCommitTickets>[0];

  it("extracts unique ticket IDs from commit text and normalizes casing", () => {
    expect(extractTicketIdsFromText(
      "feat: finish tkt-abcd1234, follow-up TKT-abcd1234, plus TKT-EEFF0099",
    )).toEqual([
      "TKT-abcd1234",
      "TKT-eeff0099",
    ]);
  });

  it("resolves only tickets that are ready_for_commit", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-ready111") {
        return { status: "ready_for_commit" };
      }
      if (ticketId === "TKT-review222") {
        return { status: "in_review" };
      }
      return null;
    });
    const transitionTicket = vi.fn().mockReturnValue({
      ok: true,
      data: {
        ticketId: "TKT-ready111",
        previousStatus: "ready_for_commit",
        status: "resolved",
      },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "abc123def456",
      commitMessage: "feat: close TKT-ready111, revisit TKT-review222, mention TKT-missing333",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("abc123d"),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketByTicketId: getTicketByTicketId as unknown as NonNullable<Parameters<typeof reconcileCommitTickets>[4]>["getTicketByTicketId"],
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(transitionTicket).toHaveBeenCalledTimes(1);
    expect(transitionTicket).toHaveBeenCalledWith(ctx, config, insight, {
      ticketId: "TKT-ready111",
      comment: "Auto-resolved after commit abc123d.",
      actorLabel: "post-commit",
    });
    expect(payload).toEqual({
      commitSha: "abc123def456",
      commitShortSha: "abc123d",
      ticketIds: ["TKT-ready111", "TKT-review222", "TKT-missing333"],
      inferredTicketIds: [],
      cascadedTicketIds: [],
      resolved: [{
        ticketId: "TKT-ready111",
        previousStatus: "ready_for_commit",
        status: "resolved",
        source: "commit_message",
      }],
      advanced: [],
      skipped: [
        { ticketId: "TKT-review222", reason: "not_ready_for_commit", status: "in_review" },
        { ticketId: "TKT-missing333", reason: "not_found" },
      ],
    });
  });

  it("infers ticket from affected paths when not in commit message", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-pathticket") return { id: 10, ticketId: "TKT-pathticket", status: "ready_for_commit" };
      return null;
    });
    const transitionTicket = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-pathticket", previousStatus: "ready_for_commit", status: "resolved" },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "aaa111",
      commitMessage: "chore: refactor utils",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("aaa111"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/foo.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-pathticket", status: "ready_for_commit" },
      ]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(payload.inferredTicketIds).toEqual(["TKT-pathticket"]);
    expect(payload.resolved).toHaveLength(1);
    expect(payload.resolved[0]!.source).toBe("path_match");
    expect(transitionTicket).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate ticket already in commit message during path inference", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-dupeticket") return { id: 11, ticketId: "TKT-dupeticket", status: "ready_for_commit" };
      return null;
    });
    const transitionTicket = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-dupeticket", previousStatus: "ready_for_commit", status: "resolved" },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "bbb222",
      commitMessage: "feat: close TKT-dupeticket",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("bbb222"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/foo.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-dupeticket", status: "ready_for_commit" },
      ]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(payload.ticketIds).toEqual(["TKT-dupeticket"]);
    expect(payload.inferredTicketIds).toEqual([]);
    expect(transitionTicket).toHaveBeenCalledTimes(1);
  });

  it("matches tickets by directory prefix in affectedPaths", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-dirticket") return { id: 12, ticketId: "TKT-dirticket", status: "ready_for_commit" };
      return null;
    });
    const transitionTicket = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-dirticket", previousStatus: "ready_for_commit", status: "resolved" },
    });

    // getReadyTicketsByAffectedPaths delegates to pathOverlaps internally;
    // here we test the integration by simulating a match from the query
    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "ccc333",
      commitMessage: "fix: lifecycle bug",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("ccc333"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/tickets/lifecycle.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-dirticket", status: "ready_for_commit" },
      ]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(payload.inferredTicketIds).toEqual(["TKT-dirticket"]);
    expect(payload.resolved[0]!.source).toBe("path_match");
  });

  it("cascades resolution to ready_for_commit dependents", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-parent01") return { id: 20, ticketId: "TKT-parent01", status: "ready_for_commit" };
      if (ticketId === "TKT-child01") return { id: 21, ticketId: "TKT-child01", status: "ready_for_commit" };
      return null;
    });
    let callCount = 0;
    const transitionTicket = vi.fn().mockImplementation((_ctx, _cfg, _insight, input) => {
      callCount++;
      return {
        ok: true,
        data: { ticketId: input.ticketId, previousStatus: "ready_for_commit", status: "resolved" },
      };
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "ddd444",
      commitMessage: "feat: complete TKT-parent01",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("ddd444"),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketById: vi.fn().mockImplementation((_db: unknown, id: number) => {
        if (id === 21) return { ticketId: "TKT-child01", status: "ready_for_commit" };
        return null;
      }),
      getTicketDependencies: vi.fn().mockImplementation((_db: unknown, ticketId: number) => {
        if (ticketId === 20) {
          return { outgoing: [], incoming: [{ relationType: "blocked_by", fromTicketId: 21 }] };
        }
        return { outgoing: [], incoming: [] };
      }),
      transitionTicket,
    });

    expect(payload.cascadedTicketIds).toEqual(["TKT-child01"]);
    expect(payload.resolved).toHaveLength(2);
    expect(payload.resolved[0]!.source).toBe("commit_message");
    expect(payload.resolved[1]!.source).toBe("dependency_cascade");
    expect(callCount).toBe(2);
  });

  it("cascades advance to in_progress dependents when parent is resolved", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-parent02") return { id: 30, ticketId: "TKT-parent02", status: "ready_for_commit" };
      return null;
    });
    const transitionTicket = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-parent02", previousStatus: "ready_for_commit", status: "resolved" },
    });
    const advanceTicketDep = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-child02", previousStatus: "in_progress", status: "in_review" },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "eee555",
      commitMessage: "feat: complete TKT-parent02",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("eee555"),
      getChangedFiles: vi.fn().mockResolvedValue([]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketsByStatusesAndAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketById: vi.fn().mockImplementation((_db: unknown, id: number) => {
        if (id === 31) return { ticketId: "TKT-child02", status: "in_progress" };
        return null;
      }),
      getTicketDependencies: vi.fn().mockReturnValue({
        outgoing: [], incoming: [{ relationType: "blocked_by", fromTicketId: 31 }],
      }),
      transitionTicket,
      advanceTicket: advanceTicketDep,
    });

    expect(payload.cascadedTicketIds).toEqual(["TKT-child02"]);
    expect(payload.resolved).toHaveLength(1);
    expect(payload.advanced).toHaveLength(1);
    expect(payload.advanced[0]!.source).toBe("dependency_cascade");
    expect(transitionTicket).toHaveBeenCalledTimes(1);
    expect(advanceTicketDep).toHaveBeenCalledTimes(1);
  });

  it("returns empty inferredTicketIds when no paths match", async () => {
    const insight = createInsight();
    const transitionTicket = vi.fn();

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "fff666",
      commitMessage: "chore: update readme",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("fff666"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "README.md" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketByTicketId: vi.fn().mockReturnValue(null) as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(payload.inferredTicketIds).toEqual([]);
    expect(payload.cascadedTicketIds).toEqual([]);
    expect(payload.resolved).toEqual([]);
    expect(transitionTicket).not.toHaveBeenCalled();
  });

  it("includes source in payload for each resolution type", async () => {
    const insight = createInsight();
    const getTicketByTicketId = vi.fn((_db: unknown, ticketId: string) => {
      if (ticketId === "TKT-explicit") return { id: 40, ticketId: "TKT-explicit", status: "ready_for_commit" };
      if (ticketId === "TKT-inferred") return { id: 41, ticketId: "TKT-inferred", status: "ready_for_commit" };
      return null;
    });
    const transitionTicket = vi.fn().mockImplementation((_ctx, _cfg, _insight, input) => ({
      ok: true,
      data: { ticketId: input.ticketId, previousStatus: "ready_for_commit", status: "resolved" },
    }));

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "ggg777",
      commitMessage: "feat: finish TKT-explicit",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("ggg777"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/bar.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-inferred", status: "ready_for_commit" },
      ]),
      getTicketByTicketId: getTicketByTicketId as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
    });

    expect(payload.resolved).toHaveLength(2);
    expect(payload.resolved[0]!.source).toBe("commit_message");
    expect(payload.resolved[1]!.source).toBe("path_match");
  });

  it("advances approved ticket to in_progress when path overlap exceeds threshold", async () => {
    const insight = createInsight();
    const transitionTicket = vi.fn();
    const advanceTicketDep = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-approved01", previousStatus: "approved", status: "in_progress" },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "hhh888",
      commitMessage: "feat: implement feature",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("hhh888"),
      getChangedFiles: vi.fn().mockResolvedValue([
        { status: "M", path: "src/api/handler.ts" },
        { status: "M", path: "src/api/types.ts" },
      ]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketsByStatusesAndAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-approved01", status: "approved", overlapScore: 0.75 },
      ]),
      getTicketByTicketId: vi.fn().mockReturnValue(null) as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
      advanceTicket: advanceTicketDep,
    });

    expect(payload.advanced).toHaveLength(1);
    expect(payload.advanced[0]!.ticketId).toBe("TKT-approved01");
    expect(payload.advanced[0]!.source).toBe("path_match");
    expect(advanceTicketDep).toHaveBeenCalledTimes(1);
  });

  it("skips ticket with overlap below confidence threshold", async () => {
    const insight = createInsight();
    const transitionTicket = vi.fn();
    const advanceTicketDep = vi.fn();

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "iii999",
      commitMessage: "chore: minor fix",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("iii999"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/utils.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketsByStatusesAndAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-lowoverlap", status: "approved", overlapScore: 0.25 },
      ]),
      getTicketByTicketId: vi.fn().mockReturnValue(null) as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
      advanceTicket: advanceTicketDep,
    });

    expect(payload.advanced).toEqual([]);
    expect(payload.skipped).toContainEqual({
      ticketId: "TKT-lowoverlap",
      reason: "below_confidence",
      status: "approved",
      overlapScore: 0.25,
    });
    expect(advanceTicketDep).not.toHaveBeenCalled();
  });

  it("advances in_progress ticket to in_review via path match", async () => {
    const insight = createInsight();
    const transitionTicket = vi.fn();
    const advanceTicketDep = vi.fn().mockReturnValue({
      ok: true,
      data: { ticketId: "TKT-inprog01", previousStatus: "in_progress", status: "in_review" },
    });

    const payload = await reconcileCommitTickets(ctx, config, insight, {
      commitSha: "jjj000",
      commitMessage: "fix: resolve bug",
      actorLabel: "post-commit",
    }, {
      getShortSha: vi.fn().mockResolvedValue("jjj000"),
      getChangedFiles: vi.fn().mockResolvedValue([{ status: "M", path: "src/core/engine.ts" }]),
      getReadyTicketsByAffectedPaths: vi.fn().mockReturnValue([]),
      getTicketsByStatusesAndAffectedPaths: vi.fn().mockReturnValue([
        { ticketId: "TKT-inprog01", status: "in_progress", overlapScore: 1.0 },
      ]),
      getTicketByTicketId: vi.fn().mockReturnValue(null) as never,
      getTicketDependencies: vi.fn().mockReturnValue({ outgoing: [], incoming: [] }),
      transitionTicket,
      advanceTicket: advanceTicketDep,
    });

    expect(payload.advanced).toHaveLength(1);
    expect(payload.advanced[0]!.status).toBe("in_review");
    expect(payload.advanced[0]!.source).toBe("path_match");
  });
});

describe("pathOverlaps", () => {
  it("matches exact file paths", () => {
    expect(pathOverlaps("src/foo.ts", "src/foo.ts")).toBe(true);
  });

  it("rejects different file paths", () => {
    expect(pathOverlaps("src/foo.ts", "src/bar.ts")).toBe(false);
  });

  it("matches changed file inside directory prefix (trailing slash)", () => {
    expect(pathOverlaps("src/tickets/lifecycle.ts", "src/tickets/")).toBe(true);
  });

  it("matches changed file inside directory prefix (no trailing slash)", () => {
    expect(pathOverlaps("src/tickets/lifecycle.ts", "src/tickets")).toBe(true);
  });

  it("rejects partial directory name match", () => {
    // "src/tick" should not match "src/tickets/lifecycle.ts"
    expect(pathOverlaps("src/tickets/lifecycle.ts", "src/tick")).toBe(false);
  });

  it("normalizes leading ./", () => {
    expect(pathOverlaps("./src/foo.ts", "src/foo.ts")).toBe(true);
    expect(pathOverlaps("src/foo.ts", "./src/foo.ts")).toBe(true);
  });

  it("normalizes backslashes to forward slashes", () => {
    expect(pathOverlaps("src\\foo.ts", "src/foo.ts")).toBe(true);
  });
});

describe("computePathOverlapScore", () => {
  it("returns 1.0 when all ticket paths are covered", () => {
    expect(computePathOverlapScore(
      ["src/api/handler.ts", "src/api/types.ts"],
      ["src/api/"],
    )).toBe(1.0);
  });

  it("returns 0 when no paths match", () => {
    expect(computePathOverlapScore(
      ["src/cli/main.ts"],
      ["src/api/", "src/db/"],
    )).toBe(0);
  });

  it("returns fractional score for partial overlap", () => {
    expect(computePathOverlapScore(
      ["src/api/handler.ts"],
      ["src/api/", "src/db/"],
    )).toBe(0.5);
  });

  it("returns 0 for empty ticket paths", () => {
    expect(computePathOverlapScore(["src/foo.ts"], [])).toBe(0);
  });
});
