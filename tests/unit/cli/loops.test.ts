import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightStream } from "../../../src/core/insight-stream.js";
import { cmdLoop } from "../../../src/cli/loops.js";

function createInsight(): InsightStream {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as InsightStream;
}

function toolTextPayload(value: unknown) {
  return {
    content: [{
      type: "text",
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    }],
  };
}

describe("loop CLI", () => {
  const config = {
    repoPath: "/repo",
    agoraDir: ".agora",
    dbName: "agora.db",
    verbosity: "quiet",
  } as any;

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = undefined;
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("runs the planner loop through auto-registration and session cleanup", async () => {
    const insight = createInsight();
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-plan",
          sessionId: "session-plan",
          role: "facilitator",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "planner-loop",
          status: "completed",
          outputs: {
            approved: { tickets: [] },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, ["plan", "--limit", "3", "--json"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
    });

    expect(callTool).toHaveBeenNthCalledWith(1, "register_agent", {
      name: "Planner Loop Facilitator",
      type: "cli-loop",
      desiredRole: "facilitator",
    });
    expect(callTool).toHaveBeenNthCalledWith(2, "run_workflow", {
      name: "planner-loop",
      params: { limit: 3 },
      agentId: "agent-plan",
      sessionId: "session-plan",
    });
    expect(callTool).toHaveBeenNthCalledWith(3, "end_session", {
      agentId: "agent-plan",
      sessionId: "session-plan",
    });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      loop: "plan",
      workflowName: "planner-loop",
      agent: {
        name: "Planner Loop Facilitator",
        agentId: "agent-plan",
        sessionId: "session-plan",
        role: "facilitator",
        resumed: false,
      },
      result: {
        name: "planner-loop",
        status: "completed",
        outputs: {
          approved: { tickets: [] },
        },
      },
    }, null, 2));
  });

  it("creates loop context without starting the lifecycle sweep timer", async () => {
    const insight = createInsight();
    const createContextLoader = vi.fn().mockReturnValue(async () => ({
      sqlite: { close: vi.fn() },
      globalSqlite: null,
      dispose: vi.fn(),
    }));
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-plan",
          sessionId: "session-plan",
          role: "facilitator",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "planner-loop",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop({
      ...config,
      lifecycle: {
        enabled: true,
        autoTriageOnCreate: true,
        autoTriageSeverityThreshold: "medium",
        autoTriagePriorityThreshold: 5,
        autoCloseResolvedAfterMs: 0,
        autoReviewOnPatch: false,
        autoCascadeBlocked: true,
        sweepIntervalMs: 60_000,
      },
    } as any, insight, ["plan"], {
      createContextLoader: createContextLoader as any,
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
    });

    expect(createContextLoader).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: expect.objectContaining({ enabled: true }),
      }),
      insight,
      { startLifecycleSweep: false },
    );
  });

  it("normalizes council transitions and accepts the ticket id positionally", async () => {
    const insight = createInsight();
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-review",
          sessionId: "session-review",
          role: "reviewer",
          resumed: true,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "council-loop",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, [
      "council",
      "TKT-1234abcd",
      "--transition",
      "technical_analysis->approved",
      "--since-commit",
      "abc1234",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
    });

    expect(callTool).toHaveBeenNthCalledWith(2, "run_workflow", {
      name: "council-loop",
      params: {
        ticketId: "TKT-1234abcd",
        transition: "technical_analysis→approved",
        sinceCommit: "abc1234",
      },
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(logSpy).toHaveBeenCalledWith([
      "council-loop via Council Loop Reviewer",
      JSON.stringify({
        name: "council-loop",
        status: "completed",
      }, null, 2),
    ].join("\n"));
  });

  it("fails on missing council transition before invoking any tools", async () => {
    const insight = createInsight();
    const callTool = vi.fn();

    await cmdLoop(config, insight, ["council", "TKT-1234abcd"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
    });

    expect(callTool).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("still ends the session when the workflow fails", async () => {
    const insight = createInsight();
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-dev",
          sessionId: "session-dev",
          role: "developer",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        tool: "run_workflow",
        errorCode: "execution_failed",
        message: "Workflow failed",
        result: toolTextPayload({
          name: "developer-loop",
          status: "failed",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, ["dev", "--json"], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
    });

    expect(process.exitCode).toBe(1);
    expect(callTool).toHaveBeenNthCalledWith(3, "end_session", {
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({
      loop: "dev",
      workflowName: "developer-loop",
      agent: {
        name: "Developer Loop",
        agentId: "agent-dev",
        sessionId: "session-dev",
        role: "developer",
        resumed: false,
      },
      result: {
        name: "developer-loop",
        status: "failed",
      },
    }, null, 2));
  });

  it("keeps a persistent planner session alive and suppresses unchanged workflow payloads", async () => {
    const insight = createInsight();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-plan",
          sessionId: "session-plan",
          role: "facilitator",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "poll_coordination",
        result: toolTextPayload({ topology: "hub-spoke", count: 0, messages: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "custom:planner-loop",
          status: "completed",
          durationMs: 11,
          outputs: { approved: { tickets: [] } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "poll_coordination",
        result: toolTextPayload({ topology: "hub-spoke", count: 0, messages: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "custom:planner-loop",
          status: "completed",
          durationMs: 29,
          outputs: { approved: { tickets: [] } },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, [
      "plan",
      "--watch",
      "--interval-ms",
      "1000",
      "--max-runs",
      "2",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
      sleep,
    });

    expect(callTool.mock.calls[1]).toEqual([
      "poll_coordination",
      expect.objectContaining({
        agentId: "agent-plan",
        sessionId: "session-plan",
        limit: 100,
      }),
    ]);
    expect(callTool).toHaveBeenNthCalledWith(3, "run_workflow", {
      name: "planner-loop",
      params: {},
      agentId: "agent-plan",
      sessionId: "session-plan",
    });
    expect(callTool).toHaveBeenNthCalledWith(5, "run_workflow", {
      name: "planner-loop",
      params: {},
      agentId: "agent-plan",
      sessionId: "session-plan",
    });
    expect(callTool).toHaveBeenNthCalledWith(6, "end_session", {
      agentId: "agent-plan",
      sessionId: "session-plan",
    });

    const messages = logSpy.mock.calls.map((call: unknown[]) => String(call[0]));
    expect(messages.some((message: string) => message.includes("Watching planner-loop via Planner Loop Facilitator every 1000ms"))).toBe(true);
    expect(messages.filter((message: string) => message.includes("[cycle 1] planner-loop (initial)"))).toHaveLength(1);
    expect(messages.filter((message: string) => message.includes("[cycle 2] planner-loop"))).toHaveLength(0);
    expect(messages.some((message: string) => message.includes("Stopped planner-loop after 2 cycle(s) (max_runs)"))).toBe(true);
  });

  it("processes council review requests in watch mode without a fixed ticket", async () => {
    const insight = createInsight();
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-review",
          sessionId: "session-review",
          role: "reviewer",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "poll_coordination",
        result: toolTextPayload({
          topology: "hub-spoke",
          count: 1,
          messages: [{
            id: "msg-1",
            from: "agent-facilitator",
            to: "agent-review",
            type: "broadcast",
            payload: {
              kind: "review_request",
              ticketId: "TKT-1234abcd",
              transition: "technical_analysis->approved",
            },
            timestamp: "2026-03-13T10:00:00.000Z",
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "run_workflow",
        result: toolTextPayload({
          name: "custom:council-loop",
          status: "completed",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, [
      "council",
      "--watch",
      "--interval-ms",
      "1000",
      "--max-runs",
      "1",
      "--json",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(callTool).toHaveBeenNthCalledWith(3, "run_workflow", {
      name: "council-loop",
      params: {
        ticketId: "TKT-1234abcd",
        transition: "technical_analysis→approved",
      },
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const jsonEvents = logSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(jsonEvents.some((event: any) => event.event === "workflow_result" && event.reason === "review_request")).toBe(true);
  });

  it("falls back to backlog planning in council watch mode when review and TA queues are empty", async () => {
    const insight = createInsight();
    const callTool = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        tool: "register_agent",
        result: toolTextPayload({
          agentId: "agent-review",
          sessionId: "session-review",
          role: "reviewer",
          resumed: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "poll_coordination",
        result: toolTextPayload({ topology: "hub-spoke", count: 0, messages: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "list_tickets",
        result: toolTextPayload({ count: 0, tickets: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "list_tickets",
        result: toolTextPayload({ count: 0, tickets: [] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "list_tickets",
        result: toolTextPayload({
          count: 1,
          tickets: [{
            ticketId: "TKT-backlog111",
            title: "Backlog item",
            status: "backlog",
            priority: 8,
            severity: "high",
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        tool: "end_session",
        result: toolTextPayload({ ended: true }),
      });

    await cmdLoop(config, insight, [
      "council",
      "--watch",
      "--limit",
      "3",
      "--interval-ms",
      "1000",
      "--max-runs",
      "1",
      "--json",
    ], {
      createServer: (() => ({} as any)) as any,
      getRunner: () => ({ callTool } as any),
      sleep: vi.fn().mockResolvedValue(undefined),
    });

    expect(callTool).toHaveBeenNthCalledWith(3, "list_tickets", {
      status: "in_review",
      limit: 3,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(callTool).toHaveBeenNthCalledWith(4, "list_tickets", {
      status: "technical_analysis",
      limit: 3,
      agentId: "agent-review",
      sessionId: "session-review",
    });
    expect(callTool).toHaveBeenNthCalledWith(5, "list_tickets", {
      status: "backlog",
      limit: 3,
      agentId: "agent-review",
      sessionId: "session-review",
    });

    const jsonEvents = logSpy.mock.calls.map((call: unknown[]) => JSON.parse(String(call[0])));
    expect(jsonEvents.some((event: any) => event.event === "backlog_queue" && Array.isArray(event.tickets) && event.tickets[0].ticketId === "TKT-backlog111")).toBe(true);
  });
});
