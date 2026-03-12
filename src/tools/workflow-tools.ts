import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { AgoraContext } from "../core/context.js";
import { AgentIdSchema, SessionIdSchema } from "../core/input-hardening.js";
import { resolveAgent } from "./resolve-agent.js";
import { getToolRunner } from "./tool-runner.js";
import { BUILTIN_WORKFLOW_NAMES, getBuiltInWorkflow } from "../workflows/builtins.js";
import { runWorkflow } from "../workflows/engine.js";

type GetContext = () => Promise<AgoraContext>;

const WorkflowParamsSchema = z.record(z.string(), z.unknown()).default({});

export function registerWorkflowTools(server: McpServer, getContext: GetContext): void {
  server.tool(
    "run_workflow",
    "Execute a built-in sequential workflow by name with static parameter mapping and per-step trust enforcement.",
    {
      name: z.enum(BUILTIN_WORKFLOW_NAMES).describe("Built-in workflow name"),
      params: WorkflowParamsSchema.describe("Workflow parameters"),
      agentId: AgentIdSchema.describe("Agent ID"),
      sessionId: SessionIdSchema.describe("Active session ID"),
    },
    async ({ name, params, agentId, sessionId }) => {
      const c = await getContext();
      const actor = resolveAgent(c, agentId, sessionId);
      if (!actor.ok) {
        return {
          content: [{ type: "text" as const, text: actor.error }],
          isError: true,
        };
      }

      const result = await runWorkflow(
        getBuiltInWorkflow(name),
        {
          runner: getToolRunner(server),
          actor: { agentId, sessionId },
        },
        params,
      );

      c.insight.info(`Workflow ${name} finished with status ${result.status}`);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        }],
        ...(result.status === "failed" ? { isError: true } : {}),
      };
    },
  );
}
