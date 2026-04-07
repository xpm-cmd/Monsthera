import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { MonstheraContainer } from "./core/container.js";
import { knowledgeToolDefinitions, handleKnowledgeTool } from "./tools/knowledge-tools.js";
import { workToolDefinitions, handleWorkTool } from "./tools/work-tools.js";

/**
 * Start the MCP server with a Monsthera container.
 * Registers a `status` tool that returns the current system status as JSON.
 */
export async function startServer(container: MonstheraContainer): Promise<void> {
  const server = new Server(
    {
      name: "monsthera",
      version: "3.0.0-alpha.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  const knowledgeTools = knowledgeToolDefinitions();
  const knowledgeToolNames = new Set(knowledgeTools.map((t) => t.name));

  const workTools = workToolDefinitions();
  const workToolNames = new Set(workTools.map((t) => t.name));

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "status",
          description:
            "Returns the current system status, including version, uptime, and subsystem health.",
          inputSchema: {
            type: "object" as const,
            properties: {},
            required: [],
          },
        },
        ...knowledgeTools,
        ...workTools,
      ],
    };
  });

  // Register tools/call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name === "status") {
      const systemStatus = container.status.getStatus();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(systemStatus, null, 2),
          },
        ],
      };
    }

    if (knowledgeToolNames.has(name)) {
      return handleKnowledgeTool(name, args, container.knowledgeService);
    }

    if (workToolNames.has(name)) {
      return handleWorkTool(name, args, container.workService);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Unknown tool: ${name}`,
        },
      ],
      isError: true,
    };
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();

  // Handle clean shutdown
  const shutdown = async () => {
    container.logger.info("Received shutdown signal, disposing container");
    await container.dispose();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  container.logger.info("Starting MCP server via stdio");
  await server.connect(transport);
}
