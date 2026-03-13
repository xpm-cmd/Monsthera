import { describe, expect, it, vi } from "vitest";
import type { InsightStream } from "../../../src/core/insight-stream.js";
import { extractTicketIdsFromText, reconcileCommitTickets } from "../../../src/cli/tickets.js";

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
      getTicketByTicketId: getTicketByTicketId as unknown as NonNullable<Parameters<typeof reconcileCommitTickets>[4]>["getTicketByTicketId"],
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
      resolved: [{
        ticketId: "TKT-ready111",
        previousStatus: "ready_for_commit",
        status: "resolved",
      }],
      skipped: [
        { ticketId: "TKT-review222", reason: "not_ready_for_commit", status: "in_review" },
        { ticketId: "TKT-missing333", reason: "not_found" },
      ],
    });
  });
});
