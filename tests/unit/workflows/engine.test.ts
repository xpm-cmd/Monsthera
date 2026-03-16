import { describe, expect, it } from "vitest";
import { runWorkflow } from "../../../src/workflows/engine.js";
import type { ReviewerResolution, WorkflowSpec } from "../../../src/workflows/types.js";

class FakeRunner {
  readonly calls: Array<{ tool: string; input: Record<string, unknown> }> = [];

  constructor(
    private readonly handlers: Record<string, (input: Record<string, unknown>) => Promise<any> | any>,
  ) {}

  has(name: string): boolean {
    return name in this.handlers;
  }

  async callTool(name: string, input: Record<string, unknown>) {
    this.calls.push({ tool: name, input });
    const handler = this.handlers[name];
    if (!handler) {
      return {
        ok: false,
        tool: name,
        errorCode: "tool_not_found" as const,
        message: `Tool not found: ${name}`,
      };
    }
    return handler(input);
  }
}

function ok(tool: string, payload: unknown) {
  return {
    ok: true as const,
    tool,
    result: {
      content: [{ type: "text", text: JSON.stringify(payload) }],
    },
  };
}

function fail(tool: string, errorCode: "denied" | "execution_failed", message: string) {
  return {
    ok: false as const,
    tool,
    errorCode,
    message,
  };
}

function verdict(
  specialization: string,
  value: "pass" | "fail" | "abstain",
) {
  return {
    specialization,
    verdict: value,
    agentId: `agent-${specialization}`,
    sessionId: `session-${specialization}`,
    reasoning: null,
    createdAt: "2026-03-13T00:00:00.000Z",
  };
}

describe("workflow engine", () => {
  it("executes sequential steps with projection-based output piping", async () => {
    const spec: WorkflowSpec = {
      name: "deep-review",
      description: "demo",
      requiredParams: ["query"],
      steps: [
        {
          key: "changes",
          tool: "get_change_pack",
          input: { query: "{{params.query}}" },
        },
        {
          key: "complexity",
          tool: "analyze_complexity",
          forEach: "steps.changes.changedFiles",
          input: { filePath: "{{item.path}}" },
        },
        {
          key: "suggestions",
          tool: "suggest_actions",
          input: { changedPaths: "{{steps.changes.changedFiles.path}}" },
        },
      ],
    };

    const runner = new FakeRunner({
      get_change_pack: async ({ query }) => ok("get_change_pack", {
        query,
        changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      }),
      analyze_complexity: async ({ filePath }) => ok("analyze_complexity", {
        filePath,
        complexityScore: 3,
      }),
      suggest_actions: async ({ changedPaths }) => ok("suggest_actions", { changedPaths }),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
    }, {
      query: "latest",
    });

    expect(result.status).toBe("completed");
    expect(runner.calls.map((call) => call.tool)).toEqual([
      "get_change_pack",
      "analyze_complexity",
      "analyze_complexity",
      "suggest_actions",
    ]);
    expect(runner.calls[0]?.input).toMatchObject({
      query: "latest",
      agentId: "agent-dev",
      sessionId: "session-dev",
    });
    expect(runner.calls[3]?.input).toMatchObject({
      changedPaths: ["src/a.ts", "src/b.ts"],
    });
    expect(result.outputs.suggestions).toEqual({
      changedPaths: ["src/a.ts", "src/b.ts"],
    });
  });

  it("continues on foreach failures when the step opts into onError=continue", async () => {
    const spec: WorkflowSpec = {
      name: "partial-demo",
      description: "demo",
      steps: [
        {
          key: "changes",
          tool: "get_change_pack",
          input: {},
        },
        {
          key: "coverage",
          tool: "analyze_test_coverage",
          forEach: "steps.changes.changedFiles",
          onError: "continue",
          input: { filePath: "{{item.path}}" },
        },
        {
          key: "suggestions",
          tool: "suggest_actions",
          input: { changedPaths: "{{steps.changes.changedFiles.path}}" },
        },
      ],
    };

    const runner = new FakeRunner({
      get_change_pack: async () => ok("get_change_pack", {
        changedFiles: [{ path: "src/a.ts" }, { path: "src/b.ts" }],
      }),
      analyze_test_coverage: async ({ filePath }) => (
        filePath === "src/b.ts"
          ? fail("analyze_test_coverage", "execution_failed", "coverage unavailable")
          : ok("analyze_test_coverage", { filePath, verdict: "tested" })
      ),
      suggest_actions: async ({ changedPaths }) => ok("suggest_actions", { changedPaths }),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
    });

    expect(result.status).toBe("partial");
    expect(result.steps[1]).toMatchObject({
      key: "coverage",
      status: "partial",
    });
    expect(result.steps[2]).toMatchObject({
      key: "suggestions",
      status: "completed",
    });
  });

  it("stops immediately on the first failing step by default", async () => {
    const spec: WorkflowSpec = {
      name: "fail-fast",
      description: "demo",
      steps: [
        {
          key: "changes",
          tool: "get_change_pack",
          input: {},
        },
        {
          key: "knowledge",
          tool: "store_knowledge",
          input: { title: "Demo" },
        },
        {
          key: "after",
          tool: "capabilities",
          input: {},
        },
      ],
    };

    const runner = new FakeRunner({
      get_change_pack: async () => ok("get_change_pack", { changedFiles: [] }),
      store_knowledge: async () => fail("store_knowledge", "denied", "Role observer does not have access"),
      capabilities: async () => ok("capabilities", { tools: [] }),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-obs", sessionId: "session-obs" },
    });

    expect(result.status).toBe("failed");
    expect(runner.calls.map((call) => call.tool)).toEqual([
      "get_change_pack",
      "store_knowledge",
    ]);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toMatchObject({
      key: "knowledge",
      status: "failed",
      errorCode: "denied",
    });
  });

  it("proceeds once a quorum checkpoint reaches analytical quorum", async () => {
    const spec: WorkflowSpec = {
      name: "quorum-ready",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-ready",
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
        {
          key: "after",
          tool: "capabilities",
          input: {},
        },
      ],
    };

    const runner = new FakeRunner({
      capabilities: async () => ok("capabilities", { tools: ["run_workflow"] }),
    });
    const sent: Array<Record<string, unknown>> = [];
    let nowMs = 0;
    let polls = 0;

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => {
        polls += 1;
        return polls === 1
          ? []
          : [
              verdict("architect", "pass"),
              verdict("simplifier", "pass"),
              verdict("security", "pass"),
              verdict("performance", "pass"),
            ];
      },
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
    });

    expect(result.status).toBe("completed");
    expect(result.steps[0]).toMatchObject({
      key: "quorum",
      status: "completed",
    });
    expect(result.outputs.quorum).toMatchObject({
      status: "ready",
      advisoryReady: true,
      requiredPasses: 4,
      counts: {
        pass: 4,
      },
    });
    expect(result.steps[1]).toMatchObject({
      key: "after",
      status: "completed",
    });
    expect(sent).toEqual([
      expect.objectContaining({
        ticketId: "TKT-ready",
        workflowName: "quorum-ready",
        stepKey: "quorum",
      }),
    ]);
  });

  it("blocks when a quorum checkpoint can no longer reach quorum", async () => {
    const spec: WorkflowSpec = {
      name: "quorum-blocked",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-blocked",
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
        {
          key: "after",
          tool: "capabilities",
          input: {},
        },
      ],
    };

    const runner = new FakeRunner({
      capabilities: async () => ok("capabilities", { tools: [] }),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => [
        verdict("architect", "pass"),
        verdict("simplifier", "fail"),
        verdict("security", "abstain"),
        verdict("performance", "fail"),
        verdict("patterns", "abstain"),
      ],
      sendCoordination: async () => {},
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      key: "quorum",
      status: "failed",
      errorCode: "workflow_quorum_blocked",
      output: expect.objectContaining({
        status: "blocked_on_quorum",
        advisoryReady: false,
        blockedByVeto: false,
      }),
    });
  });

  it("continues with warning after a quorum timeout when configured", async () => {
    const spec: WorkflowSpec = {
      name: "quorum-timeout",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-timeout",
            timeout: 0,
            onFail: "continue_with_warning",
          },
        },
        {
          key: "after",
          tool: "capabilities",
          input: {},
        },
      ],
    };

    const runner = new FakeRunner({
      capabilities: async () => ok("capabilities", { tools: ["capabilities"] }),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => [],
      sendCoordination: async () => {},
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.status).toBe("partial");
    expect(result.steps[0]).toMatchObject({
      key: "quorum",
      status: "partial",
      output: expect.objectContaining({
        status: "timed_out",
        advisoryReady: false,
      }),
    });
    expect(result.steps[1]).toMatchObject({
      key: "after",
      status: "completed",
    });
  });

  it("sends targeted dispatch when resolveReviewers resolves roles to agents", async () => {
    const spec: WorkflowSpec = {
      name: "dispatch-resolved",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-dispatch",
            roles: ["architect", "security"],
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
      ],
    };

    const runner = new FakeRunner({});
    const sent: Array<Record<string, unknown>> = [];
    let nowMs = 0;
    let pollCount = 0;
    const resolutions: ReviewerResolution[] = [
      { specialization: "architect", agentId: "agent-arch", agentName: "Architect Bot", sessionId: "s-arch", status: "resolved" },
      { specialization: "security", agentId: "agent-sec", agentName: "Security Bot", sessionId: "s-sec", status: "resolved" },
    ];

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => {
        pollCount += 1;
        return pollCount === 1
          ? []
          : [
              verdict("architect", "pass"),
              verdict("security", "pass"),
            ];
      },
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      resolveReviewers: async () => resolutions,
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    expect(result.status).toBe("completed");
    // Two targeted messages, one per resolved agent
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ targetAgentId: "agent-arch", roles: ["architect"] });
    expect(sent[1]).toMatchObject({ targetAgentId: "agent-sec", roles: ["security"] });
    // Output includes dispatch report
    expect((result.outputs.quorum as any).dispatch).toEqual(resolutions);
  });

  it("blocks with dispatch_blocked when all roles have no candidate", async () => {
    const spec: WorkflowSpec = {
      name: "dispatch-blocked",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-no-reviewers",
            roles: ["architect", "security"],
            timeout: 5,
          },
        },
      ],
    };

    const runner = new FakeRunner({});
    const sent: Array<Record<string, unknown>> = [];

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => [],
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      resolveReviewers: async () => [
        { specialization: "architect", agentId: null, agentName: null, sessionId: null, status: "no_candidate" },
        { specialization: "security", agentId: null, agentName: null, sessionId: null, status: "no_candidate" },
      ],
      now: () => 0,
      sleep: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(sent).toHaveLength(0); // No messages sent
    expect(result.steps[0]).toMatchObject({
      key: "quorum",
      status: "failed",
      errorCode: "workflow_dispatch_blocked",
      output: expect.objectContaining({ status: "blocked_on_dispatch" }),
    });
  });

  it("blocks when any unresolved role has no active candidate", async () => {
    const spec: WorkflowSpec = {
      name: "dispatch-partial",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-partial",
            roles: ["architect", "security"],
            requiredPasses: 2,
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
      ],
    };

    const runner = new FakeRunner({});
    const sent: Array<Record<string, unknown>> = [];

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => [
        verdict("architect", "pass"),
      ],
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      resolveReviewers: async () => [
        { specialization: "security", agentId: null, agentName: null, sessionId: null, status: "no_candidate" },
      ],
      now: () => 0,
      sleep: async () => {},
    });

    expect(sent).toHaveLength(0);
    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({
      errorCode: "workflow_dispatch_blocked",
      output: expect.objectContaining({
        status: "blocked_on_dispatch",
        missingRoles: ["security"],
        requestedRoles: ["security"],
      }),
    });
  });

  it("dispatches only the roles still missing from quorum", async () => {
    const spec: WorkflowSpec = {
      name: "dispatch-only-missing",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-missing-only",
            roles: ["architect", "security"],
            requiredPasses: 2,
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
      ],
    };

    const runner = new FakeRunner({});
    const sent: Array<Record<string, unknown>> = [];
    let nowMs = 0;
    let pollCount = 0;

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => {
        pollCount += 1;
        return pollCount === 1
          ? [verdict("architect", "pass")]
          : [verdict("architect", "pass"), verdict("security", "pass")];
      },
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      resolveReviewers: async (roles) => {
        expect(roles).toEqual(["security"]);
        return [
          { specialization: "security", agentId: "agent-sec", agentName: "Sec Bot", sessionId: "s-sec", status: "resolved" },
        ];
      },
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ targetAgentId: "agent-sec", roles: ["security"] });
    expect(result.status).toBe("completed");
  });

  it("retries a failing step up to the configured retry count", async () => {
    let callCount = 0;
    const sleepCalls: number[] = [];

    const spec: WorkflowSpec = {
      name: "retry-demo",
      description: "demo",
      steps: [
        {
          key: "flaky",
          tool: "analyze_complexity",
          input: { filePath: "src/a.ts" },
          retries: 2,
          retryDelayMs: 1000,
        },
      ],
    };

    const runner = new FakeRunner({
      analyze_complexity: async () => {
        callCount++;
        if (callCount < 3) {
          return fail("analyze_complexity", "execution_failed", "transient error");
        }
        return ok("analyze_complexity", { score: 5 });
      },
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      sleep: async (ms) => { sleepCalls.push(ms); },
    });

    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
    expect(result.steps[0]!.retryCount).toBe(2); // succeeded on attempt 3
    // Exponential backoff: 1000ms, 2000ms
    expect(sleepCalls).toEqual([1000, 2000]);
  });

  it("returns last failure when all retries are exhausted", async () => {
    const spec: WorkflowSpec = {
      name: "retry-exhaust",
      description: "demo",
      steps: [
        {
          key: "always_fails",
          tool: "analyze_complexity",
          input: { filePath: "src/a.ts" },
          retries: 2,
          retryDelayMs: 100,
        },
      ],
    };

    const runner = new FakeRunner({
      analyze_complexity: async () => fail("analyze_complexity", "execution_failed", "permanent error"),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      sleep: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(runner.calls).toHaveLength(3); // initial + 2 retries
    expect(result.steps[0]!.retryCount).toBe(2);
    expect(result.steps[0]!.errorCode).toBe("execution_failed");
  });

  it("does not retry tool_not_found errors", async () => {
    const spec: WorkflowSpec = {
      name: "no-retry-missing",
      description: "demo",
      steps: [
        {
          key: "missing",
          tool: "nonexistent_tool" as any,
          input: {},
          retries: 3,
        },
      ],
    };

    const runner = new FakeRunner({});

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      sleep: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(runner.calls).toHaveLength(0); // runner.has() returned false, no calls made
    expect(result.steps[0]!.errorCode).toBe("tool_not_found");
  });

  it("caps retries at 5 even if spec says more", async () => {
    let callCount = 0;

    const spec: WorkflowSpec = {
      name: "retry-cap",
      description: "demo",
      steps: [
        {
          key: "capped",
          tool: "analyze_complexity",
          input: {},
          retries: 100,
          retryDelayMs: 1,
        },
      ],
    };

    const runner = new FakeRunner({
      analyze_complexity: async () => {
        callCount++;
        return fail("analyze_complexity", "execution_failed", "error");
      },
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      sleep: async () => {},
    });

    expect(result.status).toBe("failed");
    expect(callCount).toBe(6); // initial + 5 retries (capped)
    expect(result.steps[0]!.retryCount).toBe(5);
  });

  it("defaults to no retries (retries=0)", async () => {
    const spec: WorkflowSpec = {
      name: "no-retry",
      description: "demo",
      steps: [
        {
          key: "once",
          tool: "analyze_complexity",
          input: {},
        },
      ],
    };

    const runner = new FakeRunner({
      analyze_complexity: async () => fail("analyze_complexity", "execution_failed", "error"),
    });

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
    });

    expect(result.status).toBe("failed");
    expect(runner.calls).toHaveLength(1);
    expect(result.steps[0]!.retryCount).toBeUndefined();
  });

  it("falls back to broadcast when resolveReviewers is not provided", async () => {
    const spec: WorkflowSpec = {
      name: "dispatch-fallback",
      description: "demo",
      steps: [
        {
          key: "quorum",
          type: "quorum_checkpoint",
          tool: "quorum_checkpoint",
          input: {
            ticketId: "TKT-fallback",
            timeout: 5,
            pollIntervalMs: 10,
          },
        },
      ],
    };

    const runner = new FakeRunner({});
    const sent: Array<Record<string, unknown>> = [];
    let nowMs = 0;
    let pollCount = 0;

    const result = await runWorkflow(spec, {
      runner,
      actor: { agentId: "agent-dev", sessionId: "session-dev" },
      workflowName: spec.name,
      loadReviewVerdicts: async () => {
        pollCount += 1;
        return pollCount === 1
          ? []
          : [
              verdict("architect", "pass"),
              verdict("simplifier", "pass"),
              verdict("security", "pass"),
              verdict("performance", "pass"),
            ];
      },
      sendCoordination: async (request) => {
        sent.push(request as unknown as Record<string, unknown>);
      },
      // No resolveReviewers — should use broadcast fallback
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });

    expect(result.status).toBe("completed");
    // Single broadcast (no targetAgentId)
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toHaveProperty("targetAgentId");
  });
});
