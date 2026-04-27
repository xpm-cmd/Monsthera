import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";
import type { MonstheraContainer } from "./core/container.js";
import { knowledgeToolDefinitions, handleKnowledgeTool } from "./tools/knowledge-tools.js";
import type { ToolDefinition, ToolResponse } from "./tools/knowledge-tools.js";
import { workToolDefinitions, handleWorkTool } from "./tools/work-tools.js";
import { searchToolDefinitions, handleSearchTool } from "./tools/search-tools.js";
import { WikiBookkeeper } from "./knowledge/wiki-bookkeeper.js";
import { orchestrationToolDefinitions, handleOrchestrationTool } from "./tools/orchestration-tools.js";
import { waveToolDefinitions, handleWaveTool } from "./tools/wave-tools.js";
import { agentToolDefinitions, handleAgentTool } from "./tools/agent-tools.js";
import { statusToolDefinitions, handleStatusTool } from "./tools/status-tools.js";
import { ingestToolDefinitions, handleIngestTool } from "./tools/ingest-tools.js";
import { structureToolDefinitions, handleStructureTool } from "./tools/structure-tools.js";
import { wikiToolDefinitions, handleWikiTool } from "./tools/wiki-tools.js";
import { snapshotToolDefinitions, handleSnapshotTool } from "./tools/snapshot-tools.js";
import { migrationToolDefinitions, handleMigrationTool } from "./migration/tools.js";
import { lintToolDefinitions, handleLintTool } from "./tools/lint-tools.js";
import { refsToolDefinitions, handleRefsTool } from "./tools/refs-tools.js";
import { eventsToolDefinitions, handleEventsTool } from "./tools/events-tools.js";
import { convoyToolDefinitions, handleConvoyTool } from "./tools/convoy-tools.js";
import {
  codeIntelligenceToolDefinitions,
  handleCodeIntelligenceTool,
} from "./tools/code-intelligence-tools.js";

/**
 * Per-group tool registry. Exposed for tests and for the dispatch function
 * below — startServer re-uses the same registry so ListTools and CallTool
 * always stay in sync.
 */
export interface ToolRegistry {
  readonly definitions: readonly ToolDefinition[];
  readonly names: {
    readonly knowledge: ReadonlySet<string>;
    readonly work: ReadonlySet<string>;
    readonly search: ReadonlySet<string>;
    readonly orchestration: ReadonlySet<string>;
    readonly wave: ReadonlySet<string>;
    readonly agent: ReadonlySet<string>;
    readonly status: ReadonlySet<string>;
    readonly ingest: ReadonlySet<string>;
    readonly structure: ReadonlySet<string>;
    readonly wiki: ReadonlySet<string>;
    readonly snapshot: ReadonlySet<string>;
    readonly migration: ReadonlySet<string>;
    readonly lint: ReadonlySet<string>;
    readonly refs: ReadonlySet<string>;
    readonly events: ReadonlySet<string>;
    readonly convoy: ReadonlySet<string>;
    readonly codeIntelligence: ReadonlySet<string>;
  };
}

/**
 * Build the full MCP tool registry from a container. Migration tools are
 * only included when the container wires a migration service (v2 import
 * flows).
 */
export function buildToolRegistry(container: MonstheraContainer): ToolRegistry {
  const knowledgeTools = knowledgeToolDefinitions();
  const workTools = workToolDefinitions();
  const searchTools = searchToolDefinitions();
  const orchestrationTools = orchestrationToolDefinitions();
  const waveTools = waveToolDefinitions();
  const agentTools = agentToolDefinitions();
  const statusTools = statusToolDefinitions();
  const ingestTools = ingestToolDefinitions();
  const structureTools = structureToolDefinitions();
  const wikiTools = wikiToolDefinitions();
  const snapshotTools = snapshotToolDefinitions();
  const migrationTools = container.migrationService ? migrationToolDefinitions() : [];
  const lintTools = lintToolDefinitions();
  const refsTools = refsToolDefinitions();
  const eventsTools = eventsToolDefinitions();
  const convoyTools = convoyToolDefinitions();
  const codeIntelligenceTools = codeIntelligenceToolDefinitions();

  return {
    definitions: [
      ...knowledgeTools,
      ...workTools,
      ...searchTools,
      ...orchestrationTools,
      ...waveTools,
      ...agentTools,
      ...statusTools,
      ...ingestTools,
      ...structureTools,
      ...wikiTools,
      ...snapshotTools,
      ...migrationTools,
      ...lintTools,
      ...refsTools,
      ...eventsTools,
      ...convoyTools,
      ...codeIntelligenceTools,
    ],
    names: {
      knowledge: new Set(knowledgeTools.map((t) => t.name)),
      work: new Set(workTools.map((t) => t.name)),
      search: new Set(searchTools.map((t) => t.name)),
      orchestration: new Set(orchestrationTools.map((t) => t.name)),
      wave: new Set(waveTools.map((t) => t.name)),
      agent: new Set(agentTools.map((t) => t.name)),
      status: new Set(statusTools.map((t) => t.name)),
      ingest: new Set(ingestTools.map((t) => t.name)),
      structure: new Set(structureTools.map((t) => t.name)),
      wiki: new Set(wikiTools.map((t) => t.name)),
      snapshot: new Set(snapshotTools.map((t) => t.name)),
      migration: new Set(migrationTools.map((t) => t.name)),
      lint: new Set(lintTools.map((t) => t.name)),
      refs: new Set(refsTools.map((t) => t.name)),
      events: new Set(eventsTools.map((t) => t.name)),
      convoy: new Set(convoyTools.map((t) => t.name)),
      codeIntelligence: new Set(codeIntelligenceTools.map((t) => t.name)),
    },
  };
}

/**
 * Dispatch a tools/call by name to the appropriate handler. Pure w.r.t. the
 * MCP transport — safe to call directly from tests without spinning up stdio.
 * Unknown names return an error ToolResponse (not a thrown exception) so the
 * MCP client sees a structured failure.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
  container: MonstheraContainer,
  registry: ToolRegistry = buildToolRegistry(container),
): Promise<ToolResponse> {
  const { names } = registry;

  if (names.knowledge.has(name)) {
    return handleKnowledgeTool(name, args, container.knowledgeService, container.structureService);
  }
  if (names.work.has(name)) {
    return handleWorkTool(name, args, container.workService, container.structureService);
  }
  if (names.search.has(name)) {
    const result = await handleSearchTool(name, args, container.searchService, {
      knowledgeRepo: container.knowledgeRepo,
      workRepo: container.workRepo,
      snapshotService: container.snapshotService,
    });
    // Rebuild wiki index after a full reindex so index.md stays in sync.
    if (name === "reindex_all" && result.content[0]?.type === "text" && !result.isError) {
      const markdownRoot = path.resolve(
        container.config.repoPath,
        container.config.storage.markdownRoot,
      );
      const bookkeeper = new WikiBookkeeper(markdownRoot, container.logger);
      const knowledgeAll = await container.knowledgeRepo.findMany();
      const workAll = await container.workRepo.findMany();
      if (knowledgeAll.ok && workAll.ok) {
        await bookkeeper.rebuildIndex(knowledgeAll.value, workAll.value);
      }
    }
    return result;
  }
  if (names.orchestration.has(name)) {
    return handleOrchestrationTool(name, args, container.orchestrationRepo);
  }
  if (names.wave.has(name)) {
    return handleWaveTool(name, args, container.orchestrationService, container.workService);
  }
  if (names.agent.has(name)) {
    return handleAgentTool(name, args, {
      agentsService: container.agentsService,
      workService: container.workService,
      knowledgeService: container.knowledgeService,
      orchestrationService: container.orchestrationService,
      status: container.status,
      autoAdvanceEnabled: container.config.orchestration.autoAdvance,
    });
  }
  if (names.status.has(name)) {
    return handleStatusTool(name, args, container.status);
  }
  if (names.ingest.has(name)) {
    return handleIngestTool(name, args, container.ingestService);
  }
  if (names.structure.has(name)) {
    return handleStructureTool(name, args, container.structureService);
  }
  if (names.wiki.has(name)) {
    return handleWikiTool(name, args, container.bookkeeper);
  }
  if (names.snapshot.has(name)) {
    return handleSnapshotTool(name, args, container.snapshotService);
  }
  if (names.migration.has(name) && container.migrationService) {
    return handleMigrationTool(name, args, container.migrationService);
  }
  if (names.lint.has(name)) {
    return handleLintTool(name, args, container);
  }
  if (names.refs.has(name)) {
    return handleRefsTool(name, args, container.structureService);
  }
  if (names.events.has(name)) {
    return handleEventsTool(name, args, {
      eventRepo: container.orchestrationRepo,
      workRepo: container.workRepo,
      resyncMonitor: container.resyncMonitor,
    });
  }
  if (names.convoy.has(name)) {
    return handleConvoyTool(name, args, { convoyRepo: container.convoyRepo });
  }
  if (names.codeIntelligence.has(name)) {
    return handleCodeIntelligenceTool(name, args, container.codeIntelligenceService);
  }

  return {
    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
    isError: true,
  };
}

/**
 * Start the MCP server with a Monsthera container.
 */
export async function startServer(container: MonstheraContainer): Promise<void> {
  const server = new Server(
    { name: "monsthera", version: "3.0.0-alpha.4" },
    { capabilities: { tools: {} } },
  );

  const registry = buildToolRegistry(container);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.definitions],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    return dispatchToolCall(name, args, container, registry);
  });

  const transport = new StdioServerTransport();

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
