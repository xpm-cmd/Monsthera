import { describe, expect, it } from "vitest";
import { runWorkflow } from "../../../src/workflows/engine.js";
import type { WorkflowSpec } from "../../../src/workflows/types.js";

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
});
