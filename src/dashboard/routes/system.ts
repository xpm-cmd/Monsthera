import type { RouteContext } from "./context.js";
import { jsonResponse } from "../http.js";
import { deriveAgentExperience } from "../agent-experience.js";

// System routes: health, status, and the runtime overview.
// Route bodies are moved verbatim from the original src/dashboard/index.ts router.
export async function handleSystemRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, pathname, container } = ctx;

  // ── GET /api/health ──────────────────────────────────────────────────────
  if (pathname === "/api/health" && req.method === "GET") {
    const status = container.status.getStatus();
    const allHealthy = status.subsystems.every((s) => s.healthy);
    jsonResponse(res, allHealthy ? 200 : 503, {
      healthy: allHealthy,
      version: status.version,
      uptime: status.uptime,
      subsystems: status.subsystems,
    });
    return true;
  }

  // ── GET /api/status ──────────────────────────────────────────────────────
  if (pathname === "/api/status" && req.method === "GET") {
    const status = await container.status.getStatusAsync();
    jsonResponse(res, 200, status);
    return true;
  }

  // ── GET /api/system/runtime ──────────────────────────────────────────────
  if (pathname === "/api/system/runtime" && req.method === "GET") {
    const status = await container.status.getStatusAsync();
    const [
      recentEventsResult,
      workResult,
      knowledgeResult,
      directoryResult,
      waveResult,
    ] = await Promise.all([
      container.orchestrationRepo.findRecent(20),
      container.workService.listWork(),
      container.knowledgeService.listArticles(),
      container.agentsService.listAgents(),
      container.orchestrationService.planWave(),
    ]);
    const recentEvents = recentEventsResult.ok ? recentEventsResult.value : [];
    const storageSubsystem = status.subsystems.find((subsystem) => subsystem.name === "storage");
    const doltHealthSubsystem = status.subsystems.find((subsystem) => subsystem.name === "dolt-health");
    const agentExperience =
      workResult.ok && knowledgeResult.ok && directoryResult.ok && waveResult.ok
        ? deriveAgentExperience({
          workArticles: workResult.value,
          knowledgeCount: knowledgeResult.value.length,
          agentSummary: directoryResult.value.summary,
          status,
          autoAdvanceEnabled: container.config.orchestration.autoAdvance,
          waveSummary: {
            readyCount: waveResult.value.items.length,
            blockedCount: waveResult.value.blockedItems.length,
          },
        })
        : null;

    jsonResponse(res, 200, {
      storage: {
        mode: container.config.storage.doltEnabled ? "markdown+dolt" : "markdown-only",
        markdownRoot: container.config.storage.markdownRoot,
        doltEnabled: container.config.storage.doltEnabled,
        doltHost: container.config.storage.doltHost,
        doltPort: container.config.storage.doltPort,
        doltDatabase: container.config.storage.doltDatabase,
        detail: storageSubsystem?.detail,
        healthy: storageSubsystem?.healthy ?? true,
      },
      search: {
        semanticEnabled: container.config.search.semanticEnabled,
        embeddingProvider: container.config.search.embeddingProvider,
        embeddingModel: container.config.search.embeddingModel,
        alpha: container.config.search.alpha,
        ollamaUrl: container.config.search.ollamaUrl,
      },
      orchestration: {
        autoAdvance: container.config.orchestration.autoAdvance,
        pollIntervalMs: container.config.orchestration.pollIntervalMs,
        maxConcurrentAgents: container.config.orchestration.maxConcurrentAgents,
        running: container.orchestrationService.isRunning,
      },
      server: {
        host: container.config.server.host,
        port: container.config.server.port,
      },
      capabilities: {
        knowledgeCrud: true,
        workCrud: true,
        phaseAdvance: true,
        reviewWorkflow: true,
        agentDirectory: true,
        knowledgeIngest: true,
        searchReindex: true,
        searchAutoSync: true,
        contextPacks: true,
        wavePlanning: true,
        waveExecution: true,
        dashboardApi: true,
        mcpServer: true,
        migrationAvailable: Boolean(container.migrationService),
      },
      integrations: [
        {
          id: "markdown",
          name: "Markdown repository",
          configured: true,
          healthy: true,
          detail: `Source of truth at ${container.config.storage.markdownRoot}`,
        },
        {
          id: "dolt",
          name: "Dolt",
          configured: container.config.storage.doltEnabled,
          healthy: doltHealthSubsystem?.healthy ?? storageSubsystem?.healthy ?? !container.config.storage.doltEnabled,
          detail: container.config.storage.doltEnabled
            ? (doltHealthSubsystem?.detail ?? `Configured at ${container.config.storage.doltHost}:${container.config.storage.doltPort}`)
            : "Disabled",
        },
        {
          id: "ollama",
          name: "Ollama",
          configured: container.config.search.embeddingProvider === "ollama",
          healthy: container.config.search.embeddingProvider === "ollama" ? true : false,
          detail: container.config.search.embeddingProvider === "ollama"
            ? `${container.config.search.embeddingModel} via ${container.config.search.ollamaUrl}`
            : "Not in use",
        },
        {
          id: "local-ingest",
          name: "Local source ingest",
          configured: true,
          healthy: true,
          detail: "Import .md/.txt sources from the local workspace into knowledge articles",
        },
        {
          id: "search-auto-sync",
          name: "Search auto-sync",
          configured: true,
          healthy: true,
          detail: "Normal knowledge/work create, update, delete flows sync search automatically; full reindex is only needed for backfills or recovery.",
        },
        {
          id: "mcp",
          name: "MCP stdio server",
          configured: true,
          healthy: true,
          detail: "Available through `monsthera serve`",
        },
      ],
      security: {
        localFirst: true,
        markdownSourceOfTruth: true,
        reviewGateEnforced: true,
        semanticSearchEnabled: container.config.search.semanticEnabled,
        autoAdvanceEnabled: container.config.orchestration.autoAdvance,
        externalEndpoints: [
          container.config.storage.doltEnabled ? `${container.config.storage.doltHost}:${container.config.storage.doltPort}` : null,
          container.config.search.embeddingProvider === "ollama" ? container.config.search.ollamaUrl : null,
        ].filter(Boolean),
      },
      stats: status.stats ?? {},
      agentExperience,
      recentEvents,
    });
    return true;
  }

  return false;
}
